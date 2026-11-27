import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  shell,
} from 'electron';

import { restoreCleanupSources } from './cleanup.mjs';
import { buildClipPlan, buildOutputTimeline } from './clip-plan.mjs';
import {
  audioPeaks,
  audioTypes,
  checkFlowBlur,
  ensureSpace,
  fileIdentity,
  outputSize,
  probe,
  probeAudio,
  readJson,
  renderVolume,
  resolutions,
  reusableProbeMetadata,
  sameFileIdentity,
  videoExtensions,
  writeJson,
} from './media.mjs';

const ui = new URL(
  (!app.isPackaged && process.env.KILL_CLIP_DEV_URL) || 'workbench://app/',
);
if (
  ui.protocol !== 'workbench:' &&
  (ui.protocol !== 'http:' || ui.hostname !== '127.0.0.1')
) {
  throw new Error('KILL_CLIP_DEV_URL must use HTTP on 127.0.0.1');
}
const dist = app.isPackaged
  ? path.join(process.resourcesPath, 'web') + path.sep
  : fileURLToPath(new URL('../../web-antd/dist/', import.meta.url));
const defaults = {
  preRollSeconds: 5,
  postRollSeconds: 5,
  mergeGapSeconds: 8,
  maxVolumeHours: 1,
  motionBlur: false,
  resolution: 'source',
  fitMode: 'pad',
};
const channels = 'workbench:';
const defaultMix = { sourceVolume: 1, musicVolume: 0.25, musicStart: 0 };
let window;
let project;
let projectFile;
let saveState = { status: 'unsaved' };
let job;
let lastExport;
let receipt;
let tail = Promise.resolve();
let quitting = false;
const waveformJobs = new Map();
const media = new Map();

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'workbench',
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
  {
    scheme: 'clip-media',
    privileges: { standard: true, secure: true, stream: true },
  },
]);

function newProject(name = '未命名项目') {
  const date = new Date().toISOString();
  return {
    version: 1,
    name,
    createdAt: date,
    updatedAt: date,
    videos: [],
    settings: { ...defaults },
    mix: { ...defaultMix },
    music: null,
    outputDirectory: '',
    result: null,
  };
}

function registerMedia(file) {
  const id = randomUUID();
  media.set(id, file);
  return `clip-media://local/${id}`;
}

function localPath(file) {
  return (
    typeof file === 'string' &&
    path.isAbsolute(file) &&
    (process.platform !== 'win32' || /^[a-z]:[\\/]/i.test(file))
  );
}

function localVideo(file) {
  return (
    localPath(file) && videoExtensions.has(path.extname(file).toLowerCase())
  );
}

function localAudio(file) {
  return (
    localPath(file) &&
    Object.hasOwn(audioTypes, path.extname(file).toLowerCase())
  );
}

async function describeMusic(file) {
  if (!localAudio(file)) throw new Error('请选择本机支持的音频文件');
  const resolved = await realpath(file);
  if (!localAudio(resolved)) throw new Error('音频指向不受支持的位置');
  const metadata = await probeAudio(resolved);
  return {
    ...metadata,
    id: randomUUID(),
    name: path.basename(resolved),
    path: resolved,
    url: registerMedia(resolved),
    error: '',
  };
}

function validatedMix(raw) {
  const mix = {};
  for (const [key, fallback] of Object.entries(defaultMix)) {
    const value = raw?.[key] ?? fallback;
    if (
      !Number.isFinite(value) ||
      value < 0 ||
      value > (key === 'musicStart' ? Number.MAX_SAFE_INTEGER / 1000 : 1)
    )
      throw new Error('音轨设置超出有效范围');
    mix[key] = value;
  }
  return mix;
}

async function describeVideo(
  file,
  marks = [],
  id = randomUUID(),
  cachedMetadata,
) {
  if (!localVideo(file)) throw new Error('请选择本机支持的视频文件');
  const entry = {
    id,
    path: file,
    name: path.basename(file),
    marks,
    duration: 0,
    width: 0,
    height: 0,
    fps: 0,
    hasAudio: false,
    url: '',
    error: '',
  };
  try {
    const resolved = await realpath(file);
    if (!localVideo(resolved)) throw new Error('视频指向不受支持的位置');
    const identity = await fileIdentity(resolved);
    const metadata =
      reusableProbeMetadata(cachedMetadata, identity) ??
      (await probe(resolved));
    return {
      ...entry,
      ...metadata,
      path: resolved,
      url: registerMedia(resolved),
    };
  } catch (error) {
    return {
      ...entry,
      error:
        error.code === 'ENOENT'
          ? '文件不存在，请重新定位'
          : String(error.message).slice(-2000),
    };
  }
}

function validatedSettings(raw) {
  const settings = { ...defaults, ...raw };
  for (const [key, minimum, maximum] of [
    ['preRollSeconds', 0, 3600],
    ['postRollSeconds', 0, 3600],
    ['mergeGapSeconds', 0, 3600],
    ['maxVolumeHours', 0.001, 24],
  ]) {
    if (
      !Number.isFinite(settings[key]) ||
      settings[key] < minimum ||
      settings[key] > maximum
    )
      throw new Error('剪辑设置超出有效范围');
  }
  if (
    settings.resolution !== 'source' &&
    !Object.hasOwn(resolutions, settings.resolution)
  )
    throw new Error('输出规格无效');
  if (typeof settings.motionBlur !== 'boolean')
    throw new Error('运动模糊设置无效');
  if (!['crop', 'pad', 'stretch'].includes(settings.fitMode))
    throw new Error('画面适配设置无效');
  return Object.fromEntries(
    Object.keys(defaults).map((key) => [key, settings[key]]),
  );
}

function validatedMarks(raw) {
  if (
    !Array.isArray(raw) ||
    raw.length > 100_000 ||
    raw.some(
      (value) =>
        typeof value !== 'number' || !Number.isFinite(value) || value < 0,
    )
  ) {
    throw new Error('击杀标记无效');
  }
  return [...new Set(raw)].toSorted((a, b) => a - b);
}

function projectData() {
  const plan = buildClipPlan(project.videos, project.settings);
  const { url: _url, ...music } = project.music ?? {};
  return {
    ...project,
    plan,
    videos: project.videos.map(({ url: _url, ...video }) => video),
    music: project.music ? music : null,
    cleanupSources:
      receipt?.sources.map(({ id, path, identity }) => ({
        id,
        path,
        identity,
      })) ?? null,
  };
}

function serialize(operation) {
  const next = tail.then(operation);
  tail = next.catch(() => {});
  return next;
}

function recoveryFile() {
  return path.join(app.getPath('userData'), 'current-project.json');
}

function setSaveState(status, detail) {
  saveState = { status, detail };
  if (window && !window.isDestroyed())
    window.webContents.send(`${channels}save-state`, saveState);
}

async function persist() {
  setSaveState('saving');
  try {
    project.updatedAt = new Date().toISOString();
    const data = projectData();
    await writeJson(recoveryFile(), { projectFile, data });
    if (projectFile) await writeJson(projectFile, data);
    setSaveState('saved');
  } catch (error) {
    setSaveState('save-failed', error.message);
    throw error;
  }
}

async function restoreProject() {
  let stored;
  try {
    stored = await readJson(recoveryFile());
  } catch (error) {
    if (error.code === 'ENOENT') return;
    setSaveState('restore-failed', error.message);
    return;
  }
  try {
    await hydrate(stored.data, stored.projectFile);
  } catch (error) {
    setSaveState('restore-failed', error.message);
    return;
  }
  if (projectFile) {
    try {
      const saved = await readJson(projectFile);
      if (
        saved.createdAt !== stored.data.createdAt ||
        saved.updatedAt !== stored.data.updatedAt
      )
        throw new Error('项目文件与自动恢复副本不同步');
    } catch (error) {
      setSaveState('save-failed', error.message);
      return;
    }
  }
  setSaveState('saved');
}

async function hydrate(data, file) {
  if (
    data?.version !== 1 ||
    typeof data.name !== 'string' ||
    !Array.isArray(data.videos) ||
    data.videos.length > 5000
  ) {
    throw new Error('无法打开此工作台项目');
  }
  const settings = validatedSettings(data.settings);
  const mix = validatedMix(data.mix);
  const videos = [];
  for (const video of data.videos) {
    if (video.error === '已移入回收站') continue;
    videos.push(
      await describeVideo(
        video.path,
        validatedMarks(video.marks),
        typeof video.id === 'string' ? video.id : randomUUID(),
        video,
      ),
    );
  }
  const restored = {
    ...newProject(data.name),
    settings,
    mix,
    videos,
    createdAt: data.createdAt ?? new Date().toISOString(),
    outputDirectory:
      typeof data.outputDirectory === 'string' ? data.outputDirectory : '',
    result: null,
  };
  if (data.music && localAudio(data.music.path)) {
    const file = data.music.path;
    try {
      restored.music = await describeMusic(file);
    } catch (error) {
      restored.music = {
        id: randomUUID(),
        path: file,
        name: path.basename(file),
        duration: 0,
        url: '',
        error:
          error.code === 'ENOENT'
            ? '配乐文件不存在，请重新选择'
            : error.message,
      };
    }
  }
  const savedResult = data.result;
  if (
    savedResult &&
    Array.isArray(savedResult.volumes) &&
    typeof savedResult.folder === 'string' &&
    path.isAbsolute(savedResult.folder)
  ) {
    const volumes = [];
    for (const saved of savedResult.volumes) {
      if (saved.status !== 'success') {
        const interrupted =
          saved.status === 'running' || saved.status === 'waiting';
        volumes.push(
          interrupted
            ? { ...saved, status: 'cancelled', detail: '导出已中断' }
            : saved,
        );
        continue;
      }
      if (!/^kills-\d+\.mp4$/.test(saved.name ?? '')) {
        volumes.push({
          ...saved,
          status: 'failed',
          detail: '成片名称无效',
          url: '',
        });
        continue;
      }
      const output = path.join(savedResult.folder, saved.name);
      if (
        !sameFileIdentity(
          saved.identity,
          await fileIdentity(output).catch(() => ''),
        )
      ) {
        volumes.push({
          ...saved,
          status: 'failed',
          detail: '成片已移动或发生变化',
          url: '',
        });
        continue;
      }
      volumes.push({ ...saved, path: output, url: registerMedia(output) });
    }
    restored.result = {
      ...savedResult,
      report: path.join(savedResult.folder, 'export-report.json'),
      volumes,
    };
  }
  const sources = await restoreCleanupSources(
    restored.result,
    data.cleanupSources,
    data.videos,
    videos,
    settings,
  );
  project = restored;
  projectFile = file;
  receipt =
    sources.length > 0
      ? {
          sources,
          outputs: restored.result.volumes,
          report: restored.result.report,
        }
      : undefined;
}

function samePath(a, b) {
  return process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

async function importVideos(paths) {
  const files = paths.filter((item) => localVideo(item));
  if (files.length === 0) return project;
  const previousCount = project.videos.length;
  let completed = 0;
  let lastProgressAt = Date.now();
  if (files.length > 0) {
    sendImportProgress({
      completed,
      total: files.length,
      current: path.basename(files[0]),
    });
  }
  for (const file of files) {
    const video = await describeVideo(file);
    if (!project.videos.some((entry) => samePath(entry.path, video.path)))
      project.videos.push(video);
    completed += 1;
    const now = Date.now();
    if (
      completed === files.length ||
      completed % 10 === 0 ||
      now - lastProgressAt >= 1000
    ) {
      sendImportProgress({
        completed,
        total: files.length,
        current:
          completed < files.length ? path.basename(files[completed]) : '',
      });
      lastProgressAt = now;
    }
  }
  if (project.videos.length !== previousCount) await persist();
  return project;
}

const videoFilters = [
  {
    name: '游戏录屏',
    extensions: [...videoExtensions].map((extension) => extension.slice(1)),
  },
];
const audioFilters = [
  {
    name: '背景音乐',
    extensions: Object.keys(audioTypes).map((extension) => extension.slice(1)),
  },
];

async function chooseFolder() {
  const answer = await dialog.showOpenDialog(window, {
    properties: ['openDirectory', 'createDirectory'],
  });
  return answer.filePaths[0];
}

function sendJob(state) {
  if (window && !window.isDestroyed())
    window.webContents.send(`${channels}progress`, state);
}

function sendImportProgress(state) {
  if (window && !window.isDestroyed())
    window.webContents.send(`${channels}import-progress`, state);
}

async function exportProject() {
  const snapshot = structuredClone(project);
  const plan = buildClipPlan(snapshot.videos, snapshot.settings);
  if (
    plan.volumes.length === 0 ||
    plan.issues.some(({ severity }) => severity === 'error')
  )
    throw new Error('请先修正剪辑计划');
  if (!project.outputDirectory) throw new Error('请先选择输出目录');
  if (snapshot.music && snapshot.mix.musicVolume > 0) {
    if (snapshot.music.error) throw new Error(snapshot.music.error);
    if (
      !sameFileIdentity(
        snapshot.music.identity,
        await fileIdentity(snapshot.music.path).catch(() => null),
      )
    )
      throw new Error('配乐已移动或发生变化，请重新选择');
  }
  if (snapshot.settings.motionBlur) await checkFlowBlur();
  const limit = snapshot.settings.maxVolumeHours * 3600;
  const { volumeStarts } = buildOutputTimeline(plan.volumes, limit);
  const folderRoot = await realpath(snapshot.outputDirectory);
  const outputSizes = plan.volumes.map((volume) =>
    outputSize(snapshot.settings.resolution, volume, snapshot.videos),
  );
  let maxOutputSize = outputSizes[0];
  for (const size of outputSizes.slice(1)) {
    if (size[0] * size[1] > maxOutputSize[0] * maxOutputSize[1])
      maxOutputSize = size;
  }
  await ensureSpace(
    folderRoot,
    plan.totalSeconds,
    Math.max(...plan.volumes.map(({ duration }) => duration)),
    maxOutputSize,
  );
  const folder = await mkdtemp(
    path.join(folderRoot, `kills-${new Date().toISOString().slice(0, 10)}-`),
  );
  const controller = new AbortController();
  const result = {
    folder,
    report: path.join(folder, 'export-report.json'),
    volumes: plan.volumes.map(({ number, duration }, index) => ({
      number,
      duration,
      status: 'waiting',
      percent: 0,
      detail: '',
      width: outputSizes[index][0],
      height: outputSizes[index][1],
    })),
  };
  project.result = result;
  receipt = undefined;
  job = { controller, done: null };
  job.done = (async () => {
    const sources = snapshot.videos.filter(({ id }) =>
      plan.clips.some(({ videoId }) => id === videoId),
    );
    for (const [index, volume] of plan.volumes.entries()) {
      const state = result.volumes[index];
      if (controller.signal.aborted) {
        state.status = 'cancelled';
        state.detail = '已取消';
        continue;
      }
      state.status = 'running';
      sendJob(result);
      try {
        for (const source of sources.filter(({ id }) =>
          volume.clips.some(({ videoId }) => id === videoId),
        )) {
          if (
            !sameFileIdentity(source.identity, await fileIdentity(source.path))
          )
            throw new Error(`${source.name} 已改变，请重新导入`);
        }
        const output = await renderVolume(
          volume,
          folder,
          outputSizes[index],
          limit,
          controller.signal,
          (percent, detail) => {
            Object.assign(state, { percent, detail });
            sendJob(result);
          },
          {
            motionBlur: snapshot.settings.motionBlur,
            fitMode: snapshot.settings.fitMode,
            sourceVolume: snapshot.mix.sourceVolume,
            musicVolume: snapshot.mix.musicVolume,
            music: snapshot.music && {
              ...snapshot.music,
              start: snapshot.mix.musicStart,
            },
            volumeStart: volumeStarts[index],
          },
        );
        Object.assign(state, output, {
          status: 'success',
          width: outputSizes[index][0],
          height: outputSizes[index][1],
          percent: 100,
          detail: '校验通过',
          url: registerMedia(output.path),
        });
      } catch (error) {
        state.status = controller.signal.aborted ? 'cancelled' : 'failed';
        state.detail = controller.signal.aborted ? '已取消' : error.message;
      }
      sendJob(result);
    }
    await writeJson(result.report, {
      ...result,
      plan,
      settings: snapshot.settings,
      mix: snapshot.mix,
      music: snapshot.music && {
        path: snapshot.music.path,
        name: snapshot.music.name,
      },
    });
    if (
      !controller.signal.aborted &&
      result.volumes.every(({ status }) => status === 'success')
    ) {
      receipt = {
        sources,
        outputs: structuredClone(result.volumes),
        report: result.report,
      };
    }
    await persist();
    return result;
  })().finally(() => {
    job = undefined;
  });
  lastExport = job.done;
  void lastExport.catch(() => {});
  return { result };
}

async function recycleSources() {
  if (!receipt || receipt.sources.length === 0)
    throw new Error('当前没有可清理的已校验源素材');
  const selected = receipt;
  const answer = await dialog.showMessageBox(window, {
    type: 'warning',
    title: '确认回收源素材',
    message: `将 ${selected.sources.length} 个源视频移入回收站？`,
    detail: selected.sources.map(({ path: file }) => file).join('\n'),
    buttons: ['取消', '移入回收站'],
    defaultId: 0,
    cancelId: 0,
  });
  if (answer.response !== 1) return { project, recycled: [], errors: [] };
  await stat(selected.report);
  for (const output of selected.outputs) {
    if (
      !sameFileIdentity(
        output.identity,
        await fileIdentity(output.path).catch(() => null),
      )
    )
      throw new Error('已验证的成片发生变化，清理已停止');
  }
  const recycled = [];
  const recycledIds = new Set();
  const errors = [];
  for (const source of selected.sources) {
    try {
      if (!sameFileIdentity(source.identity, await fileIdentity(source.path)))
        throw new Error('文件已改变');
      await shell.trashItem(source.path);
      recycled.push(source.path);
      recycledIds.add(source.id);
    } catch (error) {
      errors.push(`${source.name}：${error.message}`);
    }
  }
  project.videos = project.videos.filter(({ id, url }) => {
    if (!recycledIds.has(id)) return true;
    if (url) media.delete(new URL(url).pathname.slice(1));
    return false;
  });
  receipt =
    errors.length > 0
      ? {
          ...selected,
          sources: selected.sources.filter(({ id }) => !recycledIds.has(id)),
        }
      : undefined;
  try {
    await persist();
  } catch (error) {
    errors.push(`清理结果保存失败：${error.message}`);
  }
  return { project, recycled, errors };
}

function handle(name, handler, { mutable = false, direct = false } = {}) {
  ipcMain.handle(`${channels}${name}`, (event, ...args) => {
    const frame = event.senderFrame;
    if (
      event.sender !== window?.webContents ||
      frame?.parent ||
      !frame?.url.startsWith(ui.href)
    )
      throw new Error('无效的工作台请求');
    const operation = () => {
      if (mutable && job) throw new Error('请等待当前导出结束');
      return handler(...args);
    };
    return direct ? operation() : serialize(operation);
  });
}

async function serveMedia(request) {
  const url = new URL(request.url);
  const file = url.host === 'local' && media.get(url.pathname.slice(1));
  if (!file) return new Response(null, { status: 404 });
  const info = await stat(file).catch(() => null);
  if (!info?.isFile() || info.size === 0)
    return new Response(null, { status: 404 });
  const extension = path.extname(file).toLowerCase();
  const contentType =
    audioTypes[extension] ??
    {
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.webm': 'video/webm',
      '.mkv': 'video/x-matroska',
    }[extension] ??
    'application/octet-stream';
  const headers = { 'Accept-Ranges': 'bytes', 'Content-Type': contentType };
  const range = request.headers.get('range');
  const match = range && /^bytes=(\d+)-(\d*)$/.exec(range);
  const start = match ? Number(match[1]) : 0;
  const end = match?.[2]
    ? Math.min(Number(match[2]), info.size - 1)
    : info.size - 1;
  if ((range && !match) || start > end)
    return new Response(null, {
      status: 416,
      headers: { ...headers, 'Content-Range': `bytes */${info.size}` },
    });
  headers['Content-Length'] = String(end - start + 1);
  if (match) headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
  const stream =
    request.method === 'HEAD'
      ? null
      : Readable.toWeb(createReadStream(file, { start, end }));
  return new Response(stream, { status: match ? 206 : 200, headers });
}

async function createWindow() {
  window = new BrowserWindow({
    width: 1440,
    height: 950,
    minWidth: 780,
    minHeight: 620,
    title: '击杀点剪辑工作台',
    autoHideMenuBar: true,
    webPreferences: {
      preload: fileURLToPath(new URL('preload.cjs', import.meta.url)),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith(ui.href)) event.preventDefault();
  });
  await window.loadURL(new URL('/workbench', ui).href);
}

async function start() {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  await app.whenReady();
  await mkdir(app.getPath('userData'), { recursive: true });
  project = newProject();
  await restoreProject();
  protocol.handle('clip-media', serveMedia);
  protocol.handle('workbench', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'app') return new Response(null, { status: 404 });
    const pathname = decodeURIComponent(url.pathname);
    const isPage = pathname === '/' || pathname === '/workbench';
    const file = path.resolve(dist, `.${isPage ? '/index.html' : pathname}`);
    if (!file.startsWith(dist)) return new Response(null, { status: 404 });
    const response = await net.fetch(pathToFileURL(file).href);
    if (!isPage && pathname !== '/index.html') return response;
    const headers = new Headers(response.headers);
    headers.set(
      'Content-Security-Policy',
      [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        'media-src clip-media:',
        "connect-src 'self'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "form-action 'none'",
      ].join('; '),
    );
    return new Response(response.body, { status: response.status, headers });
  });
  const projectState = () => ({
    project,
    projectFile,
    saveState,
    cleanup: receipt?.sources ?? [],
  });
  handle('project', projectState);
  handle(
    'waveform',
    async (id, url) => {
      const kind =
        project.music?.id === id && project.music.url === url
          ? 'music'
          : 'source';
      const entry =
        kind === 'music'
          ? project.music
          : project.videos.find(
              (video) => video.id === id && video.url === url && video.hasAudio,
            );
      if (!entry?.url || entry.error) return null;
      waveformJobs.get(kind)?.controller.abort();
      const controller = new AbortController();
      const current = { url, controller };
      waveformJobs.set(kind, current);
      try {
        return await audioPeaks(entry.path, entry.duration, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) return null;
        throw error;
      } finally {
        if (waveformJobs.get(kind) === current) waveformJobs.delete(kind);
      }
    },
    { direct: true },
  );
  handle(
    'cancel-waveform',
    (url) => {
      for (const pending of waveformJobs.values())
        if (pending.url === url) pending.controller.abort();
    },
    { direct: true },
  );
  handle(
    'new',
    async (name) => {
      project = newProject(
        String(name || '未命名项目')
          .trim()
          .slice(0, 100) || '未命名项目',
      );
      projectFile = undefined;
      receipt = undefined;
      media.clear();
      await persist();
      return { project, projectFile };
    },
    { mutable: true },
  );
  handle(
    'open',
    async () => {
      const answer = await dialog.showOpenDialog(window, {
        properties: ['openFile'],
        filters: [{ name: '剪辑项目', extensions: ['killclip'] }],
      });
      if (!answer.filePaths[0]) return null;
      const file = answer.filePaths[0];
      const data = await readJson(file);
      await hydrate(data, file);
      await persist();
      return projectState();
    },
    { mutable: true },
  );
  handle(
    'save',
    async () => {
      const answer = await dialog.showSaveDialog(window, {
        defaultPath: projectFile ?? 'game-clips.killclip',
        filters: [{ name: '剪辑项目', extensions: ['killclip'] }],
      });
      if (!answer.filePath) return null;
      const file = /\.killclip$/i.test(answer.filePath)
        ? answer.filePath
        : `${answer.filePath}.killclip`;
      projectFile = file;
      await persist();
      return file;
    },
    { mutable: true },
  );
  handle('retry-save', persist, { mutable: true });
  handle(
    'update',
    async ({ settings, marks, remove, mix }) => {
      if (settings) project.settings = validatedSettings(settings);
      if (mix) project.mix = validatedMix(mix);
      if (marks) {
        const entry = project.videos.find(({ id }) => id === marks.id);
        if (!entry) throw new Error('视频已移除');
        entry.marks = validatedMarks(marks.values);
      }
      if (remove)
        project.videos = project.videos.filter(({ id }) => id !== remove);
      receipt = undefined;
      await persist();
    },
    { mutable: true },
  );
  handle(
    'music',
    async (remove) => {
      let music = null;
      if (remove !== true) {
        const answer = await dialog.showOpenDialog(window, {
          properties: ['openFile'],
          filters: audioFilters,
        });
        if (!answer.filePaths[0]) return null;
        music = await describeMusic(answer.filePaths[0]);
      }
      if (project.music?.url)
        media.delete(new URL(project.music.url).pathname.slice(1));
      project.music = music;
      if (remove === true) project.mix.musicStart = 0;
      receipt = undefined;
      await persist();
      return projectState();
    },
    { mutable: true },
  );
  handle(
    'files',
    async () => {
      const answer = await dialog.showOpenDialog(window, {
        properties: ['openFile', 'multiSelections'],
        filters: videoFilters,
      });
      return importVideos(answer.filePaths);
    },
    { mutable: true },
  );
  handle('drop', (files) => importVideos(files), { mutable: true });
  handle(
    'scan',
    async () => {
      const folder = await chooseFolder();
      if (!folder) return project;
      const entries = await readdir(folder, { withFileTypes: true });
      return importVideos(
        entries
          .filter((entry) => entry.isFile())
          .toSorted((a, b) =>
            a.name.localeCompare(b.name, 'zh-CN', { numeric: true }),
          )
          .map(({ name }) => path.join(folder, name)),
      );
    },
    { mutable: true },
  );
  handle(
    'locate',
    async (id) => {
      const index = project.videos.findIndex((entry) => entry.id === id);
      if (index === -1) throw new Error('视频已移除');
      const answer = await dialog.showOpenDialog(window, {
        properties: ['openFile'],
        filters: videoFilters,
      });
      if (!answer.filePaths[0]) return project;
      const updated = await describeVideo(
        answer.filePaths[0],
        project.videos[index].marks,
        id,
      );
      if (
        project.videos.some(
          (entry) => entry.id !== id && samePath(entry.path, updated.path),
        )
      )
        throw new Error('该视频已在素材列表中');
      project.videos[index] = updated;
      receipt = undefined;
      await persist();
      return project;
    },
    { mutable: true },
  );
  handle(
    'output',
    async () => {
      const folder = await chooseFolder();
      if (!folder) return null;
      project.outputDirectory = folder;
      await persist();
      return folder;
    },
    { mutable: true },
  );
  handle('export', exportProject, { mutable: true });
  handle('wait', () => lastExport ?? project.result, { direct: true });
  handle('cancel', () => job?.controller.abort(), { direct: true });
  handle('reveal', async () => {
    const folder = project.result?.folder;
    const info = folder ? await stat(folder).catch(() => null) : null;
    if (folder && info?.isDirectory()) return shell.openPath(folder);
    return '找不到输出目录';
  });
  handle('cleanup', recycleSources, { mutable: true });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    job?.controller.abort();
    for (const pending of waveformJobs.values()) pending.controller.abort();
    void tail.then(async () => {
      const active = job;
      active?.controller.abort();
      await Promise.allSettled([active?.done]);
      quitting = true;
      app.quit();
    });
  });
  await createWindow();
}

void start().catch((error) => {
  console.error('Workbench startup:', error);
  app.exit(1);
});

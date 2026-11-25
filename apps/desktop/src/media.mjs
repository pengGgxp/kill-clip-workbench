import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const bundledTools =
  process.platform === 'win32' && process.resourcesPath && !process.defaultApp
    ? path.join(process.resourcesPath, 'media')
    : undefined;
const ffmpegPackage =
  !bundledTools && !process.env.KILL_CLIP_FFMPEG
    ? await import('ffmpeg-static')
    : undefined;
const ffprobePackage =
  !bundledTools && !process.env.KILL_CLIP_FFPROBE
    ? await import('@ffprobe-installer/ffprobe')
    : undefined;
const ffmpeg = bundledTools
  ? path.join(bundledTools, 'ffmpeg.exe')
  : process.env.KILL_CLIP_FFMPEG || ffmpegPackage?.default || 'ffmpeg';
const ffprobe = bundledTools
  ? path.join(bundledTools, 'ffprobe.exe')
  : process.env.KILL_CLIP_FFPROBE || ffprobePackage?.default.path;

export const videoExtensions = new Set([
  '.avi',
  '.flv',
  '.m4v',
  '.mkv',
  '.mov',
  '.mp4',
  '.mpeg',
  '.mpg',
  '.ts',
  '.webm',
  '.wmv',
]);
export const resolutions = {
  '1080p': [1920, 1080],
  '720p': [1280, 720],
};
const fps = 30;
const ffmpegOptions = [
  '-hide_banner',
  '-nostdin',
  '-loglevel',
  'error',
  '-xerror',
];
const flowBlurScript = bundledTools
  ? path.join(bundledTools, 'flowblur', 'flowblur.py')
  : fileURLToPath(new URL('flowblur.py', import.meta.url));
const flowBlurPython = bundledTools
  ? path.join(bundledTools, 'flowblur', 'python.exe')
  : process.env.KILL_CLIP_FLOWBLUR_PYTHON ||
    fileURLToPath(
      new URL('../../../.temp/flowblur/python.exe', import.meta.url),
    );

export async function checkFlowBlur() {
  try {
    await run(flowBlurPython, [
      '-c',
      'import vapoursynth as vs; assert callable(vs.core.mvu.FlowBlur)',
    ]);
  } catch (error) {
    throw new Error(
      '运动模糊运行环境不可用。开发版请运行 pnpm setup:flowblur，安装版请重新安装。',
      {
        cause: error,
      },
    );
  }
}

export function outputSize(setting, volume, videos) {
  if (setting !== 'source') return resolutions[setting];
  const source = videos.find(({ id }) => id === volume.clips[0]?.videoId);
  if (!source?.width || !source.height)
    throw new Error('无法确定输出尺寸，请重新导入首段素材');
  return [
    Math.max(2, Math.floor(source.width / 2) * 2),
    Math.max(2, Math.floor(source.height / 2) * 2),
  ];
}

function startProcess(
  executable,
  args,
  { signal, onProgress, pipeOutput } = {},
) {
  const child = spawn(executable, args, { signal, windowsHide: true });
  const done = new Promise((resolve, reject) => {
    let output = '';
    let diagnostics = '';
    let pending = '';
    if (!pipeOutput)
      child.stdout.setEncoding('utf8').on('data', (chunk) => {
        if (!onProgress) {
          output += chunk;
          return;
        }
        pending += chunk;
        const lines = pending.split('\n');
        pending = lines.pop();
        for (const line of lines) {
          const match = /^out_time_us=(\d+)/.exec(line);
          if (match) onProgress(Number(match[1]) / 1_000_000);
        }
      });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      diagnostics = (diagnostics + chunk).slice(-8000);
    });
    let spawnError;
    child.on('error', (error) => {
      spawnError = error;
    });
    child.on('close', (code) => {
      if (spawnError) reject(spawnError);
      else if (code === 0) resolve(output);
      else
        reject(
          new Error(
            diagnostics.trim() || `${path.basename(executable)} 退出码 ${code}`,
          ),
        );
    });
  });
  return { child, done };
}

function run(executable, args, options) {
  return startProcess(executable, args, options).done;
}

export function runFFmpeg(args, options) {
  return run(ffmpeg, [...ffmpegOptions, ...args], options);
}

async function renderFlowBlur({
  source,
  filter,
  audio,
  encoding,
  duration,
  size,
  frameCount,
  signal,
  onProgress,
}) {
  const [width, height] = size;
  const controller = new AbortController();
  const renderSignal = AbortSignal.any([signal, controller.signal]);
  const rawVideo = ['-f', 'rawvideo', '-pix_fmt', 'yuv420p'];
  const decoder = startProcess(
    ffmpeg,
    [
      ...ffmpegOptions,
      ...source,
      '-map',
      '0:V:0',
      '-vf',
      filter,
      '-t',
      duration,
      '-frames:v',
      String(frameCount),
      ...rawVideo,
      '-threads',
      '1',
      'pipe:1',
    ],
    { signal: renderSignal, pipeOutput: true },
  );
  const blur = startProcess(
    flowBlurPython,
    [
      flowBlurScript,
      String(width),
      String(height),
      String(fps),
      String(frameCount),
    ],
    { signal: renderSignal, pipeOutput: true },
  );
  const encoder = startProcess(
    ffmpeg,
    [
      ...ffmpegOptions,
      '-n',
      '-progress',
      'pipe:1',
      ...rawVideo,
      '-video_size',
      `${width}x${height}`,
      '-framerate',
      String(fps),
      '-i',
      'pipe:0',
      ...audio.inputs,
      '-map',
      '0:v:0',
      '-map',
      audio.map,
      ...encoding,
    ],
    { signal: renderSignal, onProgress },
  );
  const tasks = [
    decoder.done,
    blur.done,
    encoder.done,
    pipeline(decoder.child.stdout, blur.child.stdin, { signal: renderSignal }),
    pipeline(blur.child.stdout, encoder.child.stdin, { signal: renderSignal }),
  ];
  try {
    await Promise.all(tasks);
  } catch (error) {
    controller.abort();
    const settled = await Promise.allSettled(tasks);
    signal.throwIfAborted();
    const processError = settled
      .slice(0, 3)
      .find(
        (result) =>
          result.status === 'rejected' && result.reason.name !== 'AbortError',
      );
    throw processError?.reason ?? error;
  }
}

export async function fileIdentity(file) {
  const info = await stat(file, { bigint: true });
  if (!info.isFile()) throw new Error('路径不是文件');
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
}

export async function probe(file, signal) {
  const identity = await fileIdentity(file);
  const data = JSON.parse(
    await run(
      ffprobe,
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'file',
        '-show_streams',
        '-show_format',
        '-of',
        'json',
        file,
      ],
      { signal },
    ),
  );
  const video = data.streams?.find(
    (stream) =>
      stream.codec_type === 'video' && !stream.disposition?.attached_pic,
  );
  const duration = Number(data.format?.duration);
  if (
    !video?.width ||
    !video.height ||
    !Number.isFinite(duration) ||
    duration <= 0
  ) {
    throw new Error('未找到有效的视频轨道或时长');
  }
  const [numerator, denominator] = (video.avg_frame_rate || '')
    .split('/')
    .map(Number);
  return {
    duration,
    identity,
    width: video.width,
    height: video.height,
    fps: denominator ? Math.round((numerator / denominator) * 100) / 100 : 0,
    hasAudio: data.streams.some((stream) => stream.codec_type === 'audio'),
  };
}

export async function verifyOutput(file, limit, minimum, signal, onProgress) {
  const metadata = await probe(file, signal);
  if (metadata.duration > limit || metadata.duration < minimum) {
    throw new Error(
      `输出时长 ${metadata.duration} 秒，预期范围 ${minimum}–${limit} 秒`,
    );
  }
  await runFFmpeg(
    [
      '-progress',
      'pipe:1',
      '-err_detect',
      'explode',
      '-protocol_whitelist',
      'file',
      '-i',
      file,
      '-map',
      '0:v:0',
      '-map',
      '0:a?',
      '-f',
      'null',
      '-',
    ],
    { signal, onProgress },
  );
  return metadata;
}

export async function renderVolume(
  volume,
  folder,
  size,
  limit,
  signal,
  progress,
  { motionBlur = false } = {},
) {
  const working = await mkdtemp(path.join(folder, '.render-'));
  const name = `kills-${String(volume.number).padStart(3, '0')}.mp4`;
  const target = path.join(folder, name);
  try {
    const [width, height] = Array.isArray(size) ? size : resolutions[size];
    const concat = ['ffconcat version 1.0'];
    let completed = 0;
    let framesDone = 0;
    const totalFrames = Math.floor(limit * fps + 1e-7);
    for (const [index, clip] of volume.clips.entries()) {
      const segment = `part-${index}.mp4`;
      const frameCount = Math.min(
        totalFrames - framesDone,
        Math.max(1, Math.floor(clip.duration * fps + 1e-7)),
      );
      if (frameCount < 1) throw new Error('分卷内的短片段超过帧数上限');
      framesDone += frameCount;
      const duration = (frameCount / fps).toFixed(6);
      const audioInput = clip.audio
        ? []
        : ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'];
      const source = [
        '-ss',
        String(clip.start),
        '-protocol_whitelist',
        'file',
        '-i',
        clip.videoPath,
      ];
      const filter = `scale=w='if(gte(dar,${width}/${height}),${width},max(2,trunc(${height}*dar/2)*2))':h='if(gte(dar,${width}/${height}),max(2,trunc(${width}/dar/2)*2),${height})',setsar=1,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=${fps},tpad=stop_mode=clone:stop_duration=0.5`;
      const encoding = [
        '-af',
        'aresample=48000:async=1:first_pts=0,apad',
        '-t',
        duration,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '21',
        '-pix_fmt',
        'yuv420p',
        '-bf',
        '0',
        '-c:a',
        'aac',
        '-b:a',
        '160k',
        '-ac',
        '2',
        '-ar',
        '48000',
        path.join(working, segment),
      ];
      const onProgress = (position) =>
        progress(
          Math.min(
            86,
            Math.floor((86 * (completed + position)) / volume.duration),
          ),
          clip.videoName,
        );
      await (motionBlur
        ? renderFlowBlur({
            source,
            filter,
            encoding,
            duration,
            size: [width, height],
            frameCount,
            signal,
            onProgress,
            audio: { inputs: clip.audio ? source : audioInput, map: '1:a:0' },
          })
        : runFFmpeg(
            [
              '-n',
              '-progress',
              'pipe:1',
              ...source,
              ...audioInput,
              '-map',
              '0:V:0',
              '-map',
              clip.audio ? '0:a:0' : '1:a:0',
              '-vf',
              filter,
              ...encoding,
            ],
            { signal, onProgress },
          ));
      const metadata = await probe(path.join(working, segment), signal);
      if (
        metadata.duration < Number(duration) - 1 / fps ||
        metadata.duration > Number(duration) + 1 / fps
      ) {
        throw new Error(`${clip.videoName} 片段时长与计划不符`);
      }
      completed += clip.duration;
      concat.push(`file ${segment}`, `duration ${duration}`);
    }

    const list = path.join(working, 'concat.txt');
    const temporary = path.join(working, 'result.mp4');
    await writeFile(list, `${concat.join('\n')}\n`, 'utf8');
    const planned = framesDone / fps;
    // Keep a frame of headroom for AAC packet padding and MP4 timestamp rounding.
    const ceiling =
      Math.floor(Math.min(planned, limit - 1 / fps) * 1000) / 1000;
    progress(88, '正在拼接');
    await runFFmpeg(
      [
        '-n',
        '-f',
        'concat',
        '-safe',
        '1',
        '-protocol_whitelist',
        'file',
        '-i',
        list,
        '-t',
        String(ceiling),
        '-map',
        '0:v:0',
        '-map',
        '0:a:0',
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-b:a',
        '160k',
        '-avoid_negative_ts',
        'disabled',
        '-movflags',
        '+faststart',
        temporary,
      ],
      { signal },
    );
    progress(92, '正在校验');
    const metadata = await verifyOutput(
      temporary,
      limit,
      Math.max(0.02, planned - 0.12),
      signal,
      (position) =>
        progress(
          Math.min(99, 92 + Math.floor((7 * position) / planned)),
          '正在校验',
        ),
    );
    signal.throwIfAborted();
    await rename(temporary, target);
    return {
      path: target,
      name,
      duration: metadata.duration,
      identity: await fileIdentity(target),
    };
  } finally {
    await rm(working, { force: true, recursive: true });
  }
}

export async function ensureSpace(folder, seconds, longestVolume, size) {
  const { bavail, bsize } = await statfs(folder);
  const pixels = Array.isArray(size) ? size[0] * size[1] : undefined;
  let bytesPerSecond = 900_000;
  if (size === '1080p') bytesPerSecond = 1_500_000;
  if (pixels) bytesPerSecond = Math.ceil((1_500_000 * pixels) / (1920 * 1080));
  const estimate = Math.ceil(
    (seconds + 2 * longestVolume) * bytesPerSecond + 32 * 1024 * 1024,
  );
  if (bavail * bsize < estimate) {
    throw new Error(
      `按当前规格估算需 ${(estimate / 2 ** 30).toFixed(2)} GiB 可用空间，请更换输出目录`,
    );
  }
}

export async function writeJson(file, data) {
  const temporary = path.join(
    path.dirname(file),
    `.killclip-${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, JSON.stringify(data, null, 2), {
      encoding: 'utf8',
      flag: 'wx',
    });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function readJson(file) {
  const info = await stat(file);
  if (!info.isFile() || info.size > 16 * 1024 * 1024)
    throw new Error('项目文件无效或过大');
  return JSON.parse(await readFile(file, 'utf8'));
}

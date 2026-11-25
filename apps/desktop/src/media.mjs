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

import ffprobe from '@ffprobe-installer/ffprobe';
import ffmpeg from 'ffmpeg-static';

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

function run(executable, args, { signal, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { signal, windowsHide: true });
    let output = '';
    let diagnostics = '';
    let pending = '';
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
      else reject(new Error(diagnostics.trim() || `FFmpeg 退出码 ${code}`));
    });
  });
}

export function runFFmpeg(args, options) {
  return run(
    process.env.KILL_CLIP_FFMPEG || ffmpeg || 'ffmpeg',
    ['-hide_banner', '-nostdin', '-loglevel', 'error', '-xerror', ...args],
    options,
  );
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
      process.env.KILL_CLIP_FFPROBE || ffprobe.path,
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
) {
  const working = await mkdtemp(path.join(folder, '.render-'));
  const name = `kills-${String(volume.number).padStart(3, '0')}.mp4`;
  const target = path.join(folder, name);
  try {
    const [width, height] = resolutions[size];
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
      await runFFmpeg(
        [
          '-n',
          '-progress',
          'pipe:1',
          '-ss',
          String(clip.start),
          '-protocol_whitelist',
          'file',
          '-i',
          clip.videoPath,
          ...audioInput,
          '-map',
          '0:V:0',
          '-map',
          clip.audio ? '0:a:0' : '1:a:0',
          '-vf',
          `scale=w='if(gte(dar,${width}/${height}),${width},max(2,trunc(${height}*dar/2)*2))':h='if(gte(dar,${width}/${height}),max(2,trunc(${width}/dar/2)*2),${height})',setsar=1,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=${fps},tpad=stop_mode=clone:stop_duration=0.5`,
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
        ],
        {
          signal,
          onProgress: (position) =>
            progress(
              Math.min(
                86,
                Math.floor((86 * (completed + position)) / volume.duration),
              ),
              clip.videoName,
            ),
        },
      );
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
  const estimate = Math.ceil(
    (seconds + 2 * longestVolume) * (size === '1080p' ? 1_500_000 : 900_000) +
      32 * 1024 * 1024,
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

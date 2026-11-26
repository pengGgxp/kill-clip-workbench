const TIME_TOKEN =
  /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$|^(\d+)(?:\.(\d{1,3}))?$/;

export function parseTimeToken(token) {
  const value = token.trim();
  const match = TIME_TOKEN.exec(value);
  if (!match) {
    return { error: '时间格式应为 mm:ss 或 hh:mm:ss', value };
  }

  let seconds;
  if (match[5] === undefined) {
    const hours = match[1] ? Number(match[1]) : 0;
    const minutes = Number(match[2]);
    const wholeSeconds = Number(match[3]);
    if (wholeSeconds > 59 || (match[1] && minutes > 59)) {
      return { error: '分和秒必须小于 60', value };
    }
    seconds = hours * 3600 + minutes * 60 + wholeSeconds;
    if (match[4]) {
      seconds += Number(`0.${match[4]}`);
    }
  } else {
    seconds = Number(match[5]);
    if (match[6]) {
      seconds += Number(`0.${match[6]}`);
    }
  }

  if (!Number.isSafeInteger(Math.round(seconds * 1000))) {
    return { error: '时间值过大', value };
  }
  return { seconds: Math.round(seconds * 1000) / 1000, value };
}

export function parseTimestampList(input) {
  const tokens = input
    .split(/[\s,，;；]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  const seen = new Set();
  const values = [];
  const errors = [];
  const duplicates = [];

  for (const token of tokens) {
    const result = parseTimeToken(token);
    if (result.error || result.seconds === undefined) {
      errors.push({ value: token, message: result.error ?? '无法解析时间' });
      continue;
    }
    if (seen.has(result.seconds)) {
      duplicates.push(token);
      continue;
    }
    seen.add(result.seconds);
    values.push(result.seconds);
  }

  return {
    values: values.toSorted((left, right) => left - right),
    errors,
    duplicates,
  };
}

function validSettings(settings) {
  const preRollSeconds = Number(settings.preRollSeconds);
  const postRollSeconds = Number(settings.postRollSeconds);
  const mergeGapSeconds = Number(settings.mergeGapSeconds);
  const maxVolumeHours = Number(settings.maxVolumeHours);
  return (
    Number.isFinite(preRollSeconds) &&
    preRollSeconds >= 0 &&
    Number.isFinite(postRollSeconds) &&
    postRollSeconds >= 0 &&
    Number.isFinite(mergeGapSeconds) &&
    mergeGapSeconds >= 0 &&
    Number.isFinite(maxVolumeHours) &&
    maxVolumeHours * 3600 >= 1
  );
}

function mergeVideoWindows(video, settings) {
  const marks = [...new Set(video.marks)].toSorted(
    (left, right) => left - right,
  );
  const candidates = marks
    .map((mark) => ({
      start: Math.max(0, mark - settings.preRollSeconds),
      end: Math.min(video.duration, mark + settings.postRollSeconds),
      killTimes: [mark],
    }))
    .filter((clip) => clip.end > clip.start);
  const merged = [];

  for (const candidate of candidates) {
    const previous = merged.at(-1);
    if (
      previous &&
      candidate.start - previous.end <= settings.mergeGapSeconds
    ) {
      previous.end = Math.max(previous.end, candidate.end);
      previous.killTimes.push(...candidate.killTimes);
    } else {
      merged.push({ ...candidate });
    }
  }
  return merged;
}

export function buildClipPlan(videos, settings) {
  const issues = [];
  if (!validSettings(settings)) {
    return {
      clips: [],
      volumes: [],
      issues: [
        {
          severity: 'error',
          message: '剪辑设置无效，请检查保留时长、合并间隔和分卷上限。',
        },
      ],
      totalSeconds: 0,
      totalKills: 0,
      filesWithMarks: 0,
    };
  }

  const limit = Math.floor(settings.maxVolumeHours * 3_600_000);
  const clips = [];
  let filesWithMarks = 0;
  let totalKills = 0;

  for (const video of videos) {
    const marks = [...new Set(video.marks)].toSorted(
      (left, right) => left - right,
    );
    if (marks.length === 0) {
      issues.push({
        videoId: video.id,
        videoName: video.name,
        severity: 'warning',
        message: '尚未添加击杀时间点，导出时将跳过此视频。',
      });
      continue;
    }
    filesWithMarks += 1;

    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      issues.push({
        videoId: video.id,
        videoName: video.name,
        severity: 'error',
        message: '无法读取视频时长，请重新导入此文件。',
      });
      continue;
    }

    const invalidMarks = marks.filter(
      (mark) => !Number.isFinite(mark) || mark < 0 || mark > video.duration,
    );
    if (invalidMarks.length > 0) {
      issues.push({
        videoId: video.id,
        videoName: video.name,
        severity: 'error',
        message: `时间点 ${invalidMarks.map((mark) => formatTimestamp(mark)).join('、')} 超出视频时长。`,
      });
      continue;
    }

    totalKills += marks.length;
    const windows = mergeVideoWindows(video, settings);
    if (windows.length === 0) {
      issues.push({
        videoId: video.id,
        videoName: video.name,
        severity: 'error',
        message: '片段窗口为空，请增加击杀点前后保留时长。',
      });
      continue;
    }

    for (const window of windows) {
      let cursor = Math.round(window.start * 1000);
      const windowEnd = Math.floor(window.end * 1000 + 1e-7);
      while (cursor < windowEnd) {
        const end = Math.min(windowEnd, cursor + limit);
        const currentMarks = window.killTimes.filter(
          (mark) =>
            mark * 1000 >= cursor && (mark * 1000 < end || end === windowEnd),
        );
        clips.push({
          id: `${video.id}-${clips.length + 1}`,
          videoId: video.id,
          videoName: video.name,
          videoPath: video.path,
          start: cursor / 1000,
          end: end / 1000,
          duration: (end - cursor) / 1000,
          killTimes: currentMarks,
          audio: video.hasAudio ?? true,
        });
        cursor = end;
      }
    }
  }

  const volumes = [];
  for (const clip of clips) {
    let volume = volumes.at(-1);
    if (
      !volume ||
      Math.round((volume.duration + clip.duration) * 1000) > limit
    ) {
      volume = {
        number: volumes.length + 1,
        duration: 0,
        clips: [],
      };
      volumes.push(volume);
    }
    volume.clips.push(clip);
    volume.duration = roundToMilliseconds(volume.duration + clip.duration);
  }

  return {
    clips,
    volumes,
    issues,
    totalSeconds: roundToMilliseconds(
      clips.reduce((total, clip) => total + clip.duration, 0),
    ),
    totalKills,
    filesWithMarks,
  };
}

export const outputFps = 30;

export function clipFrameCount(clip, framesDone, limit) {
  return Math.min(
    Math.floor(limit * outputFps + 1e-7) - framesDone,
    Math.max(1, Math.floor(clip.duration * outputFps + 1e-7)),
  );
}

export function outputDuration(frames, limit) {
  // Leave room for AAC padding and MP4 timestamp rounding.
  return (
    Math.floor(Math.min(frames / outputFps, limit - 1 / outputFps) * 1000) /
    1000
  );
}

export function buildOutputTimeline(volumes, limit) {
  let duration = 0;
  const clips = [];
  const volumeStarts = [];
  for (const volume of volumes) {
    volumeStarts.push(duration);
    let frames = 0;
    const first = clips.length;
    for (const clip of volume.clips) {
      const count = clipFrameCount(clip, frames, limit);
      if (count < 1) break;
      const outputStart = duration + frames / outputFps;
      frames += count;
      clips.push({
        ...clip,
        outputStart,
        outputEnd: duration + frames / outputFps,
      });
    }
    duration += outputDuration(frames, limit);
    if (clips.length > first) {
      while (clips.length > first && clips.at(-1).outputStart >= duration)
        clips.pop();
      if (clips.length > first) clips.at(-1).outputEnd = duration;
    }
  }
  return { clips, duration, volumeStarts };
}

export function formatTimestamp(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '—';
  }
  const time = Math.round(seconds * 1000);
  const hours = Math.floor(time / 3_600_000);
  const minutes = Math.floor(time / 60_000) % 60;
  const wholeSeconds = Math.floor(time / 1000) % 60;
  const milliseconds = time % 1000;
  const base =
    hours > 0
      ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}`
      : `${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}`;
  return milliseconds > 0
    ? `${base}.${String(milliseconds).padStart(3, '0')}`
    : base;
}

function roundToMilliseconds(value) {
  return Math.round(value * 1000) / 1000;
}

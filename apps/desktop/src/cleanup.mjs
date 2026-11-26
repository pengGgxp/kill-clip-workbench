import { stat } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

import { buildClipPlan } from './clip-plan.mjs';
import { readJson, sameFileIdentity } from './media.mjs';

function clipRanges(clips) {
  return clips.map(({ videoPath, start, end, killTimes }) => ({
    videoPath,
    start,
    end,
    killTimes,
  }));
}

export async function restoreCleanupSources(
  result,
  saved,
  originals,
  videos,
  settings,
) {
  if (
    saved === null ||
    !result?.volumes.length ||
    result.volumes.some(({ status }) => status !== 'success')
  ) {
    return [];
  }
  const report = await readJson(result.report).catch(() => null);
  if (
    report?.folder !== result.folder ||
    !Array.isArray(report.volumes) ||
    report.volumes.length !== result.volumes.length ||
    !report.volumes.every(
      (volume, index) =>
        volume?.status === 'success' &&
        volume.name === result.volumes[index].name &&
        sameFileIdentity(volume.identity, result.volumes[index].identity),
    ) ||
    !Array.isArray(report.plan?.clips) ||
    !report.plan.clips.every((clip) => typeof clip?.videoPath === 'string')
  ) {
    return [];
  }
  const exportedPaths = new Set(
    report.plan.clips.map(({ videoPath }) => videoPath),
  );
  const eligible = videos.filter(
    (video) =>
      !video.error &&
      exportedPaths.has(video.path) &&
      !result.volumes.some(({ identity }) =>
        sameFileIdentity(identity, video.identity),
      ),
  );

  if (Array.isArray(saved)) {
    const byId = new Map(saved.map((source) => [source?.id, source]));
    return eligible.filter((video) => {
      const source = byId.get(video.id);
      return (
        source?.path === video.path &&
        sameFileIdentity(source.identity, video.identity)
      );
    });
  }

  // Older exports only recorded clip ranges. Match the original plan and
  // require each source to still match its saved identity and predate the export.
  if (
    saved !== undefined ||
    !isDeepStrictEqual(report.settings, settings) ||
    !isDeepStrictEqual(
      clipRanges(report.plan.clips),
      clipRanges(buildClipPlan(videos, settings).clips),
    )
  ) {
    return [];
  }
  let firstOutputTime = BigInt(result.volumes[0].identity.split(':')[3]);
  for (const { identity } of result.volumes.slice(1)) {
    const time = BigInt(identity.split(':')[3]);
    if (time < firstOutputTime) firstOutputTime = time;
  }
  const byPath = new Map(originals.map((source) => [source.path, source]));
  const sources = [];
  for (const video of eligible) {
    if (!sameFileIdentity(byPath.get(video.path)?.identity, video.identity))
      continue;
    const info = await stat(video.path, { bigint: true }).catch(() => null);
    if (
      info &&
      info.mtimeNs <= firstOutputTime &&
      info.birthtimeNs <= firstOutputTime
    ) {
      sources.push(video);
    }
  }
  return sources;
}

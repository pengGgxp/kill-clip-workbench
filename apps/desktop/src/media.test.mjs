// @vitest-environment node

import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from 'vitest';

import { buildClipPlan } from './clip-plan.mjs';
import {
  fileIdentity,
  outputSize,
  probe,
  renderVolume,
  runFFmpeg,
} from './media.mjs';

it('uses the first source clip dimensions for each volume in source mode', () => {
  const volume = { clips: [{ videoId: 'second' }] };
  const videos = [
    { id: 'first', width: 1920, height: 1080 },
    { id: 'second', width: 1440, height: 1080 },
  ];
  assert.deepEqual(outputSize('source', volume, videos), [1440, 1080]);
  assert.deepEqual(outputSize('720p', volume, videos), [1280, 720]);
  assert.throws(() => outputSize('source', volume, []), /无法确定输出尺寸/);
});

it('exports and fully verifies different video specifications within the volume limit', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'kill-clip-test-'));
  try {
    const first = path.join(folder, '有声音.mp4');
    const second = path.join(folder, '无声音.mp4');
    await runFFmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=1440x1080:r=30',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440',
      '-t',
      '4',
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      first,
    ]);
    await runFFmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=240x320:r=24',
      '-t',
      '4',
      '-c:v',
      'libx264',
      second,
    ]);
    const videos = await Promise.all(
      [first, second].map(async (file, index) => ({
        ...(await probe(file)),
        path: file,
        name: path.basename(file),
        id: String(index),
        marks: [2],
      })),
    );
    const plan = buildClipPlan(videos, {
      preRollSeconds: 1,
      postRollSeconds: 1,
      mergeGapSeconds: 0,
      maxVolumeHours: 4 / 3600,
    });
    assert.equal(plan.volumes.length, 1);
    const progress = [];
    const sourceSize = outputSize('source', plan.volumes[0], videos);
    const result = await renderVolume(
      plan.volumes[0],
      folder,
      sourceSize,
      4,
      new AbortController().signal,
      (percentage) => progress.push(percentage),
    );
    assert.ok(result.duration >= 3.9 && result.duration <= 4);
    assert.equal(result.identity, await fileIdentity(result.path));
    assert.ok(progress.some((percentage) => percentage >= 92));
    const metadata = await probe(result.path);
    assert.deepEqual([metadata.width, metadata.height], [1440, 1080]);
    await Promise.all([stat(first), stat(second)]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

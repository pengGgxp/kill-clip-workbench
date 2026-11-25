import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { it } from 'vitest';

import { buildClipPlan } from './clip-plan.mjs';
import { fileIdentity, probe, renderVolume, runFFmpeg } from './media.mjs';

it('exports and fully verifies different video specifications within the volume limit', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'kill-clip-test-'));
  try {
    const first = path.join(folder, '有声音.mp4');
    const second = path.join(folder, '无声音.mp4');
    await runFFmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=320x180:r=60',
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
    const result = await renderVolume(
      plan.volumes[0],
      folder,
      '720p',
      4,
      new AbortController().signal,
      (percentage) => progress.push(percentage),
    );
    assert.ok(result.duration >= 3.9 && result.duration <= 4);
    assert.equal(result.identity, await fileIdentity(result.path));
    assert.ok(progress.some((percentage) => percentage >= 92));
    const metadata = await probe(result.path);
    assert.equal(metadata.width, 1280);
    await Promise.all([stat(first), stat(second)]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

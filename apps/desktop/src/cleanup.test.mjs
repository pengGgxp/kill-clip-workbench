// @vitest-environment node

import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from 'vitest';

import { restoreCleanupSources } from './cleanup.mjs';
import { buildClipPlan } from './clip-plan.mjs';
import { fileIdentity, writeJson } from './media.mjs';

it('restores eligible sources from current and legacy export records', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'kill-clip-cleanup-'));
  try {
    const settings = {
      preRollSeconds: 1,
      postRollSeconds: 1,
      mergeGapSeconds: 0,
      maxVolumeHours: 1,
      motionBlur: false,
      resolution: 'source',
    };
    const videos = [];
    for (const { id, marks } of [
      { id: 'first', marks: [2] },
      { id: 'second', marks: [3] },
      { id: 'extra', marks: [] },
    ]) {
      const file = path.join(folder, `${id}.mp4`);
      await writeFile(file, id);
      videos.push({
        id,
        name: path.basename(file),
        path: file,
        identity: await fileIdentity(file),
        marks,
        duration: 5,
      });
    }
    const [first, second] = videos;
    const output = path.join(folder, 'kills-001.mp4');
    await writeFile(output, 'export');
    const later = new Date(Date.now() + 60_000);
    await utimes(output, later, later);
    const result = {
      folder,
      report: path.join(folder, 'export-report.json'),
      volumes: [
        {
          name: path.basename(output),
          identity: await fileIdentity(output),
          status: 'success',
        },
      ],
    };
    const plan = buildClipPlan(videos, settings);
    await writeJson(result.report, { ...result, settings, plan });
    const restore = (saved, restored = videos) =>
      restoreCleanupSources(result, saved, videos, restored, settings);

    assert.deepEqual(await restore(undefined), [first, second]);
    assert.deepEqual(await restore(null), []);
    assert.deepEqual(await restore([second]), [second]);

    await writeFile(second.path, 'replaced video');
    const replaced = { ...second, identity: await fileIdentity(second.path) };
    const updated = [first, replaced, videos[2]];
    assert.deepEqual(await restore([first, second], updated), [first]);
    assert.deepEqual(await restore(undefined, updated), [first]);

    await writeJson(result.report, { ...result, settings, plan, volumes: [] });
    assert.deepEqual(await restore([first]), []);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

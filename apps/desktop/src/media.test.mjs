// @vitest-environment node

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from 'vitest';

import { buildClipPlan, buildOutputTimeline } from './clip-plan.mjs';
import {
  audioPeaks,
  fileIdentity,
  fitFilter,
  outputSize,
  probe,
  probeAudio,
  renderVolume,
  reusableProbeMetadata,
  runFFmpeg,
  sameFileIdentity,
} from './media.mjs';

it('reads waveform peaks at the right time and bounds the number of bins', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'kill-clip-waveform-'));
  try {
    const file = path.join(folder, 'waveform.wav');
    await runFFmpeg([
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1',
      '-af',
      'adelay=1000',
      file,
    ]);
    const { peaks, secondsPerPeak } = await audioPeaks(file, 2);
    assert.ok(peaks.length <= 4096);
    assert.ok(
      peaks
        .slice(0, Math.floor(0.99 / secondsPerPeak))
        .every((peak) => peak === 0),
    );
    assert.ok(
      peaks
        .slice(Math.ceil(1.01 / secondsPerPeak))
        .some((peak) => peak > 0.1 && peak <= 1),
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

it('ignores change-time differences but detects content identity differences', () => {
  const original = '1:2:3:4:5';
  assert.equal(sameFileIdentity(original, '1:2:3:4:6'), true);
  assert.equal(sameFileIdentity(original, '1:2:3:7:5'), false);
  assert.equal(sameFileIdentity(original, '1:2:3:4'), false);
});

it('reuses cached probe metadata only while the media identity is unchanged', () => {
  const cached = {
    duration: 42.5,
    identity: '1:2:3:4:5',
    width: 1440,
    height: 1080,
    fps: 60,
    hasAudio: true,
  };
  assert.deepEqual(reusableProbeMetadata(cached, '1:2:3:4:6'), {
    ...cached,
    identity: '1:2:3:4:6',
  });
  assert.equal(reusableProbeMetadata(cached, '1:2:3:7:5'), null);
  assert.equal(
    reusableProbeMetadata({ ...cached, width: 0 }, '1:2:3:4:5'),
    null,
  );
});

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

it('builds distinct fit filters for stretch, crop, and padding', () => {
  assert.match(fitFilter(1920, 1080, 'stretch'), /^scale=1920:1080,setsar=1,/);
  assert.match(
    fitFilter(1920, 1080, 'crop'),
    /^scale=1920:1080:force_original_aspect_ratio=increase:force_divisible_by=2,crop=1920:1080,setsar=1,/,
  );
  assert.match(
    fitFilter(1920, 1080, 'pad'),
    /pad=1920:1080:\(ow-iw\)\/2:\(oh-ih\)\/2,/,
  );
  assert.equal(fitFilter(1920, 1080), fitFilter(1920, 1080, 'pad'));
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

it('mixes independently leveled audio at the configured start and continues it across volumes', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'kill-clip-mix-'));
  try {
    const source = path.join(folder, 'source.mp4');
    const silent = path.join(folder, 'silent.mp4');
    const music = path.join(folder, 'music.wav');
    await Promise.all([
      runFFmpeg([
        '-f',
        'lavfi',
        '-i',
        'testsrc2=s=96x64:r=30',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440',
        '-t',
        '3',
        '-c:v',
        'libx264',
        '-c:a',
        'aac',
        source,
      ]),
      runFFmpeg([
        '-f',
        'lavfi',
        '-i',
        'testsrc2=s=96x64:r=30',
        '-t',
        '3',
        '-c:v',
        'libx264',
        silent,
      ]),
      runFFmpeg([
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=880:duration=1.5',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=1320:duration=1.5',
        '-filter_complex',
        '[0:a][1:a]concat=n=2:v=0:a=1',
        music,
      ]),
    ]);
    const metadata = await probeAudio(music);
    assert.equal(metadata.duration, 3);
    const plan = buildClipPlan(
      [source, silent].map((file, index) => ({
        id: `${index}`,
        name: path.basename(file),
        path: file,
        marks: [1.5],
        duration: 3,
        hasAudio: index === 0,
      })),
      {
        preRollSeconds: 1,
        postRollSeconds: 1,
        mergeGapSeconds: 0,
        maxVolumeHours: 3 / 3600,
      },
    );
    const { volumeStarts } = buildOutputTimeline(plan.volumes, 3);
    assert.deepEqual(volumeStarts, [0, 2]);

    const signals = [];
    for (const [index, volume] of plan.volumes.entries()) {
      const result = await renderVolume(
        volume,
        folder,
        [96, 64],
        3,
        new AbortController().signal,
        () => {},
        {
          music: { path: music, start: 0.5, ...metadata },
          sourceVolume: 0.4,
          musicVolume: 0.65,
          volumeStart: volumeStarts[index],
        },
      );
      const pcm = path.join(folder, `${index}.pcm`);
      await runFFmpeg([
        '-i',
        result.path,
        '-map',
        '0:a:0',
        '-ac',
        '1',
        '-ar',
        '8000',
        '-f',
        's16le',
        pcm,
      ]);
      signals.push(await readFile(pcm));
    }

    function amplitude(index, time, frequency) {
      const data = signals[index];
      let real = 0;
      let imaginary = 0;
      const start = Math.round(time * 8000);
      const length = 1600;
      for (let sample = 0; sample < length; sample++) {
        const phase = (2 * Math.PI * frequency * sample) / 8000;
        const value = data.readInt16LE((start + sample) * 2) / 32_768;
        real += value * Math.cos(phase);
        imaginary += value * Math.sin(phase);
      }
      return (2 * Math.hypot(real, imaginary)) / length;
    }

    assert.ok(
      amplitude(0, 0.15, 440) > 0.025 && amplitude(0, 0.15, 440) < 0.065,
    );
    assert.ok(amplitude(0, 0.15, 880) < 0.002);
    assert.ok(amplitude(0, 0.75, 440) > 0.025);
    assert.ok(amplitude(0, 0.75, 880) > 0.045 && amplitude(0, 0.75, 880) < 0.1);
    assert.ok(amplitude(1, 0.2, 1320) > 0.045);
    assert.ok(amplitude(1, 0.2, 880) < 0.002);
    assert.ok(amplitude(1, 1.6, 1320) < 0.002);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

import { describe, expect, it } from 'vitest';

import {
  buildClipPlan,
  formatTimestamp,
  parseTimeToken,
  parseTimestampList,
} from './clip-plan.mjs';

const settings = {
  preRollSeconds: 5,
  postRollSeconds: 5,
  mergeGapSeconds: 8,
  maxVolumeHours: 1,
};

function video(marks: number[], duration = 600) {
  return {
    duration,
    id: 'video-1',
    marks,
    name: 'match.mp4',
    path: 'C:/match.mp4',
  };
}

describe('timestamp parsing', () => {
  it('parses mm:ss, hh:mm:ss, decimals and plain seconds', () => {
    expect(parseTimeToken('1:29')).toMatchObject({ seconds: 89 });
    expect(parseTimeToken('00:01:29')).toMatchObject({ seconds: 89 });
    expect(parseTimeToken('00:01:29.500')).toMatchObject({
      seconds: 89.5,
    });
    expect(parseTimeToken('90')).toMatchObject({ seconds: 90 });
  });

  it('rejects malformed time values', () => {
    expect(parseTimeToken('1:75')).toMatchObject({
      error: '分和秒必须小于 60',
    });
    expect(parseTimeToken('abc')).toMatchObject({
      error: '时间格式应为 mm:ss 或 hh:mm:ss',
    });
  });

  it('splits pasted values and removes duplicates', () => {
    expect(parseTimestampList('1:45, 1:29；00:01:29\nbad')).toEqual({
      values: [89, 105],
      errors: [{ value: 'bad', message: '时间格式应为 mm:ss 或 hh:mm:ss' }],
      duplicates: ['00:01:29'],
    });
  });
});

describe('clip plan', () => {
  it('merges windows when the gap is within the configured limit', () => {
    const plan = buildClipPlan([video([89, 105])], settings);
    expect(plan.clips).toHaveLength(1);
    expect(plan.clips[0]).toMatchObject({
      start: 84,
      end: 110,
      killTimes: [89, 105],
    });
  });

  it('keeps windows separate when their gap exceeds the configured limit', () => {
    const plan = buildClipPlan([video([89, 108])], settings);
    expect(plan.clips).toHaveLength(2);
    expect(plan.clips.map(({ start, end }) => [start, end])).toEqual([
      [84, 94],
      [103, 113],
    ]);
  });

  it('clamps clips to video boundaries', () => {
    const plan = buildClipPlan([video([1, 599], 600)], settings);
    expect(plan.clips.map(({ start, end }) => [start, end])).toEqual([
      [0, 6],
      [594, 600],
    ]);
  });

  it('starts a new volume before the next clip would exceed the limit', () => {
    const plan = buildClipPlan([video([100, 190, 280])], {
      ...settings,
      maxVolumeHours: 0.006,
      mergeGapSeconds: 0,
    });
    expect(plan.volumes.map((volume) => volume.clips.length)).toEqual([2, 1]);
    expect(plan.volumes.every((volume) => volume.duration <= 21.6)).toBe(true);
  });

  it('splits a merged clip longer than a volume limit', () => {
    const plan = buildClipPlan([video([100, 200, 300])], {
      ...settings,
      mergeGapSeconds: 120,
      maxVolumeHours: 0.05,
      preRollSeconds: 50,
      postRollSeconds: 50,
    });
    expect(plan.volumes.every((volume) => volume.duration <= 180)).toBe(true);
    expect(plan.volumes).toHaveLength(2);
    expect(plan.clips.map((clip) => clip.duration)).toEqual([180, 120]);
  });

  it('blocks a video when one of its marks exceeds its duration', () => {
    const plan = buildClipPlan([video([89, 700])], settings);
    expect(plan.clips).toHaveLength(0);
    expect(plan.issues[0].severity).toBe('error');
    expect(plan.issues[0].message).toContain('11:40');
  });
});

it('formats timeline values with milliseconds only when needed', () => {
  expect(formatTimestamp(89)).toBe('01:29');
  expect(formatTimestamp(89.5)).toBe('01:29.500');
});

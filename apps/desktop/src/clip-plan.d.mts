export interface VideoForPlan {
  id: string;
  name: string;
  path: string;
  duration: number;
  marks: number[];
  hasAudio?: boolean;
}

export interface ClipSettings {
  preRollSeconds: number;
  postRollSeconds: number;
  mergeGapSeconds: number;
  maxVolumeHours: number;
}

export interface PlannedClip {
  id: string;
  videoId: string;
  videoName: string;
  videoPath: string;
  start: number;
  end: number;
  duration: number;
  killTimes: number[];
  audio: boolean;
}

export interface PlanIssue {
  videoId?: string;
  videoName?: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface PlannedVolume {
  number: number;
  duration: number;
  clips: PlannedClip[];
}

export interface ClipPlan {
  clips: PlannedClip[];
  volumes: PlannedVolume[];
  issues: PlanIssue[];
  totalSeconds: number;
  totalKills: number;
  filesWithMarks: number;
}

export function parseTimeToken(
  token: string,
): { error: string; value: string } | { seconds: number; value: string };

export function parseTimestampList(input: string): {
  values: number[];
  errors: Array<{ value: string; message: string }>;
  duplicates: string[];
};

export function buildClipPlan(
  videos: VideoForPlan[],
  settings: ClipSettings,
): ClipPlan;

export function formatTimestamp(seconds: number): string;

export interface OutputClip extends PlannedClip {
  outputStart: number;
  outputEnd: number;
}

export function buildOutputTimeline(
  volumes: PlannedVolume[],
  limit: number,
): { clips: OutputClip[]; duration: number; volumeStarts: number[] };

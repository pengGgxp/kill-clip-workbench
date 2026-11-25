import type {
  ClipSettings,
  VideoForPlan,
} from '../../../../desktop/src/clip-plan.mjs';

export interface Video extends VideoForPlan {
  width: number;
  height: number;
  fps: number;
  error: string;
  url: string;
}

export interface Settings extends ClipSettings {
  resolution: '1080p' | '720p';
}

export interface RenderResult {
  folder: string;
  report: string;
  volumes: {
    number: number;
    duration: number;
    status: 'waiting' | 'running' | 'success' | 'failed' | 'cancelled';
    percent: number;
    detail: string;
    name?: string;
    url?: string;
  }[];
}

export interface Project {
  name: string;
  videos: Video[];
  settings: Settings;
  outputDirectory: string;
  result: RenderResult | null;
}

type ProjectState = { project: Project; projectFile?: string };

interface Desktop {
  project(): Promise<ProjectState & { cleanup: Video[] }>;
  newProject(name: string): Promise<ProjectState>;
  openProject(): Promise<ProjectState | null>;
  saveProject(): Promise<null | string>;
  update(data: {
    settings?: Settings;
    marks?: { id: string; values: number[] };
    remove?: string;
  }): Promise<void>;
  importFiles(): Promise<Project>;
  importDirectory(): Promise<Project>;
  importDrop(files: File[]): Promise<Project>;
  locate(id: string): Promise<Project>;
  outputDirectory(): Promise<null | string>;
  startExport(): Promise<{ result: RenderResult }>;
  waitExport(): Promise<RenderResult>;
  cancelExport(): Promise<void>;
  reveal(): Promise<string | undefined>;
  recycle(): Promise<{
    project: Project;
    recycled: string[];
    errors: string[];
  }>;
  onProgress(callback: (state: RenderResult) => void): () => void;
}

export const desktop = (window as Window & { clipWorkbench?: Desktop })
  .clipWorkbench;
export const initialSettings: Settings = {
  preRollSeconds: 5,
  postRollSeconds: 5,
  mergeGapSeconds: 8,
  maxVolumeHours: 1,
  resolution: '1080p',
};

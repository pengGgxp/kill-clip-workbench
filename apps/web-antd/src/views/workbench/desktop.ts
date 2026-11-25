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
  motionBlur: boolean;
  resolution: '720p' | '1080p' | 'source';
}

export interface RenderResult {
  folder: string;
  report: string;
  volumes: {
    number: number;
    duration: number;
    status: 'cancelled' | 'failed' | 'running' | 'success' | 'waiting';
    percent: number;
    detail: string;
    name?: string;
    width?: number;
    height?: number;
    url?: string;
  }[];
}

export interface Project {
  name: string;
  videos: Video[];
  settings: Settings;
  outputDirectory: string;
  result: null | RenderResult;
}

type ProjectState = { project: Project; projectFile?: string };

export interface SaveState {
  status: 'restore-failed' | 'save-failed' | 'saved' | 'saving' | 'unsaved';
  detail?: string;
}

export interface ImportProgress {
  completed: number;
  current: string;
  total: number;
}

interface Desktop {
  project(): Promise<ProjectState & { cleanup: Video[]; saveState: SaveState }>;
  newProject(name: string): Promise<ProjectState>;
  openProject(): Promise<null | ProjectState>;
  saveProject(): Promise<null | string>;
  retrySave(): Promise<void>;
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
  onImportProgress(callback: (progress: ImportProgress) => void): () => void;
  onProgress(callback: (state: RenderResult) => void): () => void;
  onSaveState(callback: (state: SaveState) => void): () => void;
}

export const desktop = (window as Window & { clipWorkbench?: Desktop })
  .clipWorkbench;
export const initialSettings: Settings = {
  preRollSeconds: 5,
  postRollSeconds: 5,
  mergeGapSeconds: 8,
  maxVolumeHours: 1,
  motionBlur: false,
  resolution: 'source',
};

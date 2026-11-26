<script lang="ts" setup>
import type { ComponentPublicInstance } from 'vue';

import type {
  ImportProgress,
  Mix,
  Project,
  RenderResult,
  SaveState,
  Settings,
  Video,
} from './desktop';

import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  shallowReactive,
  watch,
} from 'vue';

import {
  Clapperboard,
  Download,
  FilePlus2,
  Film,
  FolderOpen,
  FolderSearch,
  Fullscreen,
  MinusCircle,
  Pause,
  Pencil,
  Play,
  Plus,
  Save,
  Trash2,
} from '@vben/icons';

import {
  Alert,
  App,
  Button,
  Checkbox,
  Collapse,
  CollapsePanel,
  Empty,
  Form,
  FormItem,
  Input,
  InputNumber,
  Modal,
  Progress,
  Segmented,
  Select,
  Space,
  Spin,
  Table,
  TabPane,
  Tabs,
  Tag,
  Tooltip,
} from 'ant-design-vue';

import {
  buildClipPlan,
  buildOutputTimeline,
  formatTimestamp,
  parseTimestampList,
} from '../../../../desktop/src/clip-plan.mjs';
import { desktop, initialMix, initialSettings } from './desktop';
import MusicTimeline from './music-timeline.vue';
import Timeline from './timeline.vue';

const { message } = App.useApp();
const project = ref<Project>({
  name: '未命名项目',
  videos: [],
  settings: { ...initialSettings },
  mix: { ...initialMix },
  music: null,
  outputDirectory: '',
  result: null,
});
const projectFile = ref<string>();
const cleanup = ref<Video[]>([]);
const selected = ref('');
const sourcePlayer = ref<HTMLVideoElement>();
const outputPlayers = shallowReactive<Array<HTMLVideoElement | undefined>>([]);
const outputSlots = ref<Array<undefined | { url: string; time: number }>>([]);
const outputSlot = ref(0);
const outputPlayerRefs = [0, 1].map(
  (slot) => (element: ComponentPublicInstance | Element | null) => {
    bindOutputPlayer(
      slot,
      element instanceof HTMLVideoElement ? element : null,
    );
  },
);
const stage = ref<HTMLElement>();
const musicPlayer = ref<HTMLAudioElement>();
const musicPlaybackError = ref(false);
const position = ref(0);
const playing = ref(false);
const playerReady = ref(false);
const previousLevels = {
  sourceVolume: initialMix.sourceVolume,
  musicVolume: initialMix.musicVolume,
};
let videoAdvancing = false;
let musicFrame = 0;
const playbackError = ref(false);
const previewMode = ref<'output' | 'source'>('source');
const outputPreviewPosition = ref(0);
const outputPlayRequested = ref(false);
const player = computed(() =>
  previewMode.value === 'output'
    ? outputPlayers[outputSlot.value]
    : sourcePlayer.value,
);
const draft = ref('');
const inputError = ref('');
const edit = ref<number>();
const editValue = ref('');
const editError = ref('');
const busy = ref(false);
const rendering = ref(false);
const saveState = ref<SaveState>({ status: 'unsaved' });
const pendingSettings = ref(0);
const dragging = ref(false);
const importProgress = ref<ImportProgress>();
const newOpen = ref(false);
const newName = ref('');
const exportOpen = ref(false);
const cleanupOpen = ref(false);
const preview = ref<RenderResult['volumes'][number]>();
const resultPlaybackError = ref(false);
const panel = ref('plan');
const exportStarted = ref(false);

const active = computed(() =>
  project.value.videos.find(({ id }) => id === selected.value),
);
const canPlay = computed(() => playerReady.value && !playbackError.value);
const exportProgressPercent = computed(() => {
  const volumes = project.value.result?.volumes ?? [];
  const totalDuration = volumes.reduce(
    (total, volume) => total + volume.duration,
    0,
  );
  if (totalDuration <= 0) return 0;
  return Math.floor(
    volumes.reduce(
      (total, volume) => total + volume.duration * volume.percent,
      0,
    ) / totalDuration,
  );
});
const exportProgressDescription = computed(() => {
  if (!exportStarted.value) return '正在准备导出任务';
  const volume = project.value.result?.volumes.find(
    ({ status }) => status === 'running',
  );
  if (volume)
    return `${volume.name || `第 ${volume.number} 卷`} · ${volume.detail || '正在处理'}`;
  return '正在准备下一卷';
});
const videoAspectRatio = computed(() => {
  if (
    previewMode.value === 'output' &&
    project.value.settings.resolution !== 'source'
  )
    return '16 / 9';
  const dimensions = stageDimensions.value;
  return dimensions?.width && dimensions.height
    ? `${dimensions.width} / ${dimensions.height}`
    : '16 / 9';
});
const resolutionHint = computed(() => {
  const dimensions = new Set(
    project.value.videos
      .filter(({ marks, width, height }) => marks.length > 0 && width && height)
      .map(({ width, height }) => `${width}×${height}`),
  );
  if (dimensions.size > 0 && dimensions.size < 2)
    return `输出尺寸：${[...dimensions][0]}`;
  if (dimensions.size > 1) return '每卷按首段素材设置尺寸，其余画面等比适配';
  return '每卷按首段素材的原始尺寸输出';
});
const plan = computed(() =>
  buildClipPlan(project.value.videos, project.value.settings),
);
const activeRanges = computed(() =>
  plan.value.clips.filter(({ videoId }) => videoId === active.value?.id),
);
const outputTimeline = computed(() =>
  buildOutputTimeline(
    plan.value.volumes,
    project.value.settings.maxVolumeHours * 3600,
  ),
);
function outputClipAt(time: number) {
  const clips = outputTimeline.value.clips;
  let left = 0;
  let right = clips.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    const clip = clips[middle];
    if (clip && time < clip.outputEnd) right = middle;
    else left = middle + 1;
  }
  return clips[Math.min(left, clips.length - 1)];
}
const outputPreviewClip = computed(() =>
  outputClipAt(outputPreviewPosition.value),
);
const videosById = computed(
  () => new Map(project.value.videos.map((video) => [video.id, video])),
);
const stageVideo = computed(() =>
  previewMode.value === 'output'
    ? videosById.value.get(outputPreviewClip.value?.videoId ?? '')
    : active.value,
);
const stageDimensions = computed(() => {
  if (previewMode.value === 'source') return active.value;
  const volumeStart = outputTimeline.value.volumeStarts.findLast(
    (start) => start <= outputPreviewPosition.value,
  );
  const firstClip =
    volumeStart === undefined ? undefined : outputClipAt(volumeStart);
  return videosById.value.get(firstClip?.videoId ?? '');
});
const outputPlanKey = computed(() =>
  JSON.stringify(
    outputTimeline.value.clips.map(({ videoId, start, outputEnd }) => [
      videoId,
      start,
      outputEnd,
    ]),
  ),
);
const previewModes = [
  { label: '素材预览', value: 'source' },
  { label: '成片预览', value: 'output' },
];
const canExport = computed(
  () =>
    plan.value.volumes.length > 0 &&
    !plan.value.issues.some(({ severity }) => severity === 'error'),
);
const locked = computed(() => busy.value || rendering.value);
const unsentMarks = computed(
  () =>
    draft.value.trim().length > 0 ||
    (edit.value !== undefined &&
      editValue.value.trim() !== formatTimestamp(edit.value)),
);
const saveIndicator = computed(() => {
  const { status, detail } = saveState.value;
  if (!desktop) return { label: '网页预览' };
  if (pendingSettings.value || status === 'saving')
    return { label: '正在保存', color: 'processing' };
  if (status === 'save-failed')
    return { label: '保存失败', color: 'error', detail };
  if (status === 'restore-failed')
    return { label: '恢复失败', color: 'error', detail };
  if (busy.value) return { label: '处理中' };
  if (unsentMarks.value) return { label: '标记待提交', color: 'warning' };
  return { label: status === 'saved' ? '已自动保存' : '尚未保存' };
});
const columns = [
  { title: '素材', key: 'source' },
  { title: '状态', key: 'status', width: 83 },
];
const clipColumns = [
  { title: '源视频', dataIndex: 'videoName', key: 'source', ellipsis: true },
  { title: '保留区间', key: 'range', width: 200 },
  { title: '时长', key: 'duration', width: 90 },
  { title: '击杀点', key: 'marks', width: 86 },
];
const statuses = {
  waiting: '等待',
  running: '处理中',
  success: '校验通过',
  failed: '失败',
  cancelled: '已取消',
};
const settingsFields = [
  { key: 'preRollSeconds', label: '前保留（秒）', min: 0, max: 3600, step: 1 },
  { key: 'postRollSeconds', label: '后保留（秒）', min: 0, max: 3600, step: 1 },
  {
    key: 'mergeGapSeconds',
    label: '合并间隔（秒）',
    min: 0,
    max: 3600,
    step: 1,
  },
  {
    key: 'maxVolumeHours',
    label: '单卷上限（小时）',
    min: 0.001,
    max: 24,
    step: 0.001,
  },
] as const;

function errorText(error: unknown) {
  return String(error instanceof Error ? error.message : error).replace(
    /^Error invoking remote method '[^']+': Error: /,
    '',
  );
}

function selectVideo(id: string) {
  setPreviewMode('source');
  if (selected.value === id) return;
  player.value?.pause();
  stopMusicPreview();
  selected.value = id;
  position.value = 0;
  playing.value = false;
  playerReady.value = false;
  playbackError.value = false;
  draft.value = '';
  inputError.value = '';
  edit.value = undefined;
}

function applyProject(value: Project) {
  if (value.createdAt !== project.value.createdAt) {
    previousLevels.sourceVolume = initialMix.sourceVolume;
    previousLevels.musicVolume = initialMix.musicVolume;
  }
  project.value = value;
  if (!value.videos.some(({ id }) => id === selected.value))
    selectVideo(value.videos[0]?.id ?? '');
}

async function action(operation: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  try {
    await operation();
  } catch (error) {
    message.error(errorText(error));
  } finally {
    busy.value = false;
  }
}

async function loadProject(api: NonNullable<typeof desktop>) {
  const state = await api.project();
  applyProject(state.project);
  projectFile.value = state.projectFile;
  cleanup.value = state.cleanup;
  saveState.value = state.saveState ?? { status: 'unsaved' };
}

let unsubscribe: (() => void) | undefined;
onMounted(() => {
  if (!desktop) return;
  const api = desktop;
  const unsubscribeProgress = api.onProgress((result) => {
    exportStarted.value = true;
    project.value.result = result;
  });
  const unsubscribeImportProgress = api.onImportProgress((progress) => {
    importProgress.value = progress;
  });
  const unsubscribeSaveState = api.onSaveState?.((state) => {
    saveState.value = state;
  });
  unsubscribe = () => {
    unsubscribeProgress();
    unsubscribeImportProgress();
    unsubscribeSaveState?.();
  };
  void action(async () => {
    try {
      await loadProject(api);
    } catch (error) {
      saveState.value = { status: 'restore-failed', detail: errorText(error) };
      throw error;
    }
  });
});
onUnmounted(() => {
  unsubscribe?.();
  stopMusicPreview();
});

function importMedia(kind: 'directory' | 'drop' | 'files', files: File[] = []) {
  if (!desktop || locked.value) return;
  const api = desktop;
  void action(async () => {
    importProgress.value = undefined;
    try {
      const importers = {
        directory: api.importDirectory,
        drop: () => api.importDrop(files),
        files: api.importFiles,
      };
      const response = await importers[kind]();
      const count = response.videos.length - project.value.videos.length;
      applyProject(response);
      if (count > 0) message.success(`已添加 ${count} 条素材`);
      else if (kind === 'drop')
        message.warning('没有可添加的视频，或素材已在列表中');
    } finally {
      importProgress.value = undefined;
    }
  });
}

function onDrop(event: DragEvent) {
  dragging.value = false;
  importMedia('drop', [...(event.dataTransfer?.files ?? [])]);
}

function useProject(mode: 'new' | 'open' | 'save') {
  if (!desktop || locked.value) return;
  const api = desktop;
  void action(async () => {
    if (mode === 'save') {
      const file = await api.saveProject();
      if (file) {
        projectFile.value = file;
        message.success('项目文件已保存');
      }
      return;
    }
    const opened = mode === 'open' ? await api.openProject() : undefined;
    const state = mode === 'new' ? await api.newProject(newName.value) : opened;
    if (!state) return;
    selectVideo('');
    applyProject(state.project);
    projectFile.value = state.projectFile;
    cleanup.value = opened?.cleanup ?? [];
    newOpen.value = false;
    panel.value = 'plan';
  });
}

function retrySave() {
  if (!desktop || locked.value) return;
  const api = desktop;
  void action(async () => {
    await api.retrySave();
    await loadProject(api);
  });
}

function setMarks(values: number[]) {
  if (!desktop || !active.value || locked.value) return;
  const api = desktop;
  const video = active.value;
  const next = [...new Set(values)].toSorted((a, b) => a - b);
  void action(async () => {
    video.marks = next;
    cleanup.value = [];
    draft.value = '';
    inputError.value = '';
    edit.value = undefined;
    await api.update({ marks: { id: video.id, values: next } });
  });
}

function submitMarks(text: string, replacing?: number) {
  const video = active.value;
  if (!video || video.error) return;
  const parsed = parseTimestampList(text);
  const outOfBounds = parsed.values.filter((value) => value > video.duration);
  const errors = [
    ...parsed.errors.map(({ value, message: reason }) => `${value}：${reason}`),
    ...outOfBounds.map((value) => `${formatTimestamp(value)} 超出视频时长`),
  ];
  if (parsed.values.length === 0 && errors.length === 0)
    errors.push('请输入时间点');
  if (replacing !== undefined && parsed.values.length !== 1)
    errors.push('请输入一个时间点');
  if (replacing === undefined) inputError.value = errors.join('；');
  else editError.value = errors.join('；');
  if (errors.length > 0) return;
  const existing = video.marks.filter((value) => value !== replacing);
  const duplicates =
    parsed.duplicates.length +
    parsed.values.filter((value) => existing.includes(value)).length;
  if (duplicates) message.warning(`已忽略 ${duplicates} 个重复时间点`);
  setMarks([...existing, ...parsed.values]);
}

async function jump(id: string, time: number) {
  selectVideo(id);
  await nextTick();
  const element = player.value;
  if (!element) return;
  if (element.readyState) seek(time);
  else
    element.addEventListener(
      'loadedmetadata',
      () => {
        if (player.value === element) seek(time);
      },
      { once: true },
    );
}

function syncPlayer(event: Event) {
  const element = event.currentTarget as HTMLVideoElement;
  if (!isStagePlayer(element)) return;
  playing.value = !element.paused && !element.ended;
  if (previewMode.value === 'source') position.value = element.currentTime;
  else if (event.type !== 'error' && syncOutputProgress(element)) return;
  if (event.type === 'playing') {
    videoAdvancing = true;
    updateMusicPreview();
  } else if (
    ['ended', 'error', 'pause', 'seeking', 'waiting'].includes(event.type)
  ) {
    stopMusicPreview();
  } else {
    syncMusic();
  }
}

function sourceLoaded(event: Event) {
  const element = event.currentTarget as HTMLVideoElement;
  if (!isStagePlayer(element)) return;
  playbackError.value = false;
  playerReady.value = true;
  element.volume = project.value.mix.sourceVolume;
  if (position.value > 0)
    element.currentTime = Math.min(position.value, element.duration);
  syncPlayer(event);
}

function isStagePlayer(element: HTMLVideoElement) {
  return (
    element === player.value &&
    element.getAttribute('src') === stageVideo.value?.url
  );
}

function playerFailed(event: Event) {
  const element = event.currentTarget as HTMLVideoElement;
  if (!isStagePlayer(element)) return;
  playbackError.value = true;
  outputPlayRequested.value = false;
  syncPlayer(event);
}

function outputPlayerFailed(event: Event) {
  const element = event.currentTarget as HTMLVideoElement;
  if (!isStagePlayer(element)) return;
  playbackError.value = true;
  outputPlayRequested.value = false;
  syncPlayer(event);
}

function seek(time: number) {
  const element = player.value;
  if (!element?.readyState || !active.value) return;
  element.pause();
  stopMusicPreview();
  element.currentTime = Math.max(
    0,
    Math.min(time, element.duration, active.value.duration),
  );
  position.value = element.currentTime;
}

function stepFrame(direction: number) {
  const video = active.value;
  const element = player.value;
  if (!canPlay.value || !video?.fps || !element) return;
  const { fps } = video;
  const duration = Math.min(element.duration, video.duration);
  const last = Math.max(0, Math.ceil(duration * fps) - 1);
  const current = Math.min(last, Math.floor(element.currentTime * fps + 0.001));
  const next = Math.max(0, Math.min(last, current + direction));
  if (next === current) {
    element.pause();
  } else {
    seek((next + 0.5) / fps);
  }
}

function togglePlayback() {
  const element = player.value;
  if (previewMode.value === 'output') {
    if (outputPlayRequested.value) {
      outputPlayRequested.value = false;
      element?.pause();
      stopMusicPreview();
    } else if (element && canPlay.value) {
      if (outputPreviewPosition.value >= outputTimeline.value.duration)
        seekOutputPreview(0, true);
      else {
        outputPlayRequested.value = true;
        playElement(element);
      }
    }
    return;
  }
  if (!element || !canPlay.value) return;
  if (element.paused) {
    playElement(element);
  } else element.pause();
}

function playElement(element: HTMLVideoElement) {
  void element.play().catch((error) => {
    if (!isStagePlayer(element) || error.name === 'AbortError') return;
    outputPlayRequested.value = false;
    message.error(errorText(error));
  });
}

function syncOutputProgress(element: HTMLVideoElement) {
  const clip = outputPreviewClip.value;
  if (!clip || !outputPlayRequested.value || element.seeking) return false;
  const time = clip.outputStart + Math.max(0, element.currentTime - clip.start);
  if (element.ended || time >= clip.outputEnd - 0.000001) {
    if (clip.outputEnd < outputTimeline.value.duration) {
      seekOutputPreview(clip.outputEnd, true);
    } else {
      outputPreviewPosition.value = outputTimeline.value.duration;
      outputPlayRequested.value = false;
      playing.value = false;
      element.pause();
      stopMusicPreview();
    }
    return true;
  }
  if (time - outputPreviewPosition.value >= 0.08)
    outputPreviewPosition.value = time;
  return false;
}

function bindOutputPlayer(slot: number, element: HTMLVideoElement | null) {
  outputPlayers[slot] = element ?? undefined;
}

function positionOutputPlayer(slot: number) {
  const element = outputPlayers[slot];
  const target = outputSlots.value[slot];
  if (
    !target ||
    !element?.readyState ||
    element.error ||
    element.getAttribute('src') !== target.url
  )
    return;
  const time = Math.min(element.duration, target.time);
  if (Math.abs(element.currentTime - time) > 0.001) element.currentTime = time;
  if (slot !== outputSlot.value) return;
  element.volume = project.value.mix.sourceVolume;
  playerReady.value = true;
  if (outputPlayRequested.value) playElement(element);
}

function prepareOutputPlayer(slot: number, url: string | undefined, time = 0) {
  const previous = outputSlots.value[slot];
  if (url === previous?.url && time === previous?.time) return;
  outputSlots.value[slot] = url ? { url, time } : undefined;
  if (url === previous?.url) positionOutputPlayer(slot);
}

function seekOutputPreview(time: number, play = false) {
  if (previewMode.value !== 'output' || !Number.isFinite(time)) return;
  const target = Math.max(0, Math.min(time, outputTimeline.value.duration));
  const clip = outputClipAt(target);
  const url = videosById.value.get(clip?.videoId ?? '')?.url;
  const sourceTime = clip
    ? clip.start +
      Math.min(
        Math.max(0, clip.outputEnd - clip.outputStart - 0.001),
        target - clip.outputStart,
      )
    : 0;
  const element = player.value;
  const standby = 1 - outputSlot.value;
  const buffered = outputPlayers[standby];
  const prepared = outputSlots.value[standby];
  const bufferedAtTarget =
    !!buffered &&
    buffered.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA &&
    !buffered.seeking &&
    Math.abs(buffered.currentTime - sourceTime) <= 0.001;
  const currentMatches = element?.getAttribute('src') === url;
  const useStandby =
    !!url &&
    prepared?.url === url &&
    !buffered?.error &&
    (!currentMatches || bufferedAtTarget);
  const ready = useStandby && bufferedAtTarget;

  if (!play || !ready) stopMusicPreview();
  if (useStandby) outputSlot.value = standby;
  element?.pause();
  outputPreviewPosition.value = target;
  outputPlayRequested.value = play && !!url;
  playing.value = play && ready;
  const current = player.value;
  const sameSource = !!url && current?.getAttribute('src') === url;
  playbackError.value = sameSource && !!current?.error;
  playerReady.value = sameSource && !!current?.readyState;
  if (playbackError.value) outputPlayRequested.value = false;
  if (url && current && !sameSource) current.pause();
  prepareOutputPlayer(outputSlot.value, url, sourceTime);
  if (sameSource && outputSlots.value[outputSlot.value]?.time === sourceTime)
    positionOutputPlayer(outputSlot.value);

  const next =
    clip && clip.outputEnd < outputTimeline.value.duration
      ? outputClipAt(clip.outputEnd)
      : undefined;
  prepareOutputPlayer(
    1 - outputSlot.value,
    videosById.value.get(next?.videoId ?? '')?.url,
    next?.start,
  );
}

function setPreviewMode(mode: 'output' | 'source') {
  if (mode === previewMode.value) return;
  player.value?.pause();
  stopMusicPreview();
  previewMode.value = mode;
  playing.value = false;
  playerReady.value = false;
  playbackError.value = false;
  outputPlayRequested.value = false;
  if (mode === 'output') seekOutputPreview(0);
  else outputSlots.value = [];
}

watch(outputPlanKey, () => seekOutputPreview(0));
watch(
  () => active.value?.url,
  () => {
    if (previewMode.value !== 'source') return;
    playerReady.value = false;
    playbackError.value = false;
  },
);

function stopMusicPreview() {
  videoAdvancing = false;
  cancelAnimationFrame(musicFrame);
  musicFrame = 0;
  musicPlayer.value?.pause();
}

function syncMusic(outputTime = outputPreviewPosition.value) {
  const element = musicPlayer.value;
  const video = player.value;
  if (
    !element?.readyState ||
    !video ||
    !project.value.music ||
    previewMode.value !== 'output'
  )
    return;
  const { musicStart, musicVolume } = project.value.mix;
  const time = outputTime - musicStart;
  if (
    time < 0 ||
    time >= Math.min(element.duration, project.value.music.duration) ||
    musicVolume === 0
  ) {
    element.pause();
    return;
  }
  if (Math.abs(element.currentTime - time) > 0.1) element.currentTime = time;
  if (
    videoAdvancing &&
    !video.paused &&
    !video.seeking &&
    !preview.value &&
    !musicPlaybackError.value
  ) {
    if (element.paused)
      void element.play().catch((error) => {
        if (musicPlayer.value === element && error.name !== 'AbortError')
          musicPlaybackError.value = true;
      });
  } else element.pause();
}

function musicLoaded() {
  syncMusic();
}

function updateMusicPreview() {
  if (musicFrame || previewMode.value !== 'output') return;
  const tick = () => {
    musicFrame = 0;
    const element = player.value;
    if (!videoAdvancing || !element || !isStagePlayer(element)) return;
    if (syncOutputProgress(element)) return;
    const clip = outputPreviewClip.value;
    if (clip)
      syncMusic(
        clip.outputStart + Math.max(0, element.currentTime - clip.start),
      );
    if (videoAdvancing) musicFrame = requestAnimationFrame(tick);
  };
  musicFrame = requestAnimationFrame(tick);
}

watch(
  () => project.value.music?.url,
  () => {
    musicPlaybackError.value = false;
    if (videoAdvancing) updateMusicPreview();
  },
  { flush: 'post' },
);

watch([player, () => project.value.mix.sourceVolume], ([element, value]) => {
  if (element) element.volume = value;
});

watch(
  [musicPlayer, () => project.value.mix.musicVolume],
  ([element, value]) => {
    if (element) element.volume = value;
  },
);

watch([() => project.value.mix.musicStart, outputTimeline], () => syncMusic());
watch(preview, (result) => {
  resultPlaybackError.value = false;
  if (result) {
    outputPlayRequested.value = false;
    player.value?.pause();
    stopMusicPreview();
  }
});

function setMix(key: keyof Mix, value: number) {
  project.value.mix = { ...project.value.mix, [key]: value };
}

async function saveMix(key: keyof Mix, value: number) {
  if (!desktop || locked.value) return;
  setMix(key, value);
  if (key !== 'musicStart' && value > 0) previousLevels[key] = value;
  cleanup.value = [];
  pendingSettings.value += 1;
  try {
    await desktop.update({ mix: { ...project.value.mix } });
  } catch (error) {
    message.error(errorText(error));
  } finally {
    pendingSettings.value -= 1;
  }
}

function muteMix(key: 'musicVolume' | 'sourceVolume') {
  const value = project.value.mix[key];
  if (value > 0) previousLevels[key] = value;
  void saveMix(key, value > 0 ? 0 : previousLevels[key]);
}

function chooseMusic(remove = false) {
  if (!desktop || locked.value) return;
  const api = desktop;
  outputPlayRequested.value = false;
  player.value?.pause();
  stopMusicPreview();
  void action(async () => {
    const state = await api.music(remove);
    if (state) {
      applyProject(state.project);
      cleanup.value = state.cleanup;
    }
  });
}

function fullscreen() {
  const element = stage.value;
  if (!element) return;
  const operation = document.fullscreenElement
    ? document.exitFullscreen()
    : element.requestFullscreen();
  void operation.catch((error) => message.error(errorText(error)));
}

function quickMark() {
  if (!active.value || !player.value?.readyState) return;
  const time =
    Math.min(
      Math.round(player.value.currentTime * 1000),
      Math.floor(active.value.duration * 1000),
    ) / 1000;
  submitMarks(formatTimestamp(time));
}

async function updateSettings<K extends keyof Settings>(
  key: K,
  value: null | Settings[K],
) {
  if (!desktop || value === null || locked.value) return;
  const settings = { ...project.value.settings, [key]: value };
  project.value.settings = settings;
  cleanup.value = [];
  pendingSettings.value += 1;
  try {
    await desktop.update({ settings });
  } catch (error) {
    message.error(errorText(error));
  } finally {
    pendingSettings.value -= 1;
  }
}

function changeVideo(id: string, locate: boolean) {
  if (!desktop || locked.value) return;
  const api = desktop;
  void action(async () => {
    if (locate) {
      applyProject(await api.locate(id));
      playbackError.value = false;
    } else {
      await api.update({ remove: id });
      project.value.videos = project.value.videos.filter(
        (video) => video.id !== id,
      );
      if (id === selected.value) selectVideo(project.value.videos[0]?.id ?? '');
    }
    cleanup.value = [];
  });
}

function chooseOutput() {
  if (!desktop || locked.value) return;
  const api = desktop;
  void action(async () => {
    const folder = await api.outputDirectory();
    if (folder) project.value.outputDirectory = folder;
  });
}

async function render() {
  if (!desktop || locked.value || !canExport.value) return;
  rendering.value = true;
  exportStarted.value = false;
  panel.value = 'result';
  exportOpen.value = false;
  cleanup.value = [];
  try {
    const { result } = await desktop.startExport();
    project.value.result = result;
    exportStarted.value = true;
    project.value.result = await desktop.waitExport();
    const state = await desktop.project();
    cleanup.value = state.cleanup;
    if (cleanup.value.length > 0) message.success('全部成片已通过校验');
  } catch (error) {
    message.error(errorText(error));
  } finally {
    rendering.value = false;
  }
}

function recycle() {
  if (!desktop || locked.value) return;
  const api = desktop;
  void action(async () => {
    const result = await api.recycle();
    applyProject(result.project);
    const state = await api.project();
    cleanup.value = state.cleanup;
    cleanupOpen.value = false;
    if (result.recycled.length > 0)
      message.success(`已回收 ${result.recycled.length} 个源视频`);
    for (const error of result.errors) message.error(error);
  });
}
</script>

<template>
  <div
    class="workbench"
    @dragover.prevent="dragging = true"
    @dragleave.self="dragging = false"
    @drop.prevent="onDrop"
  >
    <header class="toolbar">
      <div class="identity">
        <span class="app-icon"><Clapperboard /></span>
        <div>
          <h1>击杀点剪辑工作台</h1>
          <p :title="projectFile">{{ project.name }}</p>
        </div>
      </div>
      <Space wrap :size="8" class="actions">
        <Tag :color="saveIndicator.color" :title="saveIndicator.detail">
          {{ saveIndicator.label }}
        </Tag>
        <Button
          v-if="saveState.status === 'save-failed'"
          :disabled="locked || pendingSettings > 0"
          @click="retrySave"
        >
          重试保存
        </Button>
        <Button
          :disabled="!desktop || locked"
          @click="
            newName = '';
            newOpen = true;
          "
        >
          <template #icon><FilePlus2 /></template>新建
        </Button>
        <Button :disabled="!desktop || locked" @click="useProject('open')">
          <template #icon><FolderOpen /></template>打开
        </Button>
        <Button :disabled="!desktop || locked" @click="useProject('save')">
          <template #icon><Save /></template>保存项目
        </Button>
        <Button
          :disabled="!desktop || locked || !canExport"
          type="primary"
          @click="exportOpen = true"
        >
          <template #icon><Download /></template>批量导出
        </Button>
      </Space>
    </header>

    <main class="content">
      <div class="editor">
        <section
          class="materials"
          :class="{ dragging }"
          aria-labelledby="materials-title"
        >
          <div class="section-head">
            <h2 id="materials-title">源素材</h2>
            <Tag>{{ project.videos.length }} 条</Tag>
          </div>
          <div class="import-actions">
            <Button
              type="primary"
              :disabled="!desktop || locked"
              @click="importMedia('files')"
            >
              <template #icon><Plus /></template>添加视频
            </Button>
            <Button
              :disabled="!desktop || locked"
              @click="importMedia('directory')"
            >
              <template #icon><FolderSearch /></template>扫描目录
            </Button>
          </div>
          <div
            v-if="project.videos.length"
            class="materials-list"
            role="region"
            aria-label="素材列表"
            tabindex="0"
          >
            <Table
              :columns="columns"
              :data-source="project.videos"
              :pagination="false"
              row-key="id"
              size="small"
              table-layout="fixed"
              :row-class-name="
                (row: Video) => (row.id === selected ? 'selected-row' : '')
              "
            >
              <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'source'">
                  <Button
                    type="link"
                    class="source-name"
                    :title="record.path"
                    @click="selectVideo(record.id)"
                  >
                    {{ record.name }}
                  </Button>
                  <div class="source-meta">
                    {{
                      record.error
                        ? '素材不可用'
                        : `${formatTimestamp(record.duration)} · ${record.width}×${record.height}`
                    }}
                  </div>
                </template>
                <template v-if="column.key === 'status'">
                  <Tag
                    :color="
                      record.error
                        ? 'error'
                        : record.marks.length
                          ? 'processing'
                          : 'default'
                    "
                  >
                    {{
                      record.error
                        ? '异常'
                        : record.marks.length
                          ? `${record.marks.length} 点`
                          : '未标记'
                    }}
                  </Tag>
                </template>
              </template>
            </Table>
          </div>
          <Empty
            v-else
            :image="Empty.PRESENTED_IMAGE_SIMPLE"
            :description="dragging ? '松开以导入视频' : '拖放视频到这里'"
          />
        </section>

        <section class="viewer" aria-labelledby="viewer-title">
          <div class="section-head preview-head">
            <h2 id="viewer-title" class="sr-only">预览</h2>
            <Segmented
              :value="previewMode"
              :options="previewModes"
              @change="
                (value) =>
                  setPreviewMode(value === 'output' ? 'output' : 'source')
              "
            />
            <span v-if="previewMode === 'source' && active?.fps" class="muted">
              {{ active.fps }} fps
            </span>
            <Tag v-else-if="previewMode === 'output'">导出前</Tag>
          </div>
          <div
            ref="stage"
            class="video-stage"
            :style="{ aspectRatio: videoAspectRatio }"
          >
            <template v-if="previewMode === 'source'">
              <video
                v-if="stageVideo?.url"
                ref="sourcePlayer"
                preload="metadata"
                playsinline
                :src="stageVideo.url"
                @click="togglePlayback"
                @loadedmetadata="sourceLoaded"
                @timeupdate="syncPlayer"
                @seeking="syncPlayer"
                @seeked="syncPlayer"
                @play="syncPlayer"
                @playing="syncPlayer"
                @waiting="syncPlayer"
                @pause="syncPlayer"
                @ended="syncPlayer"
                @error="playerFailed"
              ></video>
              <div v-else class="video-empty">
                <Film />
                <span>{{ active ? '素材不可预览' : '未选择视频' }}</span>
              </div>
            </template>
            <template v-else>
              <video
                v-for="slot in [0, 1]"
                :key="slot"
                :ref="outputPlayerRefs[slot]"
                :class="{
                  'output-player-active': outputSlot === slot,
                  'output-player-standby': outputSlot !== slot,
                }"
                :src="outputSlots[slot]?.url"
                preload="auto"
                playsinline
                @click="togglePlayback"
                @loadedmetadata="positionOutputPlayer(slot)"
                @loadeddata="positionOutputPlayer(slot)"
                @canplay="positionOutputPlayer(slot)"
                @timeupdate="syncPlayer"
                @seeking="syncPlayer"
                @seeked="syncPlayer"
                @play="syncPlayer"
                @playing="syncPlayer"
                @waiting="syncPlayer"
                @pause="syncPlayer"
                @ended="syncPlayer"
                @error="outputPlayerFailed"
              ></video>
              <div v-if="!stageVideo?.url" class="video-empty">
                <Film />
                <span>{{
                  outputPreviewClip ? '当前片段不可预览' : '暂无剪辑片段'
                }}</span>
              </div>
            </template>
          </div>
          <Timeline
            v-if="previewMode === 'source' && active?.url"
            :video="active"
            :position="position"
            :playing="playing"
            :volume="project.mix.sourceVolume"
            :mix-disabled="!desktop || locked"
            :ready="canPlay"
            :mark-disabled="!canPlay || locked"
            :ranges="activeRanges"
            @seek="seek"
            @step="stepFrame"
            @toggle="togglePlayback"
            @mute="muteMix('sourceVolume')"
            @volume="setMix('sourceVolume', $event)"
            @save-volume="saveMix('sourceVolume', $event)"
            @mark="quickMark"
            @fullscreen="fullscreen"
          />
          <div v-if="previewMode === 'output'" class="output-transport">
            <Tooltip :title="outputPlayRequested ? '暂停成片' : '播放成片'">
              <Button
                size="small"
                :aria-label="outputPlayRequested ? '暂停成片' : '播放成片'"
                :disabled="!canPlay && !outputPlayRequested"
                @click="togglePlayback"
              >
                <template #icon>
                  <Pause v-if="outputPlayRequested" /><Play v-else />
                </template>
              </Button>
            </Tooltip>
            <span class="time">
              {{ formatTimestamp(outputPreviewPosition) }} /
              {{ formatTimestamp(outputTimeline.duration) }}
            </span>
            <span
              class="output-current muted"
              :title="outputPreviewClip?.videoName"
            >
              {{ outputPreviewClip?.videoName }}
            </span>
            <Tooltip title="全屏预览">
              <Button
                size="small"
                type="text"
                aria-label="全屏预览"
                :disabled="!canPlay"
                @click="fullscreen"
              >
                <template #icon><Fullscreen /></template>
              </Button>
            </Tooltip>
          </div>
          <MusicTimeline
            v-if="previewMode === 'output'"
            :clips="outputTimeline.clips"
            :duration="outputTimeline.duration"
            :position="outputPreviewPosition"
            :music="project.music"
            :mix="project.mix"
            :disabled="!desktop || locked"
            :playback-error="musicPlaybackError"
            @choose="chooseMusic()"
            @remove="chooseMusic(true)"
            @seek="seekOutputPreview"
            @start="saveMix('musicStart', $event)"
            @mute="muteMix('musicVolume')"
            @volume="setMix('musicVolume', $event)"
            @save-volume="saveMix('musicVolume', $event)"
            @mute-source="muteMix('sourceVolume')"
            @source-volume="setMix('sourceVolume', $event)"
            @save-source-volume="saveMix('sourceVolume', $event)"
          />
          <audio
            v-if="project.music?.url"
            :key="project.music.url"
            ref="musicPlayer"
            :src="project.music.url"
            preload="auto"
            @loadedmetadata="musicLoaded"
            @error="musicPlaybackError = true"
          ></audio>
          <div v-if="previewMode === 'source' && active" class="source-details">
            <span :title="active.path">{{ active.path }}</span>
            <Space :size="4">
              <Tooltip title="重新定位">
                <Button
                  type="text"
                  aria-label="重新定位"
                  :disabled="locked"
                  @click="changeVideo(active.id, true)"
                >
                  <template #icon><FolderOpen /></template>
                </Button>
              </Tooltip>
              <Tooltip title="从列表移除">
                <Button
                  type="text"
                  aria-label="从列表移除"
                  :disabled="locked"
                  @click="changeVideo(active.id, false)"
                >
                  <template #icon><MinusCircle /></template>
                </Button>
              </Tooltip>
            </Space>
          </div>
          <Alert
            v-if="(previewMode === 'source' && active?.error) || playbackError"
            type="warning"
            show-icon
            :message="
              previewMode === 'output'
                ? '当前片段无法播放。可在时间轴选择其他片段，或导出后查看成片。'
                : active?.error ||
                  '播放器无法打开此编码，仍可用时间戳标记和导出。'
            "
          />
        </section>

        <aside class="inspector" aria-label="标记与设置">
          <div class="section-head">
            <h2>击杀标记</h2>
            <Tag>{{ active?.marks.length ?? 0 }} 点</Tag>
          </div>
          <Form layout="vertical" @submit="submitMarks(draft)">
            <FormItem
              label="批量时间戳"
              html-for="kill-timestamps"
              :help="inputError || undefined"
              :validate-status="inputError ? 'error' : undefined"
            >
              <Input.TextArea
                id="kill-timestamps"
                v-model:value="draft"
                :rows="2"
                :disabled="!active || !!active.error || locked"
                placeholder="1:29  1:45  00:02:03.500"
                @change="inputError = ''"
              />
            </FormItem>
            <Button
              html-type="submit"
              :disabled="!active || !!active.error || !draft.trim() || locked"
            >
              <template #icon><Plus /></template>添加标记
            </Button>
          </Form>
          <div v-if="active?.marks.length" class="markers">
            <div v-for="mark in active.marks" :key="mark" class="marker">
              <template v-if="edit === mark">
                <Input
                  v-model:value="editValue"
                  aria-label="编辑时间点"
                  size="small"
                  :status="editError ? 'error' : undefined"
                  @press-enter="submitMarks(editValue, mark)"
                />
                <Button
                  size="small"
                  :disabled="locked"
                  @click="submitMarks(editValue, mark)"
                >
                  保存
                </Button>
                <Button size="small" @click="edit = undefined">取消</Button>
                <span v-if="editError" class="edit-error">{{ editError }}</span>
              </template>
              <template v-else>
                <Button
                  type="link"
                  class="time"
                  :disabled="!active.url"
                  @click="jump(active.id, mark)"
                >
                  {{ formatTimestamp(mark) }}
                </Button>
                <Space :size="0">
                  <Tooltip title="编辑标记">
                    <Button
                      type="text"
                      size="small"
                      aria-label="编辑标记"
                      :disabled="locked || !!active.error"
                      @click="
                        edit = mark;
                        editValue = formatTimestamp(mark);
                        editError = '';
                      "
                    >
                      <template #icon><Pencil /></template>
                    </Button>
                  </Tooltip>
                  <Tooltip title="删除标记">
                    <Button
                      type="text"
                      size="small"
                      aria-label="删除标记"
                      :disabled="locked"
                      @click="
                        setMarks(active.marks.filter((value) => value !== mark))
                      "
                    >
                      <template #icon><Trash2 /></template>
                    </Button>
                  </Tooltip>
                </Space>
              </template>
            </div>
          </div>
          <div v-else class="marker-empty muted">暂无标记</div>

          <div class="section-head settings-head"><h2>剪辑设置</h2></div>
          <Form layout="vertical" class="settings">
            <FormItem
              v-for="field in settingsFields"
              :key="field.key"
              :label="field.label"
              :html-for="field.key"
            >
              <InputNumber
                :id="field.key"
                :min="field.min"
                :max="field.max"
                :step="field.step"
                :disabled="!desktop || locked"
                :value="project.settings[field.key]"
                @change="
                  (value) =>
                    typeof value === 'number' &&
                    updateSettings(field.key, value)
                "
              />
            </FormItem>
            <FormItem label="输出规格" html-for="resolution" class="resolution">
              <Select
                id="resolution"
                :value="project.settings.resolution"
                :disabled="!desktop || locked"
                :options="[
                  { value: '1080p', label: '1080p · 1920×1080' },
                  { value: '720p', label: '720p · 1280×720' },
                  { value: 'source', label: '跟随素材原始分辨率' },
                ]"
                @change="
                  (value) =>
                    (value === '1080p' ||
                      value === '720p' ||
                      value === 'source') &&
                    updateSettings('resolution', value)
                "
              />
              <span
                v-if="project.settings.resolution === 'source'"
                class="resolution-hint"
                >{{ resolutionHint }}</span>
            </FormItem>
            <FormItem class="motion-blur">
              <Checkbox
                :checked="project.settings.motionBlur"
                :disabled="!desktop || locked"
                @change="
                  (event) => updateSettings('motionBlur', event.target.checked)
                "
              >
                运动模糊
              </Checkbox>
            </FormItem>
          </Form>
        </aside>
      </div>

      <div
        v-if="busy && importProgress"
        class="import-progress"
        role="status"
        aria-live="polite"
      >
        <div class="import-progress-head">
          <strong>正在扫描素材</strong>
          <span class="time">{{ importProgress.completed }} / {{ importProgress.total }}</span>
        </div>
        <Progress
          :percent="
            importProgress.total
              ? Math.floor(
                  (importProgress.completed / importProgress.total) * 100,
                )
              : 0
          "
          :show-info="false"
          size="small"
          status="active"
        />
        <span class="import-progress-file">{{
          importProgress.current
            ? `正在识别：${importProgress.current}`
            : '识别完成，正在保存项目'
        }}</span>
      </div>

      <section class="plan-section" aria-label="剪辑计划与导出">
        <Tabs v-model:active-key="panel">
          <TabPane key="plan" tab="剪辑计划">
            <div class="metrics">
              <span>已标记素材 <strong>{{ plan.filesWithMarks }}</strong></span><span>击杀点 <strong>{{ plan.totalKills }}</strong></span><span>片段 <strong>{{ plan.clips.length }}</strong></span><span>预计总时长
                <strong class="time">{{
                  formatTimestamp(plan.totalSeconds)
                }}</strong></span><span>导出卷 <strong>{{ plan.volumes.length }}</strong></span>
            </div>
            <Alert
              v-if="plan.issues.length"
              :type="
                plan.issues.some(({ severity }) => severity === 'error')
                  ? 'error'
                  : 'warning'
              "
              show-icon
              class="issues"
            >
              <template #message>{{ plan.issues.length }} 条素材提示</template>
              <template #description>
                <ul>
                  <li v-for="(issue, index) in plan.issues" :key="index">
                    <Button
                      v-if="issue.videoId"
                      size="small"
                      type="link"
                      @click="selectVideo(issue.videoId)"
                    >
                      {{ issue.videoName }}
</Button>{{ issue.message }}
                  </li>
                </ul>
              </template>
            </Alert>
            <Empty
              v-if="!plan.volumes.length"
              :image="Empty.PRESENTED_IMAGE_SIMPLE"
              description="暂无可导出的片段"
            />
            <Collapse v-else :default-active-key="['1']" class="volumes">
              <CollapsePanel
                v-for="volume in plan.volumes"
                :key="String(volume.number)"
                :header="`第 ${volume.number} 卷 · ${formatTimestamp(volume.duration)} · ${volume.clips.length} 段`"
              >
                <Table
                  :columns="clipColumns"
                  :data-source="volume.clips"
                  :pagination="
                    volume.clips.length > 12 ? { pageSize: 12 } : false
                  "
                  :scroll="{ x: 560 }"
                  row-key="id"
                  size="small"
                >
                  <template #bodyCell="{ column, record }">
                    <Button
                      v-if="column.key === 'range'"
                      class="time"
                      type="link"
                      @click="jump(record.videoId, record.start)"
                    >
                      {{ formatTimestamp(record.start) }} –
                      {{ formatTimestamp(record.end) }}
                    </Button>
                    <span v-if="column.key === 'duration'" class="time">{{
                      formatTimestamp(record.duration)
                    }}</span>
                    <span
                      v-if="column.key === 'marks'"
                      :title="record.killTimes.map(formatTimestamp).join('、')"
                      >{{ record.killTimes.length }}</span>
                  </template>
                </Table>
              </CollapsePanel>
            </Collapse>
          </TabPane>
          <TabPane key="result" tab="导出结果">
            <div
              v-if="rendering"
              class="export-progress"
              role="status"
              aria-live="polite"
            >
              <div class="export-progress-head">
                <strong>{{ exportProgressDescription }}</strong>
                <span>{{ exportProgressPercent }}%</span>
              </div>
              <Progress
                :percent="exportProgressPercent"
                :show-info="false"
                size="small"
                status="active"
              />
            </div>
            <Empty
              v-if="!project.result && !rendering"
              :image="Empty.PRESENTED_IMAGE_SIMPLE"
              description="暂无导出记录"
            />
            <template
              v-else-if="project.result && (!rendering || exportStarted)"
            >
              <div class="result-toolbar">
                <span :title="project.result.report" class="output-path">{{
                  project.result.folder
                }}</span>
                <Space wrap>
                  <Button v-if="rendering" @click="desktop?.cancelExport()">
                    取消导出
                  </Button>
                  <Button
                    :disabled="!desktop || rendering"
                    @click="
                      action(async () => {
                        const error = await desktop?.reveal();
                        if (error) throw new Error(error);
                      })
                    "
                  >
                    打开输出目录
                  </Button>
                  <Button
                    danger
                    :disabled="!cleanup.length || locked"
                    @click="cleanupOpen = true"
                  >
                    清理源素材
                  </Button>
                </Space>
              </div>
              <div
                v-for="volume in project.result.volumes"
                :key="volume.number"
                class="result-row"
              >
                <span>{{ volume.name || `第 ${volume.number} 卷` }}</span><Tag
                  :color="
                    volume.status === 'failed'
                      ? 'error'
                      : volume.status === 'success'
                        ? 'success'
                        : 'default'
                  "
                >
                  {{ statuses[volume.status] }}
                </Tag>
                <Progress
                  :percent="volume.percent"
                  :status="
                    volume.status === 'failed'
                      ? 'exception'
                      : volume.status === 'running'
                        ? 'active'
                        : undefined
                  "
                  size="small"
                />
                <span
                  v-if="volume.width && volume.height"
                  class="volume-size muted"
                  >{{ volume.width }}×{{ volume.height }}</span>
                <span class="time">{{ formatTimestamp(volume.duration) }}</span>
                <Button v-if="volume.url" type="link" @click="preview = volume">
                  查看已导出成片
                </Button>
                <span
                  v-if="volume.detail"
                  class="result-detail"
                  :class="{ 'edit-error': volume.status === 'failed' }"
                  >{{ volume.detail }}</span>
              </div>
            </template>
          </TabPane>
        </Tabs>
      </section>
    </main>

    <Modal
      v-model:open="newOpen"
      title="新建剪辑项目"
      ok-text="新建"
      cancel-text="取消"
      :confirm-loading="busy"
      @ok="useProject('new')"
    >
      <Form layout="vertical" @submit="useProject('new')">
        <FormItem label="项目名称" html-for="project-name">
          <Input
            id="project-name"
            v-model:value="newName"
            placeholder="未命名项目"
            :maxlength="100"
          />
        </FormItem>
      </Form>
    </Modal>
    <Modal
      v-model:open="exportOpen"
      title="批量导出"
      ok-text="开始导出"
      cancel-text="取消"
      :confirm-loading="rendering"
      :ok-button-props="{ disabled: !project.outputDirectory || locked }"
      @ok="render"
    >
      <p>
        {{ plan.volumes.length }} 卷 MP4 · {{ project.settings.resolution }} ·
        {{ formatTimestamp(plan.totalSeconds) }}
      </p>
      <Form layout="vertical">
        <FormItem label="输出目录" html-for="output-directory">
          <Space.Compact block>
            <Input
              id="output-directory"
              :value="project.outputDirectory"
              readonly
            /><Button :disabled="locked" @click="chooseOutput">
              选择目录
            </Button>
          </Space.Compact>
        </FormItem>
      </Form>
    </Modal>
    <Modal
      v-model:open="cleanupOpen"
      title="清理已处理素材"
      ok-text="检查并确认"
      cancel-text="取消"
      :ok-button-props="{ danger: true }"
      :confirm-loading="busy"
      @ok="recycle"
    >
      <Alert type="warning" show-icon message="以下源视频将移入系统回收站" />
      <ul class="cleanup-files">
        <li v-for="source in cleanup" :key="source.id" :title="source.path">
          {{ source.path }}
        </li>
      </ul>
    </Modal>
    <Modal
      :open="!!preview"
      :title="preview?.name"
      :footer="null"
      width="800px"
      @cancel="preview = undefined"
    >
      <video
        v-if="preview?.url"
        :src="preview.url"
        class="result-player"
        controls
        autoplay
        @error="resultPlaybackError = true"
      ></video>
      <Alert
        v-if="resultPlaybackError"
        type="warning"
        show-icon
        message="无法播放此导出文件。请在输出目录确认文件是否仍然存在。"
      />
    </Modal>
    <div v-if="busy" class="busy-indicator" role="status" aria-label="处理中">
      <Spin size="small" />
    </div>
  </div>
</template>

<style scoped>
.workbench {
  min-height: 100vh;
  color: hsl(var(--foreground));
  background: hsl(var(--background-deep));
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: center;
  justify-content: space-between;
  padding: 12px 24px;
  background: hsl(var(--background));
  border-bottom: 1px solid hsl(var(--border));
}

.identity {
  display: flex;
  gap: 12px;
  align-items: center;
  min-width: 0;
}

.app-icon {
  display: grid;
  flex: 0 0 38px;
  place-items: center;
  height: 38px;
  font-size: 20px;
  color: white;
  background: #1677ff;
  border-radius: 8px;
}

h1,
h2,
p {
  margin: 0;
}

h1 {
  font-size: 17px;
  font-weight: 650;
  line-height: 24px;
}

.identity p {
  font-size: 12px;
  color: hsl(var(--muted-foreground));
  overflow-wrap: anywhere;
}

.actions :deep(.ant-tag) {
  margin-inline-end: 0;
}

.content {
  max-width: 1800px;
  padding: 18px 24px;
  margin-inline: auto;
}

.import-progress {
  display: grid;
  gap: 4px;
  padding: 8px 24px 10px;
  background: hsl(var(--background));
  border-bottom: 1px solid hsl(var(--border));
}

.import-progress-head,
.export-progress-head {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
}

.import-progress-file {
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
  color: hsl(var(--muted-foreground));
  white-space: nowrap;
}

.editor {
  display: grid;
  grid-template-columns: minmax(230px, 1fr) minmax(0, 2.15fr) minmax(
      270px,
      1fr
    );
  background: hsl(var(--background));
  border: 1px solid hsl(var(--border));
  border-radius: 8px;
}

.editor > * {
  min-width: 0;
  min-height: 0;
  padding: 16px;
}

.editor > * + * {
  border-left: 1px solid hsl(var(--border));
}

.section-head {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

h2 {
  font-size: 14px;
  font-weight: 650;
}

.section-head :deep(.ant-tag) {
  margin-inline-end: 0;
}

.materials {
  display: grid;
  grid-template-rows: max-content max-content minmax(min(240px, 38vh), 1fr);
}

.import-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.materials-list {
  /* The preview and settings determine the row height, not the file count. */
  contain: size;
  overflow: auto;
  scrollbar-gutter: stable;
}

.materials-list:focus-visible {
  outline: 2px solid hsl(var(--primary));
  outline-offset: -2px;
}

.materials-list :deep(.ant-table-thead > tr > th) {
  position: sticky;
  top: 0;
  z-index: 1;
}

.materials.dragging {
  outline: 2px dashed #1677ff;
  outline-offset: -4px;
}

.source-name {
  display: block;
  min-width: 0;
  max-width: 100%;
  padding: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: left;
}

.source-meta {
  font-size: 12px;
  color: hsl(var(--muted-foreground));
}

.materials :deep(.selected-row > td) {
  background: hsl(var(--accent));
}

.video-stage {
  position: relative;
  display: grid;
  place-items: center;
  width: 100%;
  min-height: 160px;
  max-height: max(160px, 51vh);
  overflow: hidden;
  background: #15181d;
  border-radius: 6px;
}

.video-stage video {
  display: block;
  width: 100%;
  height: 100%;
  min-height: 0;
  object-fit: contain;
}

.video-stage > video.output-player-standby {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  opacity: 0;
}

.video-stage:fullscreen {
  max-height: none;
  background: #000;
  border-radius: 0;
}

.preview-head,
.output-transport {
  flex-wrap: wrap;
}

.output-transport {
  display: flex;
  gap: 6px 10px;
  align-items: center;
  min-height: 36px;
  margin-top: 6px;
  font-size: 12px;
}

.output-current {
  flex: 1 1 90px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.video-empty {
  display: grid;
  gap: 10px;
  justify-items: center;
  font-size: 13px;
  color: #b1bac8;
}

.video-empty svg {
  width: 28px;
  height: 28px;
}

.time {
  font-variant-numeric: tabular-nums;
}

.muted {
  color: hsl(var(--muted-foreground));
}

.source-details {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
  margin-top: 12px;
}

.source-details > span,
.output-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-details > span {
  font-size: 12px;
  color: hsl(var(--muted-foreground));
}

.inspector :deep(.ant-form-item) {
  margin-bottom: 8px;
}

.inspector :deep(.ant-form-item-label) {
  padding-bottom: 3px;
}

.markers {
  max-height: 180px;
  margin-top: 10px;
  overflow: auto;
  border-top: 1px solid hsl(var(--border));
}

.marker {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
  justify-content: space-between;
  min-height: 34px;
  border-bottom: 1px solid hsl(var(--border));
}

.marker :deep(.ant-input) {
  flex: 1 1 90px;
  width: 0;
}

.edit-error {
  color: #d4380d;
  overflow-wrap: anywhere;
}

.marker-empty {
  margin-top: 10px;
  font-size: 12px;
}

.settings-head {
  padding-top: 12px;
  margin-top: 14px;
  border-top: 1px solid hsl(var(--border));
}

.settings {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 8px;
}

.settings :deep(.ant-input-number) {
  width: 100%;
}

.resolution,
.motion-blur {
  grid-column: 1 / -1;
}

.resolution-hint {
  display: block;
  margin-top: 4px;
  font-size: 11px;
  line-height: 16px;
  color: hsl(var(--muted-foreground));
}

.plan-section {
  padding-bottom: 12px;
  margin-top: 16px;
  border-top: 1px solid hsl(var(--border));
}

.metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 26px;
  padding: 4px 0 12px;
  font-size: 13px;
  color: hsl(var(--muted-foreground));
}

.metrics strong {
  margin-left: 6px;
  color: hsl(var(--foreground));
}

.issues {
  margin-bottom: 12px;
}

.issues ul {
  max-height: 140px;
  overflow: auto;
}

.volumes {
  margin-top: 6px;
}

.result-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.export-progress {
  display: grid;
  gap: 8px;
  padding: 12px;
  margin-bottom: 16px;
  background: hsl(var(--background));
  border: 1px solid hsl(var(--border));
  border-radius: 6px;
}

.result-row {
  display: grid;
  grid-template-columns:
    minmax(100px, max-content) max-content minmax(80px, 1fr) max-content
    max-content max-content;
  gap: 6px 12px;
  align-items: center;
  padding: 10px 0;
  border-bottom: 1px solid hsl(var(--border));
}

.result-detail {
  grid-column: 1 / -1;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.volume-size {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.cleanup-files {
  max-height: 40vh;
  overflow: auto;
  overflow-wrap: anywhere;
}

.result-player {
  display: block;
  width: 100%;
}

.busy-indicator {
  position: fixed;
  right: 14px;
  bottom: 10px;
}

.actions :deep(.ant-btn svg),
.editor :deep(.ant-btn svg) {
  display: inline-block;
  width: 1em;
  height: 1em;
  vertical-align: -0.14em;
}

@media (max-width: 1050px) {
  .editor {
    grid-template-columns: minmax(215px, 1fr) minmax(0, 2fr);
  }

  .editor > .inspector {
    grid-column: 1 / -1;
    border-top: 1px solid hsl(var(--border));
    border-left: 0;
  }

  .settings {
    grid-template-columns: repeat(5, minmax(0, 1fr));
  }

  .resolution {
    grid-column: auto;
  }
}

@media (max-width: 620px) {
  .toolbar,
  .content {
    padding-inline: 12px;
  }

  .editor {
    grid-template-columns: minmax(0, 1fr);
  }

  .editor > * + * {
    border-top: 1px solid hsl(var(--border));
    border-left: 0;
  }

  .materials-list {
    max-block-size: min(40vh, 360px);
    contain: none;
  }

  .materials {
    grid-template-rows: max-content max-content auto;
  }

  .settings {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .resolution {
    grid-column: 1 / -1;
  }

  .result-row {
    grid-template-columns: minmax(0, 1fr) max-content;
  }
}
</style>

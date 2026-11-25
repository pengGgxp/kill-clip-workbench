<script lang="ts" setup>
import type {
  ImportProgress,
  Project,
  RenderResult,
  SaveState,
  Settings,
  Video,
} from './desktop';

import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';

import {
  Clapperboard,
  Crosshair,
  Download,
  FilePlus2,
  Film,
  FolderOpen,
  FolderSearch,
  MinusCircle,
  Pencil,
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
  formatTimestamp,
  parseTimestampList,
} from '../../../../desktop/src/clip-plan.mjs';
import { desktop, initialSettings } from './desktop';

const { message } = App.useApp();
const project = ref<Project>({
  name: '未命名项目',
  videos: [],
  settings: { ...initialSettings },
  outputDirectory: '',
  result: null,
});
const projectFile = ref<string>();
const cleanup = ref<Video[]>([]);
const selected = ref('');
const player = ref<HTMLVideoElement>();
const position = ref(0);
const playbackError = ref(false);
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
const panel = ref('plan');
const exportStarted = ref(false);

const active = computed(() =>
  project.value.videos.find(({ id }) => id === selected.value),
);
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
const videoAspectRatio = computed(() =>
  active.value?.width && active.value?.height
    ? `${active.value.width} / ${active.value.height}`
    : '16 / 9',
);
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
  if (selected.value === id) return;
  selected.value = id;
  position.value = 0;
  playbackError.value = false;
  draft.value = '';
  inputError.value = '';
  edit.value = undefined;
}

function applyProject(value: Project) {
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
onUnmounted(() => unsubscribe?.());

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
    const state =
      mode === 'new'
        ? await api.newProject(newName.value)
        : await api.openProject();
    if (!state) return;
    selectVideo('');
    applyProject(state.project);
    projectFile.value = state.projectFile;
    cleanup.value = [];
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
  if (element.readyState) element.currentTime = time;
  else
    element.addEventListener(
      'loadedmetadata',
      () => {
        element.currentTime = time;
      },
      { once: true },
    );
  element.focus({ preventScroll: true });
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
          <Space wrap class="import-actions">
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
          </Space>
          <Table
            v-if="project.videos.length"
            :columns="columns"
            :data-source="project.videos"
            :pagination="false"
            :scroll="{ y: 425 }"
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
          <Empty
            v-else
            :image="Empty.PRESENTED_IMAGE_SIMPLE"
            :description="dragging ? '松开以导入视频' : '拖放视频到这里'"
          />
        </section>

        <section class="viewer" aria-labelledby="viewer-title">
          <div class="section-head">
            <h2 id="viewer-title">素材预览</h2>
            <span v-if="active?.fps" class="muted">{{ active.fps }} fps</span>
          </div>
          <div class="video-stage" :style="{ aspectRatio: videoAspectRatio }">
            <video
              v-if="active?.url"
              :key="active.url"
              ref="player"
              controls
              preload="metadata"
              tabindex="0"
              :src="active.url"
              @timeupdate="position = player?.currentTime ?? 0"
              @error="playbackError = true"
            ></video>
            <div v-else class="video-empty">
              <Film /><span>{{ active ? '素材不可预览' : '未选择视频' }}</span>
            </div>
          </div>
          <div class="transport">
            <span class="time">{{ formatTimestamp(position) }}
              <span class="muted">/ {{ formatTimestamp(active?.duration ?? 0) }}</span></span>
            <Button
              :disabled="!active?.url || playbackError || locked"
              @click="quickMark"
            >
              <template #icon><Crosshair /></template>标记当前位置
            </Button>
          </div>
          <div v-if="active" class="source-details">
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
            v-if="active?.error || playbackError"
            type="warning"
            show-icon
            :message="
              active?.error || '播放器无法打开此编码，仍可用时间戳标记和导出。'
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
                  播放成片
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
      ></video>
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

.import-actions {
  margin-bottom: 12px;
}

.materials :deep(.ant-table-wrapper) {
  margin-top: 12px;
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
  display: grid;
  place-items: center;
  min-height: 160px;
  overflow: hidden;
  background: #15181d;
  border-radius: 6px;
}

.video-stage video {
  display: block;
  width: 100%;
  height: auto;
  max-height: 58vh;
  object-fit: contain;
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

.transport,
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
  margin-top: -6px;
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

  .settings {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .resolution {
    grid-column: 1 / -1;
  }

  .result-row {
    grid-template-columns: minmax(0, 1fr) max-content;
  }

  .transport {
    flex-wrap: wrap;
  }
}
</style>

<script lang="ts" setup>
import type { Video } from './desktop';

import { computed, ref, watch } from 'vue';

import {
  Crosshair,
  Film,
  Fullscreen,
  Pause,
  Play,
  StepBack,
  StepForward,
  Volume2,
  VolumeX,
} from '@vben/icons';

import { Button, Tooltip } from 'ant-design-vue';

import { formatTimestamp } from '../../../../desktop/src/clip-plan.mjs';
import LevelSlider from './level-slider.vue';
import TimelineScrollbar from './timeline-scrollbar.vue';
import TimelineZoom from './timeline-zoom.vue';
import { useTimelineViewport } from './use-timeline-viewport';
import Waveform from './waveform.vue';

const props = defineProps<{
  video: Video;
  position: number;
  playing: boolean;
  volume: number;
  mixDisabled: boolean;
  ready: boolean;
  markDisabled: boolean;
  ranges: { start: number; end: number }[];
}>();

const emit = defineEmits<{
  seek: [time: number];
  step: [direction: number];
  toggle: [];
  mute: [];
  volume: [value: number];
  saveVolume: [value: number];
  mark: [];
  fullscreen: [];
}>();

const tracks = ref<HTMLElement>();
const pointer = ref<number>();

const duration = computed(() => props.video.duration);
const {
  end,
  endPan,
  manuallyPanned,
  maxStart,
  minSpan,
  movePan,
  onWheel,
  pan,
  percent,
  reset,
  setStart,
  span,
  start,
  startPan,
  ticks,
  timeAt,
  zoom,
} = useTimelineViewport(duration, tracks);
const frame = computed(() =>
  Math.min(
    Math.max(0, Math.ceil(duration.value * props.video.fps) - 1),
    Math.floor(props.position * props.video.fps + 0.001),
  ),
);
const currentTime = computed(() => {
  const time = formatTimestamp(props.position);
  const precise = time.includes('.') ? time : `${time}.000`;
  return duration.value >= 3600 && precise.length === 9
    ? `00:${precise}`
    : precise;
});
const visibleMarks = computed(() =>
  props.video.marks.filter((mark) => mark >= start.value && mark <= end.value),
);
const visibleRanges = computed(() =>
  props.ranges
    .filter((range) => range.start < end.value && range.end > start.value)
    .map((range) => {
      const left = Math.max(range.start, start.value);
      const right = Math.min(range.end, end.value);
      return {
        key: range.start,
        left: percent(left),
        width: percent(right) - percent(left),
      };
    }),
);
watch(
  () => props.video.url,
  () => {
    reset();
    pointer.value = undefined;
  },
  { immediate: true },
);

watch(
  () => props.position,
  (position) => {
    if (pointer.value !== undefined || (manuallyPanned.value && props.playing))
      return;
    if (position < start.value || position > end.value)
      setStart(position - span.value * 0.2);
  },
);

function seek(time: number) {
  manuallyPanned.value = false;
  emit('seek', time);
}

function scrub(event: PointerEvent) {
  seek(timeAt(event.clientX));
}

function startScrub(event: PointerEvent) {
  if (!props.ready || event.button !== 0 || pointer.value !== undefined) return;
  const target = event.currentTarget as HTMLElement;
  target.focus({ preventScroll: true });
  target.setPointerCapture(event.pointerId);
  pointer.value = event.pointerId;
  scrub(event);
}

function stopScrub(event: PointerEvent) {
  if (pointer.value === event.pointerId) pointer.value = undefined;
}

function startRulerPan(event: PointerEvent) {
  if (props.ready && event.isPrimary && event.button === 0)
    tracks.value?.focus({ preventScroll: true });
  startPan(event);
}

function finishPan(event: PointerEvent) {
  const time = endPan(event);
  if (time !== undefined && props.ready) seek(time);
}

function onKey(event: KeyboardEvent) {
  if (
    !props.ready ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  )
    return;
  switch (event.key) {
    case 'ArrowLeft':
    case 'ArrowRight': {
      emit('step', event.key === 'ArrowLeft' ? -1 : 1);
      break;
    }
    case 'Home':
    case 'End': {
      seek(event.key === 'Home' ? 0 : duration.value);
      break;
    }
    case ' ': {
      if (!event.repeat) emit('toggle');
      break;
    }
    default: {
      return;
    }
  }
  event.preventDefault();
}
</script>

<template>
  <section class="timeline" aria-label="剪辑时间轴">
    <div class="timeline-toolbar">
      <div class="timeline-time">
        <strong>{{ currentTime }}</strong>
        <span>/ {{ formatTimestamp(duration) }}</span>
        <span v-if="video.fps" class="frame-number">第 {{ frame + 1 }} 帧</span>
      </div>
      <div class="timeline-buttons" role="group" aria-label="播放控制">
        <Tooltip title="上一帧（时间轴 ←）">
          <Button
            size="small"
            type="text"
            aria-label="上一帧"
            :disabled="!ready || !video.fps"
            @click="emit('step', -1)"
          >
            <template #icon><StepBack /></template>
          </Button>
        </Tooltip>
        <Tooltip :title="playing ? '暂停（时间轴空格）' : '播放（时间轴空格）'">
          <Button
            size="small"
            :aria-label="playing ? '暂停' : '播放'"
            :disabled="!ready"
            @click="emit('toggle')"
          >
            <template #icon><Pause v-if="playing" /><Play v-else /></template>
          </Button>
        </Tooltip>
        <Tooltip title="下一帧（时间轴 →）">
          <Button
            size="small"
            type="text"
            aria-label="下一帧"
            :disabled="!ready || !video.fps"
            @click="emit('step', 1)"
          >
            <template #icon><StepForward /></template>
          </Button>
        </Tooltip>
        <Tooltip title="标记当前位置">
          <Button
            size="small"
            type="text"
            aria-label="标记当前位置"
            :disabled="markDisabled"
            @click="emit('mark')"
          >
            <template #icon><Crosshair /></template>
          </Button>
        </Tooltip>
        <Tooltip title="全屏预览">
          <Button
            size="small"
            type="text"
            aria-label="全屏预览"
            :disabled="!ready"
            @click="emit('fullscreen')"
          >
            <template #icon><Fullscreen /></template>
          </Button>
        </Tooltip>
      </div>
      <TimelineZoom
        :can-zoom-in="span > minSpan"
        :can-zoom-out="maxStart > 0"
        @zoom="zoom($event, position)"
      />
    </div>

    <div class="timeline-grid">
      <div class="track-labels">
        <div class="ruler-label">轨道</div>
        <div class="video-label"><Film />视频</div>
        <div class="audio-label">
          <span>原声</span>
          <Tooltip :title="volume === 0 ? '恢复素材原声' : '静音素材原声'">
            <Button
              size="small"
              type="text"
              aria-label="静音素材原声"
              :aria-pressed="volume === 0"
              :disabled="mixDisabled"
              @click="emit('mute')"
            >
              <template #icon>
                <VolumeX v-if="volume === 0 || !video.hasAudio" /><Volume2
                  v-else
                />
              </template>
            </Button>
          </Tooltip>
        </div>
      </div>
      <div
        ref="tracks"
        class="track-area"
        :class="{ scrubbable: ready }"
        role="slider"
        aria-label="播放位置"
        :aria-disabled="!ready"
        :tabindex="ready ? 0 : -1"
        :aria-valuenow="position"
        :aria-valuemin="0"
        :aria-valuemax="Math.max(position, duration)"
        :aria-valuetext="formatTimestamp(position)"
        @keydown="onKey"
        @wheel="pointer === undefined && onWheel($event)"
        @pointerdown="startScrub"
        @pointermove="pointer === $event.pointerId && scrub($event)"
        @pointerup="stopScrub"
        @pointercancel="stopScrub"
        @lostpointercapture="stopScrub"
      >
        <div
          class="ruler"
          :class="{ pannable: maxStart > 0 }"
          aria-hidden="true"
          @pointerdown.stop="startRulerPan"
          @pointermove="movePan"
          @pointerup="finishPan"
          @pointercancel="endPan"
          @lostpointercapture="endPan"
        >
          <span
            v-for="tick in ticks"
            :key="tick.time"
            class="tick"
            :style="{ left: `${tick.left}%` }"
            >{{ tick.label }}</span>
        </div>
        <div class="video-track" aria-hidden="true">
          <div class="video-strip">
            <span
              v-for="range in visibleRanges"
              :key="range.key"
              class="clip-range"
              :style="{ left: `${range.left}%`, width: `${range.width}%` }"
            ></span>
            <span
              v-for="mark in visibleMarks"
              :key="mark"
              class="kill-marker"
              :style="{ left: `${percent(mark)}%` }"
            ></span>
            <span class="strip-name">{{ video.name }}</span>
          </div>
        </div>
        <div class="audio-track" :class="{ 'audio-muted': volume === 0 }">
          <Waveform
            v-if="video.hasAudio"
            :media="video"
            :from="start"
            :span="span"
            color="#53b9a0"
          />
          <span v-else class="track-message">无音轨</span>
        </div>
        <div
          v-if="position >= start && position <= end"
          class="playhead"
          :style="{ left: `${Math.min(99.9, percent(position))}%` }"
          aria-hidden="true"
        ></div>
      </div>
      <TimelineScrollbar
        label="素材时间轴横向滚动"
        :start="start"
        :span="span"
        :max="maxStart"
        @pan="pan"
      />
    </div>
    <div class="timeline-footer">
      <div class="volume-control">
        <span>原声音量</span>
        <LevelSlider
          label="原声音量"
          :level="volume"
          :disabled="mixDisabled"
          @change="emit('volume', $event)"
          @commit="emit('saveVolume', $event)"
        />
        <span>{{ Math.round(volume * 100) }}%</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.timeline {
  margin-top: 8px;
  overflow: hidden;
  background: hsl(var(--background));
  border: 1px solid hsl(var(--border));
  border-radius: 6px;
}

.timeline-toolbar,
.timeline-footer {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  align-items: center;
  min-height: 36px;
  padding: 4px 8px;
}

.timeline-time {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
  align-items: center;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.timeline-time > span,
.timeline-footer,
.track-message,
.ruler {
  color: hsl(var(--muted-foreground));
}

.timeline-time strong {
  font-size: 13px;
}

.frame-number {
  min-width: 76px;
}

.timeline-buttons {
  display: flex;
  gap: 2px;
  align-items: center;
}

.timeline-buttons :deep(.ant-btn),
.audio-label :deep(.ant-btn) {
  display: inline-grid;
  place-items: center;
  width: 26px;
  height: 26px;
}

.timeline-buttons :deep(svg),
.track-labels svg,
.audio-label :deep(svg) {
  width: 14px;
  height: 14px;
  vertical-align: middle;
}

.timeline-grid {
  display: grid;
  grid-template-columns: 70px minmax(0, 1fr);
  border-block: 1px solid hsl(var(--border));
}

.track-labels {
  border-right: 1px solid hsl(var(--border));
}

.track-labels > div {
  display: flex;
  gap: 5px;
  align-items: center;
  padding-inline: 7px;
  font-size: 12px;
}

.ruler,
.track-labels > .ruler-label {
  height: 24px;
}

.video-track,
.video-label {
  height: 36px;
  border-top: 1px solid hsl(var(--border));
}

.audio-track,
.audio-label {
  height: 43px;
  border-top: 1px solid hsl(var(--border));
}

.track-area {
  position: relative;
  min-width: 0;
  overflow: hidden;
  user-select: none;
}

.track-area:focus-visible {
  outline: 2px solid hsl(var(--primary));
  outline-offset: -2px;
}

.scrubbable {
  touch-action: none;
  cursor: ew-resize;
}

.ruler {
  position: relative;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.ruler.pannable {
  cursor: grab;
}

.ruler.pannable:active {
  cursor: grabbing;
}

.tick {
  position: absolute;
  bottom: 0;
  height: 20px;
  padding-left: 4px;
  white-space: nowrap;
  border-left: 1px solid hsl(var(--border));
}

.video-track {
  display: grid;
  align-items: center;
}

.video-strip {
  position: relative;
  min-width: 0;
  height: 24px;
  overflow: hidden;
  background: hsl(var(--primary) / 16%);
  border-block: 1px solid hsl(var(--primary) / 35%);
}

.strip-name {
  position: relative;
  display: block;
  padding: 3px 8px 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
  white-space: nowrap;
}

.clip-range,
.kill-marker,
.playhead {
  position: absolute;
  top: 0;
  bottom: 0;
}

.clip-range {
  background: hsl(var(--primary) / 30%);
}

.kill-marker {
  width: 2px;
  background: #ebac49;
}

.audio-track {
  display: grid;
  grid-template-rows: minmax(0, 1fr);
  grid-template-columns: minmax(0, 1fr);
  align-items: center;
  background: hsl(var(--muted) / 45%);
}

.audio-muted :deep(canvas) {
  opacity: 0.4;
}

.track-message {
  padding-left: 8px;
  font-size: 12px;
}

.playhead {
  z-index: 1;
  width: 1px;
  pointer-events: none;
  background: hsl(var(--primary));
}

.playhead::before {
  position: absolute;
  left: -4px;
  width: 9px;
  height: 8px;
  content: '';
  background: inherit;
  clip-path: polygon(0 0, 100% 0, 100% 50%, 50% 100%, 0 50%);
}

.timeline-footer {
  min-height: 32px;
  font-size: 12px;
}

.volume-control {
  display: grid;
  grid-template-columns: max-content minmax(55px, 80px) 34px;
  gap: 8px;
  align-items: center;
}
</style>

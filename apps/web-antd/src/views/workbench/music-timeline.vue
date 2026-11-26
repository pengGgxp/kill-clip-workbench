<script lang="ts" setup>
import type { OutputClip } from '../../../../desktop/src/clip-plan.mjs';
import type { Mix, Music } from './desktop';

import { computed, ref, watch } from 'vue';

import { Music2, Plus, Trash2, Volume2, VolumeX } from '@vben/icons';

import { Button, InputNumber, Tooltip } from 'ant-design-vue';

import { formatTimestamp } from '../../../../desktop/src/clip-plan.mjs';
import LevelSlider from './level-slider.vue';
import TimelineScrollbar from './timeline-scrollbar.vue';
import TimelineZoom from './timeline-zoom.vue';
import { useTimelineViewport } from './use-timeline-viewport';
import Waveform from './waveform.vue';

const props = defineProps<{
  clips: OutputClip[];
  duration: number;
  position?: number;
  music: Music | null;
  mix: Mix;
  disabled: boolean;
  playbackError: boolean;
}>();

const emit = defineEmits<{
  choose: [];
  remove: [];
  seek: [position: number];
  start: [position: number];
  volume: [value: number];
  saveVolume: [value: number];
  mute: [];
  muteSource: [];
  sourceVolume: [value: number];
  saveSourceVolume: [value: number];
}>();

const track = ref<HTMLElement>();
const drag = ref<{
  id: number;
  x: number;
  start: number;
  secondsPerPixel: number;
}>();
const draggingStart = ref<number>();
const clipStart = computed(() => draggingStart.value ?? props.mix.musicStart);
const duration = computed(
  () =>
    props.duration ||
    Math.max(1, props.mix.musicStart + (props.music?.duration ?? 0)),
);
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
} = useTimelineViewport(duration, track);
const musicLeft = computed(() => Math.max(clipStart.value, start.value));
const musicEnd = computed(() =>
  Math.min(clipStart.value + (props.music?.duration ?? 0), end.value),
);
const visibleMusic = computed(() =>
  Math.max(0, musicEnd.value - musicLeft.value),
);
const visibleClips = computed(() =>
  props.clips.filter(
    (clip) => clip.outputStart < end.value && clip.outputEnd > start.value,
  ),
);
const musicOutsideOutput = computed(
  () => !props.music?.duration || clipStart.value >= duration.value,
);

watch(() => Boolean(props.music), reset);
watch(
  () => props.position,
  (position) => {
    if (
      position !== undefined &&
      !manuallyPanned.value &&
      !drag.value &&
      (position < start.value || position > end.value)
    )
      setStart(position - span.value * 0.2);
  },
);

function moveStart(event: PointerEvent) {
  const state = drag.value;
  if (state?.id !== event.pointerId) return;
  const next = state.start + (event.clientX - state.x) * state.secondsPerPixel;
  draggingStart.value =
    Math.round(Math.max(0, Math.min(duration.value, next)) * 1000) / 1000;
}

function startDrag(event: PointerEvent) {
  if (
    props.disabled ||
    event.button !== 0 ||
    drag.value ||
    !track.value?.clientWidth
  )
    return;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  drag.value = {
    id: event.pointerId,
    x: event.clientX,
    start: props.mix.musicStart,
    secondsPerPixel: span.value / track.value.clientWidth,
  };
}

function endDrag(event: PointerEvent) {
  if (drag.value?.id !== event.pointerId) return;
  if (event.type === 'pointerup' && draggingStart.value !== undefined)
    emit('start', draggingStart.value);
  drag.value = undefined;
  draggingStart.value = undefined;
}

function seek(time: number) {
  if (!props.duration) return;
  manuallyPanned.value = false;
  emit('seek', time);
}

function finishPan(event: PointerEvent) {
  const time = endPan(event);
  if (time !== undefined) seek(time);
}
</script>

<template>
  <section class="music-timeline" aria-label="成片时间轴与混音">
    <div class="music-toolbar">
      <h2>成片时间轴</h2>
      <Button size="small" :disabled="disabled" @click="emit('choose')">
        <template #icon><Plus /></template>{{ music ? '更换音乐' : '添加音乐' }}
      </Button>
      <Tooltip v-if="music" title="移除背景音乐">
        <Button
          size="small"
          type="text"
          aria-label="移除背景音乐"
          :disabled="disabled"
          @click="emit('remove')"
        >
          <template #icon><Trash2 /></template>
        </Button>
      </Tooltip>
      <span v-if="music" class="music-name" :title="music.path">{{
        music.name
      }}</span>
      <TimelineZoom
        v-if="duration > 1"
        prefix="配乐"
        :can-zoom-in="span > minSpan"
        :can-zoom-out="maxStart > 0"
        @zoom="zoom($event, position)"
      />
    </div>
    <p
      v-if="music && (music.error || playbackError)"
      role="status"
      class="music-error"
    >
      {{ music.error || '该音频无法在预览中播放' }}
    </p>
    <div class="music-grid">
      <div class="music-labels" aria-hidden="true">
        <div>成片</div>
        <div>片段</div>
        <div><Music2 />配乐</div>
      </div>
      <div
        ref="track"
        class="music-tracks"
        @wheel="!drag && onWheel($event)"
        @click="seek(timeAt($event.clientX))"
      >
        <div
          class="music-ruler"
          :class="{ pannable: maxStart > 0 }"
          aria-hidden="true"
          @pointerdown="startPan"
          @pointermove="movePan"
          @pointerup="finishPan"
          @pointercancel="endPan"
          @lostpointercapture="endPan"
          @click.stop
        >
          <span
            v-for="tick in ticks"
            :key="tick.time"
            :style="{ left: `${tick.left}%` }"
          >
            {{ tick.label }}
          </span>
        </div>
        <div class="output-track">
          <button
            v-for="clip in visibleClips"
            :key="clip.id"
            type="button"
            class="output-clip"
            :style="{
              left: `${percent(Math.max(start, clip.outputStart))}%`,
              width: `${percent(Math.min(end, clip.outputEnd)) - percent(Math.max(start, clip.outputStart))}%`,
            }"
            :title="`${clip.videoName} · ${formatTimestamp(clip.outputStart)}`"
            @click.stop="seek(clip.outputStart)"
          >
            {{ clip.videoName }}
          </button>
          <span v-if="!clips.length" class="track-empty">暂无保留片段</span>
        </div>
        <div class="music-track">
          <div
            v-if="music?.url"
            v-show="visibleMusic > 0 || drag"
            class="music-clip"
            :class="{ 'music-muted': mix.musicVolume === 0 }"
            :style="{
              left: `${Math.min(100, percent(musicLeft))}%`,
              width: `${(visibleMusic / span) * 100}%`,
            }"
            :title="`${music.name} · ${formatTimestamp(clipStart)}`"
            @pointerdown="startDrag"
            @pointermove="moveStart"
            @pointerup="endDrag"
            @pointercancel="endDrag"
            @lostpointercapture="endDrag"
            @click.stop
          >
            <Waveform
              :media="music"
              :from="musicLeft - clipStart"
              :span="visibleMusic"
              color="#c48536"
            />
          </div>
          <span
            v-if="!music || music.error || musicOutsideOutput"
            class="track-empty"
            >{{
              !music
                ? '无配乐'
                : music.error
                  ? '配乐不可用'
                  : '配乐起点超出成片'
            }}</span>
        </div>
        <div
          v-if="position !== undefined && position >= start && position <= end"
          class="music-playhead"
          :style="{ left: `${Math.min(99.9, percent(position))}%` }"
          aria-hidden="true"
        ></div>
      </div>
      <TimelineScrollbar
        label="配乐时间轴横向滚动"
        :start="start"
        :span="span"
        :max="maxStart"
        @pan="pan"
      />
    </div>
    <div class="music-toolbar mix-controls">
      <div class="music-level">
        <Tooltip
          :title="mix.sourceVolume === 0 ? '恢复素材原声' : '静音素材原声'"
        >
          <Button
            type="text"
            size="small"
            aria-label="静音素材原声"
            :aria-pressed="mix.sourceVolume === 0"
            :disabled="disabled"
            @click="emit('muteSource')"
          >
            <template #icon>
              <VolumeX v-if="mix.sourceVolume === 0" /><Volume2 v-else />
            </template>
          </Button>
        </Tooltip>
        <span>原声音量</span>
        <LevelSlider
          label="原声音量"
          :level="mix.sourceVolume"
          :disabled="disabled"
          @change="emit('sourceVolume', $event)"
          @commit="emit('saveSourceVolume', $event)"
        />
        <span>{{ Math.round(mix.sourceVolume * 100) }}%</span>
      </div>
      <div class="music-level">
        <Tooltip :title="mix.musicVolume === 0 ? '恢复配乐音量' : '静音配乐'">
          <Button
            type="text"
            size="small"
            aria-label="静音配乐"
            :aria-pressed="mix.musicVolume === 0"
            :disabled="disabled || !music"
            @click="emit('mute')"
          >
            <template #icon>
              <VolumeX v-if="mix.musicVolume === 0" /><Volume2 v-else />
            </template>
          </Button>
        </Tooltip>
        <span>配乐音量</span>
        <LevelSlider
          label="配乐音量"
          :level="mix.musicVolume"
          :disabled="disabled || !music"
          @change="emit('volume', $event)"
          @commit="emit('saveVolume', $event)"
        />
        <span>{{ Math.round(mix.musicVolume * 100) }}%</span>
      </div>
      <label v-if="music" class="music-start" for="music-start">
        配乐起点（秒）
        <InputNumber
          id="music-start"
          size="small"
          :min="0"
          :step="0.1"
          :precision="3"
          :disabled="disabled"
          :value="clipStart"
          @change="(value) => typeof value === 'number' && emit('start', value)"
        />
      </label>
    </div>
  </section>
</template>

<style scoped>
.music-timeline {
  margin-top: 8px;
  overflow: hidden;
  border: 1px solid hsl(var(--border));
  border-radius: 6px;
}

.music-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  align-items: center;
  min-height: 36px;
  padding: 4px 8px;
}

h2 {
  font-size: 13px;
  font-weight: 650;
}

.music-toolbar :deep(.ant-btn svg) {
  display: inline-block;
  width: 14px;
  height: 14px;
  vertical-align: -0.15em;
}

.music-name,
.track-empty {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
  color: hsl(var(--muted-foreground));
  white-space: nowrap;
}

.music-name {
  flex: 1 1 110px;
}

.music-error {
  padding: 0 8px 4px;
  font-size: 12px;
  color: hsl(var(--destructive));
  overflow-wrap: anywhere;
}

.music-grid {
  display: grid;
  grid-template-columns: 70px minmax(0, 1fr);
  border-block: 1px solid hsl(var(--border));
}

.music-labels {
  border-right: 1px solid hsl(var(--border));
}

.music-labels > div {
  display: flex;
  gap: 4px;
  align-items: center;
  padding-inline: 7px;
  font-size: 12px;
}

.music-labels svg {
  width: 14px;
  height: 14px;
}

.music-tracks,
.music-ruler,
.output-track,
.music-track {
  position: relative;
  overflow: hidden;
}

.music-ruler,
.music-labels > :first-child {
  height: 24px;
}

.music-ruler {
  touch-action: none;
  user-select: none;
}

.music-ruler.pannable {
  cursor: grab;
}

.music-ruler.pannable:active {
  cursor: grabbing;
}

.output-track,
.music-labels > :nth-child(2) {
  height: 32px;
  border-top: 1px solid hsl(var(--border));
}

.music-track,
.music-labels > :last-child {
  height: 43px;
  border-top: 1px solid hsl(var(--border));
}

.music-ruler span {
  position: absolute;
  top: 3px;
  padding-inline: 3px;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: hsl(var(--muted-foreground));
  white-space: nowrap;
}

.output-clip,
.music-clip {
  position: absolute;
  overflow: hidden;
}

.output-clip {
  top: 4px;
  height: 23px;
  padding-inline: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 11px;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
  background: hsl(var(--primary) / 15%);
  box-shadow: inset 1px 0 hsl(var(--background));
}

.music-clip {
  top: 0;
  bottom: 0;
  display: grid;
  grid-template-rows: minmax(0, 1fr);
  grid-template-columns: minmax(0, 1fr);
  align-items: center;
  touch-action: none;
  cursor: grab;
  user-select: none;
  background: #ba7a2226;
  box-shadow: inset 0 0 0 1px #b5793d80;
}

.music-clip:active {
  cursor: grabbing;
}

.music-muted {
  opacity: 0.5;
}

.track-empty {
  display: block;
  padding: 5px 8px;
}

.music-playhead {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 1;
  width: 1px;
  pointer-events: none;
  background: hsl(var(--primary));
}

.mix-controls,
.music-start {
  font-size: 12px;
  color: hsl(var(--muted-foreground));
}

.music-start {
  display: inline-flex;
  gap: 6px;
  align-items: center;
}

.music-start :deep(.ant-input-number) {
  width: 94px;
}

.music-level {
  display: grid;
  grid-template-columns: 24px max-content minmax(52px, 80px) 34px;
  gap: 6px;
  align-items: center;
}
</style>

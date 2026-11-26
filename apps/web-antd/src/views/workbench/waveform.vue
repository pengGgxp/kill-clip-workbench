<script lang="ts" setup>
import type { Music, Video, Waveform } from './desktop';

import { ref, watch, watchPostEffect } from 'vue';

import { desktop } from './desktop';

const props = defineProps<{
  media: Music | Video;
  from: number;
  span: number;
  color: string;
}>();

const canvas = ref<HTMLCanvasElement>();
const width = ref(0);
const waveform = ref<Waveform>();
const failed = ref(false);

watch(
  () => props.media.url,
  async (url, _, onCleanup) => {
    failed.value = false;
    waveform.value = undefined;
    if (!desktop || !url) return;
    const api = desktop;
    let stale = false;
    onCleanup(() => {
      stale = true;
      void api.cancelWaveform(url).catch(() => {});
    });
    try {
      const data = await api.waveform(props.media.id, url);
      if (stale) return;
      waveform.value = data ?? undefined;
      failed.value = !data;
    } catch {
      if (!stale) failed.value = true;
    }
  },
  { immediate: true },
);

watch(
  canvas,
  (element, _, onCleanup) => {
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) width.value = entry.contentRect.width;
    });
    observer.observe(element);
    onCleanup(() => observer.disconnect());
  },
  { flush: 'post' },
);

watchPostEffect(() => {
  const element = canvas.value;
  const peaks = waveform.value;
  const pixels = Math.floor(width.value * window.devicePixelRatio);
  const { color, from, span } = props;
  if (!element || !peaks || !pixels || !span) return;
  element.width = pixels;
  element.height = Math.round(42 * window.devicePixelRatio);
  const context = element.getContext('2d');
  if (!context) return;
  context.fillStyle = color;
  const middle = element.height / 2;
  for (let x = 0; x < pixels; x += 2) {
    const first = Math.floor(
      (from + (x * span) / pixels) / peaks.secondsPerPeak,
    );
    const last = Math.min(
      peaks.peaks.length,
      Math.ceil((from + ((x + 2) * span) / pixels) / peaks.secondsPerPeak),
    );
    let peak = 0;
    for (let index = first; index < last; index++)
      peak = Math.max(peak, peaks.peaks[index] ?? 0);
    const height = Math.max(1, Math.round(middle * peak * 0.9));
    context.fillRect(x, middle - height, 1, height * 2);
  }
});
</script>

<template>
  <canvas v-if="waveform" ref="canvas" aria-label="音频波形"></canvas>
  <span v-else class="wave-status">{{
    failed ? '波形无法读取' : '正在读取波形…'
  }}</span>
</template>

<style scoped>
canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.wave-status {
  padding-inline: 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
  color: hsl(var(--muted-foreground));
  white-space: nowrap;
}
</style>

<script lang="ts" setup>
import { ref, watch, watchPostEffect } from 'vue';

const props = defineProps<{
  label: string;
  max: number;
  span: number;
  start: number;
}>();
const emit = defineEmits<{ pan: [time: number] }>();
const scrollbar = ref<HTMLElement>();
const width = ref(0);

watch(
  scrollbar,
  (element, _, onCleanup) => {
    width.value = element?.clientWidth ?? 0;
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
  const element = scrollbar.value;
  if (!element || !width.value || !props.max) return;
  const pixels = element.scrollWidth - element.clientWidth;
  const next = Math.round((props.start / props.max) * pixels);
  if (element.scrollLeft !== next) element.scrollLeft = next;
});

function onScroll(event: Event) {
  const element = event.currentTarget as HTMLElement;
  const pixels = element.scrollWidth - element.clientWidth;
  if (!pixels || !props.max) return;
  if (element.scrollLeft !== Math.round((props.start / props.max) * pixels))
    emit('pan', (element.scrollLeft / pixels) * props.max);
}
</script>

<template>
  <div
    v-if="max > 0"
    ref="scrollbar"
    class="timeline-scrollbar"
    tabindex="0"
    role="region"
    :aria-label="label"
    @scroll="onScroll"
  >
    <div :style="{ width: `${Math.min(4096, 1 + max / span) * 100}%` }"></div>
  </div>
</template>

<style scoped>
.timeline-scrollbar {
  grid-column: 2;
  overflow: scroll hidden;
  overscroll-behavior-x: contain;
  scrollbar-color: hsl(var(--muted-foreground) / 65%) hsl(var(--muted));
  scrollbar-width: auto;
}

.timeline-scrollbar > div {
  height: 2px;
}

.timeline-scrollbar:focus-visible {
  outline: 2px solid hsl(var(--primary));
  outline-offset: -2px;
}
</style>

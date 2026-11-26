import type { Ref } from 'vue';

import { computed, ref, watch } from 'vue';

import { formatTimestamp } from '../../../../desktop/src/clip-plan.mjs';

export function useTimelineViewport(
  duration: Readonly<Ref<number>>,
  track: Ref<HTMLElement | undefined>,
) {
  const requestedSpan = ref(30);
  const start = ref(0);
  const width = ref(0);
  const manuallyPanned = ref(false);
  const drag = ref<{ id: number; x: number; start: number; moved: boolean }>();
  const span = computed(() => Math.min(requestedSpan.value, duration.value));
  const end = computed(() => start.value + span.value);
  const maxStart = computed(() => duration.value - span.value);
  const minSpan = computed(() => Math.min(0.5, duration.value));

  watch(maxStart, () => setStart(start.value), { flush: 'sync' });
  watch(
    track,
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

  const ticks = computed(() => {
    if (!width.value || !span.value) return [];
    const step = span.value / Math.max(1, Math.floor(width.value / 84));
    const unit = 10 ** Math.floor(Math.log10(step));
    const interval = unit * ([1, 2, 5, 10].find((n) => n * unit >= step) ?? 10);
    const result = [];
    for (
      let i = Math.ceil(start.value / interval);
      i * interval <= end.value;
      i++
    ) {
      const time = i * interval;
      const left = percent(time);
      result.push({
        time,
        left,
        label: left > 88 ? '' : formatTimestamp(time),
      });
    }
    return result;
  });

  function percent(time: number) {
    return span.value ? ((time - start.value) * 100) / span.value : 0;
  }

  function setStart(time: number) {
    start.value = Math.min(maxStart.value, Math.max(0, time));
  }

  function pan(time: number) {
    if (time === start.value) return;
    manuallyPanned.value = true;
    setStart(time);
  }

  function reset() {
    requestedSpan.value = 30;
    start.value = 0;
    manuallyPanned.value = false;
    drag.value = undefined;
  }

  function zoom(factor: number, position?: number) {
    if (factor === Infinity) {
      requestedSpan.value = Infinity;
      setStart(0);
      return;
    }
    const center =
      position !== undefined && position >= start.value && position <= end.value
        ? position
        : start.value + span.value / 2;
    requestedSpan.value = Math.max(
      minSpan.value,
      Math.min(duration.value, span.value * factor),
    );
    setStart(center - span.value / 2);
  }

  function timeAt(clientX: number) {
    const bounds = track.value?.getBoundingClientRect();
    if (!bounds?.width) return start.value;
    const fraction = Math.max(
      0,
      Math.min(1, (clientX - bounds.left) / bounds.width),
    );
    return start.value + span.value * fraction;
  }

  function onWheel(event: WheelEvent) {
    if (event.ctrlKey || !maxStart.value || !width.value || drag.value) return;
    const delta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
    if (!delta) return;
    let factor = 1;
    if (event.deltaMode === 1) factor = 16;
    else if (event.deltaMode === 2) factor = width.value;
    pan(start.value + (delta * factor * span.value) / width.value);
    event.preventDefault();
  }

  function startPan(event: PointerEvent) {
    if (!event.isPrimary || event.button !== 0 || drag.value) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    drag.value = {
      id: event.pointerId,
      x: event.clientX,
      start: start.value,
      moved: false,
    };
  }

  function movePan(event: PointerEvent) {
    const current = drag.value;
    if (current?.id !== event.pointerId || !maxStart.value || !width.value)
      return;
    const distance = event.clientX - current.x;
    if (!current.moved && Math.abs(distance) < 4) return;
    current.moved = true;
    pan(current.start - (distance * span.value) / width.value);
  }

  function endPan(event: PointerEvent) {
    const current = drag.value;
    if (current?.id !== event.pointerId) return undefined;
    drag.value = undefined;
    return event.type === 'pointerup' && !current.moved
      ? timeAt(event.clientX)
      : undefined;
  }

  return {
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
  };
}

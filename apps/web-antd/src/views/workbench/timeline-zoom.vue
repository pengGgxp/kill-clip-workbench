<script lang="ts" setup>
import { Maximize, Minus, Plus } from '@vben/icons';

import { Button, Tooltip } from 'ant-design-vue';

defineProps<{ prefix?: string; canZoomIn: boolean; canZoomOut: boolean }>();
const emit = defineEmits<{ zoom: [factor: number] }>();
</script>

<template>
  <div
    class="timeline-zoom"
    role="group"
    :aria-label="`${prefix ?? ''}时间轴缩放`"
  >
    <Tooltip title="缩小时间轴">
      <Button
        size="small"
        type="text"
        :aria-label="`缩小${prefix ?? ''}时间轴`"
        :disabled="!canZoomOut"
        @click="emit('zoom', 2)"
      >
        <template #icon><Minus /></template>
      </Button>
    </Tooltip>
    <Tooltip title="显示完整时间轴">
      <Button
        size="small"
        type="text"
        :aria-label="`显示完整${prefix ?? ''}时间轴`"
        :disabled="!canZoomOut"
        @click="emit('zoom', Infinity)"
      >
        <template #icon><Maximize /></template>
      </Button>
    </Tooltip>
    <Tooltip title="放大时间轴">
      <Button
        size="small"
        type="text"
        :aria-label="`放大${prefix ?? ''}时间轴`"
        :disabled="!canZoomIn"
        @click="emit('zoom', 0.5)"
      >
        <template #icon><Plus /></template>
      </Button>
    </Tooltip>
  </div>
</template>

<style scoped>
.timeline-zoom {
  display: flex;
  gap: 2px;
  align-items: center;
  margin-left: auto;
}

.timeline-zoom :deep(.ant-btn) {
  display: inline-grid;
  place-items: center;
  width: 26px;
  height: 26px;
}

.timeline-zoom :deep(svg) {
  width: 14px;
  height: 14px;
  vertical-align: middle;
}
</style>

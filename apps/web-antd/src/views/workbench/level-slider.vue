<script lang="ts" setup>
import { Slider } from 'ant-design-vue';

const props = defineProps<{
  label: string;
  level: number;
  disabled: boolean;
}>();

const emit = defineEmits<{
  change: [level: number];
  commit: [level: number];
}>();

function change(value: [number, number] | number) {
  if (typeof value === 'number') emit('change', value / 100);
}

function commit(value: [number, number] | number) {
  if (typeof value === 'number') emit('commit', value / 100);
}

function onKey(event: KeyboardEvent) {
  if (
    props.disabled ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    !(event.target instanceof HTMLElement) ||
    event.target.getAttribute('role') !== 'slider'
  )
    return;
  let percent = Math.round(props.level * 100);
  switch (event.key) {
    case 'ArrowDown':
    case 'ArrowLeft': {
      percent -= 1;
      break;
    }
    case 'ArrowUp':
    case 'ArrowRight': {
      percent += 1;
      break;
    }
    case 'PageDown': {
      percent -= 10;
      break;
    }
    case 'PageUp': {
      percent += 10;
      break;
    }
    case 'Home': {
      percent = 0;
      break;
    }
    case 'End': {
      percent = 100;
      break;
    }
    default: {
      return;
    }
  }
  event.preventDefault();
  event.stopPropagation();
  const next = Math.min(100, Math.max(0, percent));
  if (next !== Math.round(props.level * 100)) commit(next);
}
</script>

<template>
  <div class="level-slider" @keydown.capture="onKey">
    <Slider
      :aria-label-for-handle="label"
      :value="Math.round(level * 100)"
      :disabled="disabled"
      @update:value="change"
      @after-change="commit"
    />
  </div>
</template>

<style scoped>
.level-slider {
  min-width: 0;
}

.level-slider :deep(.ant-slider) {
  margin-block: 3px;
}
</style>

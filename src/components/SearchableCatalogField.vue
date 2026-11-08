<script setup lang="ts">
import { computed, ref } from 'vue'

const props = defineProps<{
  id: string
  modelValue: string
  options: string[]
  placeholder: string
  emptyMessage: string
  maxLength?: number
}>()
const emit = defineEmits<{
  'update:modelValue': [value: string]
  select: [value: string]
  commit: [value: string]
}>()

const open = ref(false)
const highlightedIndex = ref(-1)
const changedSinceCommit = ref(false)
let closeTimer: ReturnType<typeof setTimeout> | undefined
const suggestions = computed(() => {
  const query = props.modelValue.trim().toLocaleLowerCase()
  if (!query) return props.options
  return props.options
    .filter((option) => option.toLocaleLowerCase().includes(query))
    .sort((a, b) => Number(b.toLocaleLowerCase().startsWith(query)) - Number(a.toLocaleLowerCase().startsWith(query)) || a.localeCompare(b))
    .slice(0, 20)
})

function updateValue(event: Event) {
  emit('update:modelValue', (event.target as HTMLInputElement).value)
  highlightedIndex.value = -1
  changedSinceCommit.value = true
  open.value = true
}

function selectOption(value: string) {
  emit('update:modelValue', value)
  emit('select', value)
  changedSinceCommit.value = false
  open.value = false
  highlightedIndex.value = -1
}

function closeSuggestions() {
  if (closeTimer) clearTimeout(closeTimer)
  closeTimer = setTimeout(() => {
    open.value = false
    closeTimer = undefined
    if (changedSinceCommit.value) {
      changedSinceCommit.value = false
      emit('commit', props.modelValue)
    }
  }, 150)
}

function openSuggestions() {
  if (closeTimer) clearTimeout(closeTimer)
  closeTimer = undefined
  open.value = true
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    open.value = false
    return
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    open.value = true
    if (suggestions.value.length) {
      const direction = event.key === 'ArrowDown' ? 1 : -1
      highlightedIndex.value = (highlightedIndex.value + direction + suggestions.value.length) % suggestions.value.length
    }
    return
  }
  if (event.key === 'Enter' && open.value && suggestions.value[highlightedIndex.value]) {
    event.preventDefault()
    selectOption(suggestions.value[highlightedIndex.value]!)
  }
}
</script>

<template>
  <span class="vehicle-search-field">
    <input
      :id="id"
      type="text"
      :value="modelValue"
      :maxlength="maxLength ?? 100"
      role="combobox"
      aria-autocomplete="list"
      :aria-controls="`${id}-options`"
      :aria-activedescendant="highlightedIndex >= 0 ? `${id}-option-${highlightedIndex}` : undefined"
      :aria-expanded="open && suggestions.length > 0"
      :placeholder="placeholder"
      required
      @focus="openSuggestions"
      @click="openSuggestions"
      @blur="closeSuggestions"
      @input="updateValue"
      @keydown="handleKeydown"
    />
    <span v-if="open && suggestions.length" :id="`${id}-options`" class="vehicle-search-options" role="listbox">
      <button
        v-for="(option, index) in suggestions"
        :id="`${id}-option-${index}`"
        :key="option"
        type="button"
        role="option"
        :aria-selected="index === highlightedIndex"
        @mousedown.prevent="selectOption(option)"
      >{{ option }}</button>
    </span>
    <span v-else-if="open && modelValue.trim() && !suggestions.length" class="vehicle-search-empty">{{ emptyMessage }}</span>
  </span>
</template>

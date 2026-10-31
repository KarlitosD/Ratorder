<script module lang="ts">
  let selectId = 0
</script>

<script lang="ts" generics="T extends string | number">
  import { Check, ChevronDown } from '@lucide/svelte'
  import { tick } from 'svelte'

  interface Option {
    value: T
    label: string
    disabled?: boolean
  }

  interface Props {
    value: T
    options: readonly Option[]
    id?: string
    disabled?: boolean
    ariaLabel?: string
    bare?: boolean
    align?: 'start' | 'end'
  }

  let {
    value = $bindable(),
    options,
    id = `ratorder-select-${++selectId}`,
    disabled = false,
    ariaLabel,
    bare = false,
    align = 'start',
  }: Props = $props()

  let open = $state(false)
  let menuVisible = $state(false)
  let trigger = $state<HTMLButtonElement | null>(null)
  let root = $state<HTMLDivElement | null>(null)
  let menu = $state<HTMLDivElement | null>(null)
  let menuPosition = $state({ top: 0, left: 0, width: 0 })

  let selectedOption = $derived(
    options.find((option) => option.value === value) ?? options[0],
  )
  let listboxId = $derived(`${id}-listbox`)

  $effect(() => {
    if (disabled && open) close()
  })

  async function openMenu() {
    if (disabled || open) return
    open = true
    menuVisible = false
    await tick()
    positionMenu()
    menuVisible = true
    await tick()
    focusSelected()
  }

  function close(refocus = false) {
    if (!open) return
    open = false
    menuVisible = false
    if (refocus) trigger?.focus()
  }

  function toggleMenu() {
    if (open) {
      close()
    } else {
      void openMenu()
    }
  }

  function positionMenu() {
    if (!trigger || !menu) return
    const rect = trigger.getBoundingClientRect()
    const menuHeight = menu.offsetHeight
    const viewportPadding = 8
    const gap = 6
    const width = Math.min(
      Math.max(rect.width, bare ? 180 : 0),
      window.innerWidth - viewportPadding * 2,
    )

    let top = rect.bottom + gap
    if (
      top + menuHeight > window.innerHeight - viewportPadding &&
      rect.top - gap - menuHeight >= viewportPadding
    ) {
      top = rect.top - gap - menuHeight
    } else if (top + menuHeight > window.innerHeight - viewportPadding) {
      top = Math.max(
        viewportPadding,
        window.innerHeight - menuHeight - viewportPadding,
      )
    }

    const anchorLeft = align === 'end' ? rect.right - width : rect.left
    const left = Math.min(
      Math.max(viewportPadding, anchorLeft),
      window.innerWidth - width - viewportPadding,
    )

    menuPosition = { top, left, width }
  }

  function focusSelected() {
    if (!menu) return
    const optionElements = Array.from(
      menu.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)'),
    )
    const index = optionElements.findIndex(
      (element) => element.dataset.value === String(value),
    )
    const target = optionElements[index] ?? optionElements[0]
    target?.focus({ preventScroll: true })
    target?.scrollIntoView({ block: 'nearest' })
  }

  function choose(option: Option) {
    if (option.disabled) return
    value = option.value
    close(true)
  }

  function handleTriggerKeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) void openMenu()
    } else if (event.key === 'Escape' && open) {
      event.preventDefault()
      close(true)
    }
  }

  function handleOptionKeydown(event: KeyboardEvent) {
    const enabledOptions = Array.from(
      menu?.querySelectorAll<HTMLButtonElement>(
        '[role="option"]:not(:disabled)',
      ) ?? [],
    )
    const currentIndex = enabledOptions.indexOf(
      event.currentTarget as HTMLButtonElement,
    )

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      enabledOptions[
        Math.min(currentIndex + 1, enabledOptions.length - 1)
      ]?.focus()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      enabledOptions[Math.max(currentIndex - 1, 0)]?.focus()
    } else if (event.key === 'Home') {
      event.preventDefault()
      enabledOptions[0]?.focus()
    } else if (event.key === 'End') {
      event.preventDefault()
      enabledOptions[enabledOptions.length - 1]?.focus()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      close(true)
    } else if (event.key === 'Tab') {
      close()
    }
  }

  function handleWindowPointerDown(event: PointerEvent) {
    if (open && root && !root.contains(event.target as Node)) close()
  }

  function handleWindowChange() {
    if (open) close()
  }
</script>

<svelte:window
  onpointerdown={handleWindowPointerDown}
  onresize={handleWindowChange}
  onscroll={handleWindowChange}
/>

<div class="select-field" class:bare bind:this={root}>
  <button
    bind:this={trigger}
    {id}
    type="button"
    class="select-trigger"
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-controls={listboxId}
    aria-label={ariaLabel}
    {disabled}
    onclick={toggleMenu}
    onkeydown={handleTriggerKeydown}
  >
    <span class="select-value">{selectedOption?.label ?? '—'}</span>
    <span class="select-chevron" class:open aria-hidden="true">
      <ChevronDown size={14} strokeWidth={1.9} />
    </span>
  </button>

  {#if open}
    <div
      bind:this={menu}
      id={listboxId}
      class="select-menu"
      role="listbox"
      tabindex="-1"
      aria-label={ariaLabel}
      style:top={`${menuPosition.top}px`}
      style:left={`${menuPosition.left}px`}
      style:width={`${menuPosition.width}px`}
      style:visibility={menuVisible ? 'visible' : 'hidden'}
    >
      {#each options as option (option.value)}
        <button
          type="button"
          class="select-option"
          class:selected={option.value === value}
          role="option"
          aria-selected={option.value === value}
          data-value={option.value}
          disabled={option.disabled}
          onclick={() => choose(option)}
          onkeydown={handleOptionKeydown}
        >
          <span>{option.label}</span>
          {#if option.value === value}
            <Check size={14} strokeWidth={2} />
          {/if}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .select-field {
    position: relative;
    min-width: 0;
  }

  .select-trigger {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
    height: 40px;
    padding: 0 12px;
    color: var(--text);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 9px;
    font-size: 13px;
    font-weight: 500;
    text-align: left;
    cursor: pointer;
    transition:
      border-color var(--fast),
      box-shadow var(--fast),
      background-color var(--fast);
  }

  .select-trigger:hover:not(:disabled) {
    border-color: var(--border-strong);
  }

  .select-trigger[aria-expanded='true'] {
    border-color: var(--primary-border);
    box-shadow: 0 0 0 3px var(--primary-soft);
  }

  .select-trigger:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .select-value {
    overflow: hidden;
    min-width: 0;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .select-chevron {
    display: inline-flex;
    flex: 0 0 auto;
    color: var(--text-tertiary);
    transition: transform 180ms var(--ease);
  }

  .select-chevron.open {
    transform: rotate(180deg);
  }

  .select-menu {
    position: fixed;
    z-index: 120;
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 280px;
    padding: 4px;
    overflow-y: auto;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: var(--shadow-popover);
    overscroll-behavior: contain;
  }

  .select-option {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    width: 100%;
    min-height: 34px;
    padding: 0 9px;
    flex: 0 0 auto;
    color: var(--text-secondary);
    background: transparent;
    border: 0;
    border-radius: 6px;
    font-size: 12.5px;
    font-weight: 500;
    text-align: left;
    cursor: pointer;
  }

  .select-option span {
    overflow: hidden;
    min-width: 0;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .select-option:hover:not(:disabled),
  .select-option:focus,
  .select-option:focus-visible {
    color: var(--text);
    background: var(--surface-hover);
    outline: none;
  }

  .select-option.selected {
    color: var(--primary-ink);
    background: var(--primary-soft);
  }

  .select-option.selected:focus-visible {
    color: var(--text);
    background: var(--surface-hover);
  }

  .select-option:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }

  .bare .select-trigger {
    width: auto;
    height: 34px;
    padding: 0 9px 0 0;
    gap: 6px;
    color: var(--text-secondary);
    background: transparent;
    border: 0;
    border-radius: 0;
    font-size: 11.5px;
  }

  .bare .select-trigger:hover:not(:disabled) {
    color: var(--text);
    border: 0;
  }

  .bare .select-trigger[aria-expanded='true'] {
    border: 0;
    box-shadow: none;
  }

  .bare .select-chevron {
    color: currentColor;
  }

  .bare .select-menu {
    font-size: 12px;
  }

  @media (prefers-reduced-motion: reduce) {
    .select-chevron {
      transition: none;
    }
  }
</style>

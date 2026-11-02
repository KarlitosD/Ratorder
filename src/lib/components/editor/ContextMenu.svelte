<script lang="ts">
  import { onMount, tick, untrack } from 'svelte'
  import type { EditorMenuItem } from '../../editor/types'

  interface Props {
    x: number
    y: number
    items: EditorMenuItem[]
    onClose: () => void
  }

  let { x, y, items, onClose }: Props = $props()

  let menu = $state<HTMLDivElement | null>(null)
  let left = $state(untrack(() => x))
  let top = $state(untrack(() => y))

  $effect(() => {
    const element = menu
    if (!element) return
    const rect = element.getBoundingClientRect()
    left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))
    top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))
  })

  onMount(() => {
    const closeOnOutside = (event: PointerEvent) => {
      if (menu?.contains(event.target as Node)) return
      onClose()
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    const close = () => onClose()
    document.addEventListener('pointerdown', closeOnOutside, true)
    window.addEventListener('keydown', closeOnEscape)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    void tick().then(() => {
      const first = menu?.querySelector<HTMLButtonElement>(
        'button:not(:disabled)',
      )
      first?.focus()
    })
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside, true)
      window.removeEventListener('keydown', closeOnEscape)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  })

  function onKeydown(event: KeyboardEvent) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const buttons = Array.from(
      menu?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
    )
    if (buttons.length === 0) return
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const direction = event.key === 'ArrowDown' ? 1 : -1
    const next =
      (current + direction + buttons.length) % buttons.length
    buttons[next]?.focus()
  }

  function choose(item: EditorMenuItem) {
    if (item.disabled) return
    try {
      item.action()
    } finally {
      onClose()
    }
  }
</script>

<div
  bind:this={menu}
  class="context-menu"
  role="menu"
  tabindex="-1"
  aria-label="Acciones del editor"
  style:left={`${left}px`}
  style:top={`${top}px`}
  onkeydown={onKeydown}
  oncontextmenu={(event) => event.preventDefault()}
>
  {#each items as item}
    {#if item.separatorBefore}
      <span class="menu-separator"></span>
    {/if}
    <button
      type="button"
      role="menuitem"
      class:danger={item.danger}
      disabled={item.disabled}
      onclick={() => choose(item)}
    >
      {#if item.icon}
        {@const Icon = item.icon}
        <Icon size={14} strokeWidth={1.9} />
      {:else}
        <span class="icon-gap"></span>
      {/if}
      <span class="menu-label">{item.label}</span>
      {#if item.shortcut}
        <kbd>{item.shortcut}</kbd>
      {/if}
    </button>
  {/each}
</div>

<style>
  .context-menu {
    position: fixed;
    z-index: 90;
    display: flex;
    min-width: 218px;
    flex-direction: column;
    padding: 4px;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: 9px;
    box-shadow: var(--shadow-popover);
  }

  .context-menu button {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 32px;
    padding: 0 8px;
    color: var(--text-secondary);
    text-align: left;
    background: transparent;
    border: 0;
    border-radius: 6px;
    font-size: 11.5px;
    cursor: pointer;
  }

  .context-menu button:hover:not(:disabled),
  .context-menu button:focus-visible {
    color: var(--text);
    background: var(--surface-hover);
    outline: none;
  }

  .context-menu button:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }

  .context-menu button.danger {
    color: var(--danger);
  }

  .menu-label {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .icon-gap {
    width: 14px;
    flex: 0 0 auto;
  }

  kbd {
    height: 19px;
    padding: 0 5px;
    color: var(--text-tertiary);
    background: var(--surface-inset);
    border: 1px solid var(--border-soft);
    border-radius: 4px;
    font-family: var(--font-mono);
    font-size: 8.5px;
    line-height: 17px;
    white-space: nowrap;
  }

  .menu-separator {
    height: 1px;
    margin: 4px 5px;
    background: var(--border-soft);
  }
</style>

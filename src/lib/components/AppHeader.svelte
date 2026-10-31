<script lang="ts">
  import {
    HardDrive,
    Moon,
    Sun,
  } from '@lucide/svelte'
  import type { AppView, RecorderPhase } from '../types'
  import { formatBytes, formatDuration } from '../utils/format'

  interface Props {
    view: AppView
    theme: 'dark' | 'light'
    storageUsed: number
    phase: RecorderPhase
    elapsedMs: number
    onNavigate: (view: AppView) => void
    onToggleTheme: () => void
  }

  let {
    view,
    theme,
    storageUsed,
    phase,
    elapsedMs,
    onNavigate,
    onToggleTheme,
  }: Props = $props()

  let isSessionActive = $derived(phase === 'recording' || phase === 'paused')
</script>

<header class="app-header">
  <div class="header-inner">
    <div class="brand-group">
      <button
        class="brand"
        type="button"
        aria-label="Ir a grabar"
        onclick={() => onNavigate('record')}
      >
        <span class="logo" aria-hidden="true">
          <svg viewBox="0 0 32 32" fill="none">
            <path
              d="M9 13.5V10.5A1.5 1.5 0 0 1 10.5 9h3.5M23 13.5V10.5A1.5 1.5 0 0 0 21.5 9H18M9 18.5v3A1.5 1.5 0 0 0 10.5 23H14M23 18.5v3a1.5 1.5 0 0 1-1.5 1.5H18"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linecap="square"
            />
            <rect x="14" y="14" width="4" height="4" rx="1" fill="currentColor" />
          </svg>
        </span>
        <span class="brand-copy">
          <span class="brand-name">Ratorder</span>
          <span class="brand-caption">Grabador local</span>
        </span>
      </button>
    </div>

    <nav class="main-nav" aria-label="Navegación principal">
      <button
        type="button"
        class:active={view === 'record'}
        aria-current={view === 'record' ? 'page' : undefined}
        onclick={() => onNavigate('record')}
      >
        <span>Grabar</span>
        {#if isSessionActive && view !== 'record'}
          <span class:recording={phase === 'recording'} class="nav-session">
            <span class="nav-session-dot"></span>
            <span class="mono-digits nav-session-time">
              {formatDuration(elapsedMs)}
            </span>
          </span>
        {/if}
      </button>
      <button
        type="button"
        class:active={view === 'library'}
        aria-current={view === 'library' ? 'page' : undefined}
        onclick={() => onNavigate('library')}
      >
        <span>Biblioteca</span>
      </button>
    </nav>

    <div class="header-actions">
      {#if storageUsed > 0}
        <button
          type="button"
          class="storage-chip"
          title="Almacenamiento local utilizado"
          onclick={() => onNavigate('library')}
        >
          <HardDrive size={14} strokeWidth={1.8} />
          <span>{formatBytes(storageUsed)}</span>
        </button>
      {/if}
      <button
        type="button"
        class="icon-button theme-toggle"
        title={theme === 'dark' ? 'Usar tema claro' : 'Usar tema oscuro'}
        aria-label={theme === 'dark' ? 'Usar tema claro' : 'Usar tema oscuro'}
        onclick={onToggleTheme}
      >
        {#if theme === 'dark'}
          <Sun size={17} strokeWidth={1.7} />
        {:else}
          <Moon size={17} strokeWidth={1.7} />
        {/if}
      </button>
    </div>
  </div>
</header>

<style>
  .app-header {
    position: sticky;
    top: 0;
    z-index: 40;
    background: var(--bg);
    border-bottom: 1px solid var(--border-soft);
  }

  .header-inner {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    width: 100%;
    max-width: 1460px;
    min-height: 70px;
    margin: 0 auto;
    padding: 0 clamp(20px, 3.2vw, 44px);
  }

  .brand-group {
    display: flex;
    align-items: center;
    min-width: 0;
  }

  .brand {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    padding: 0;
    color: var(--text);
    background: transparent;
    border: 0;
    border-radius: 10px;
    cursor: pointer;
    text-align: left;
  }

  .logo {
    display: grid;
    width: 33px;
    height: 33px;
    flex: 0 0 auto;
    place-items: center;
    color: #fff;
    background: var(--primary);
    border: 1px solid var(--primary);
    border-radius: 9px;
    transition: background-color var(--fast);
  }

  .brand:hover .logo {
    background: var(--primary-hover);
  }

  .logo svg {
    width: 25px;
    height: 25px;
  }

  .brand-copy {
    display: flex;
    flex-direction: column;
    min-width: 0;
    line-height: 1.15;
  }

  .brand-name {
    font-size: 15px;
    font-weight: 650;
    letter-spacing: -0.03em;
  }

  .brand-caption {
    margin-top: 3px;
    color: var(--text-tertiary);
    font-size: 10.5px;
    font-weight: 500;
    letter-spacing: 0.015em;
  }

  .main-nav {
    display: flex;
    align-items: center;
    gap: 20px;
  }

  .main-nav button {
    position: relative;
    display: flex;
    align-items: center;
    gap: 7px;
    height: 38px;
    padding: 0 2px;
    color: var(--text-tertiary);
    background: transparent;
    border: 0;
    font-size: 13px;
    font-weight: 550;
    cursor: pointer;
    transition: color var(--fast);
  }

  .main-nav button::after {
    position: absolute;
    right: 0;
    bottom: -1px;
    left: 0;
    height: 2px;
    content: '';
    background: transparent;
    border-radius: 2px;
    transition: background-color var(--fast);
  }

  .main-nav button:hover {
    color: var(--text);
  }

  .main-nav button.active {
    color: var(--text);
  }

  .main-nav button.active::after {
    background: var(--primary);
  }

  .nav-session {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    margin-left: 3px;
    color: var(--text-tertiary);
    font-size: 10px;
    font-weight: 500;
  }

  .nav-session-dot {
    width: 5px;
    height: 5px;
    background: var(--warning);
    border-radius: 50%;
  }

  .nav-session.recording .nav-session-dot {
    background: var(--danger);
    animation: pulse-recording 1.8s ease-in-out infinite;
  }

  .nav-session-time {
    font-weight: 550;
  }

  .header-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
  }

  .storage-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 10px;
    color: var(--text-tertiary);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 8px;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition:
      color var(--fast),
      background-color var(--fast);
  }

  .storage-chip:hover {
    color: var(--text-secondary);
    background: var(--surface-hover);
  }

  .theme-toggle {
    width: 32px;
    height: 32px;
  }

  @media (max-width: 820px) {
    .header-inner {
      grid-template-columns: 1fr auto;
    }

    .main-nav {
      order: 3;
      grid-column: 1 / -1;
      justify-self: center;
      margin-bottom: 10px;
      padding: 2px;
      background: transparent;
      border-color: transparent;
    }

    .header-inner {
      min-height: 58px;
      padding-top: 10px;
    }

    .brand-caption {
      display: none;
    }
  }

  @media (max-width: 520px) {
    .nav-session {
      display: none;
    }

    .storage-chip span {
      display: none;
    }

    .main-nav button {
      padding: 0 11px;
    }
  }
</style>

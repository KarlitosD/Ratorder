<script lang="ts">
  import { onMount } from 'svelte'
  import { Keyboard, X } from '@lucide/svelte'

  interface Props {
    onClose: () => void
  }

  let { onClose }: Props = $props()

  let dialog = $state<HTMLDialogElement | null>(null)

  const groups = [
    {
      title: 'Reproducción',
      items: [
        ['Espacio', 'Reproducir o pausar'],
        ['← / →', 'Fotograma anterior / siguiente'],
        ['Mayús + ← / →', 'Retroceder / avanzar un segundo'],
        ['Inicio / Fin', 'Ir al principio o al final'],
        ['[ / ]', 'Bajar / subir la velocidad de preview'],
      ],
    },
    {
      title: 'Edición',
      items: [
        ['S', 'Dividir en el cabezal'],
        ['M', 'Silenciar o activar el audio'],
        ['Supr', 'Eliminar la selección'],
        ['Esc', 'Deseleccionar o cerrar menús'],
        ['Ctrl/⌘ + Z', 'Deshacer'],
        ['Ctrl/⌘ + Mayús + Z', 'Rehacer'],
      ],
    },
    {
      title: 'Proyecto',
      items: [
        ['Ctrl/⌘ + S', 'Guardar el proyecto de edición'],
        ['Ctrl/⌘ + E', 'Abrir la exportación'],
        ['+ / −', 'Acercar o alejar la timeline'],
        ['0', 'Restablecer el zoom'],
        ['?', 'Mostrar estos atajos'],
      ],
    },
  ]

  onMount(() => {
    if (dialog && !dialog.open) dialog.showModal()
    return () => dialog?.close()
  })

  function handleCancel(event: Event) {
    event.preventDefault()
    onClose()
  }

  function backdropClick(event: MouseEvent) {
    if (event.target === dialog) onClose()
  }
</script>

<dialog
  bind:this={dialog}
  class="shortcuts-dialog"
  aria-labelledby="shortcuts-title"
  oncancel={handleCancel}
  onclick={backdropClick}
>
  <div class="shortcuts-shell">
    <header class="shortcuts-header">
      <div class="shortcuts-title">
        <Keyboard size={18} strokeWidth={1.9} />
        <h2 id="shortcuts-title">Atajos de teclado</h2>
      </div>
      <button
        type="button"
        class="icon-button"
        aria-label="Cerrar atajos"
        onclick={onClose}
      >
        <X size={16} strokeWidth={1.9} />
      </button>
    </header>

    <div class="shortcuts-body">
      {#each groups as group}
        <section>
          <h3>{group.title}</h3>
          <dl>
            {#each group.items as [keys, description]}
              <div>
                <dt><kbd>{keys}</kbd></dt>
                <dd>{description}</dd>
              </div>
            {/each}
          </dl>
        </section>
      {/each}
      <p class="shortcuts-note">
        Los atajos se desactivan mientras escribes en un campo de texto.
      </p>
    </div>
  </div>
</dialog>

<style>
  .shortcuts-dialog {
    width: min(560px, calc(100vw - 32px));
    max-width: 560px;
    padding: 0;
    color: var(--text);
    background: transparent;
    border: 0;
  }

  .shortcuts-dialog::backdrop {
    background: var(--overlay);
  }

  .shortcuts-shell {
    overflow: hidden;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-popover);
  }

  .shortcuts-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 15px 18px;
    border-bottom: 1px solid var(--border-soft);
  }

  .shortcuts-title {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text);
  }

  h2 {
    font-size: 17px;
    font-weight: 580;
    letter-spacing: -0.03em;
  }

  .shortcuts-body {
    max-height: min(70dvh, 540px);
    overflow-y: auto;
    padding: 4px 18px 16px;
    scrollbar-width: thin;
  }

  section {
    padding-top: 13px;
  }

  h3 {
    color: var(--text-tertiary);
    font-size: 8.5px;
    font-weight: 650;
    letter-spacing: 0.075em;
    text-transform: uppercase;
  }

  dl {
    display: flex;
    flex-direction: column;
    gap: 0;
    margin: 6px 0 0;
  }

  dl div {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-height: 31px;
    border-bottom: 1px solid var(--border-soft);
  }

  dt {
    order: 2;
    flex: 0 0 auto;
  }

  dd {
    order: 1;
    margin: 0;
    color: var(--text-secondary);
    font-size: 11px;
  }

  kbd {
    display: inline-flex;
    align-items: center;
    height: 21px;
    padding: 0 6px;
    color: var(--text-secondary);
    background: var(--surface-inset);
    border: 1px solid var(--border);
    border-radius: 4px;
    font-family: var(--font-mono);
    font-size: 9px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .shortcuts-note {
    margin-top: 14px;
    color: var(--text-tertiary);
    font-size: 9.5px;
    line-height: 1.55;
  }

  .icon-button {
    width: 30px;
    height: 30px;
  }
</style>

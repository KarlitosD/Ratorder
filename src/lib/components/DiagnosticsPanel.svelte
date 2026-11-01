<script lang="ts">
  import {
    createLocalReport,
    isTelemetryConfigured,
    setTelemetryEnabled,
    telemetryEnabled,
  } from '../diagnostics/reporting'

  let enabled = $state(telemetryEnabled())
  let report = $state('')
  let status = $state('')
  const configured = isTelemetryConfigured()

  function changeConsent(event: Event) {
    const requested = (event.currentTarget as HTMLInputElement).checked
    enabled = setTelemetryEnabled(requested)
    status = requested && !enabled ? 'No se pudo guardar la preferencia en este navegador.' : ''
  }

  async function showReport() {
    report = await createLocalReport()
  }
</script>

<section class="diagnostics" aria-labelledby="diagnostics-title">
  <h2 id="diagnostics-title">Diagnóstico</h2>
  <p>Consulta los recursos de esta sesión. Una sospecha no confirma una fuga de memoria.</p>
  <button type="button" onclick={showReport}>Ver informe local</button>
  {#if report}
    <label for="diagnostics-report">Informe local (puedes copiarlo para compartirlo)</label>
    <textarea id="diagnostics-report" readonly rows="8" value={report}></textarea>
  {/if}
  <label class="consent">
    <input type="checkbox" checked={enabled} disabled={!configured} onchange={changeConsent} />
    <span>Enviar sospechas de recursos no liberados a PostHog</span>
  </label>
  <p>Opcional y desactivado por defecto. Se envían el tipo de sospecha, la cantidad, la operación y la versión de la app, no grabaciones ni sus nombres. PostHog recibe la conexión de red.</p>
  {#if !configured}<p>El envío no está configurado en esta instalación.</p>{/if}
  {#if status}<p role="status">{status}</p>{/if}
</section>

<style>
  .diagnostics { margin-top: 24px; padding: 18px; border: 1px solid var(--border); border-radius: 12px; }
  h2 { font-size: 14px; margin: 0 0 8px; }
  p { font-size: 12px; line-height: 1.5; color: var(--text-secondary); margin: 8px 0; }
  button { padding: 8px 12px; border: 1px solid var(--border); border-radius: 8px; background: transparent; color: inherit; cursor: pointer; }
  label:not(.consent) { display: block; font-size: 12px; margin-top: 12px; }
  textarea { display: block; width: 100%; margin-top: 6px; padding: 8px; color: inherit; background: transparent; border: 1px solid var(--border); border-radius: 8px; font: inherit; font-size: 11px; }
  .consent { display: flex; align-items: flex-start; gap: 8px; margin-top: 16px; font-size: 12px; }
  .consent input { margin: 2px 0 0; }
</style>

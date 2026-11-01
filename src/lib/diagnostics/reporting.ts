import { checkWriters, getResourceCounts } from './resources'
import { version } from '../../../package.json'

const consentKey = 'ratorder.diagnostics.consent'
const token = import.meta.env.VITE_POSTHOG_TOKEN as string | undefined
const region = import.meta.env.VITE_POSTHOG_REGION === 'eu' ? 'eu' : 'us'
let lastIssue: { kind: string; count: number } | null = null
let reported = false
let disabledForSession = false
let deliveryStatus = 'Sin intentos de envío'
const history: Array<{ kind: string; count: number; at: string }> = []
const memorySamples: Array<{ bytes: number; at: string }> = []

export function isTelemetryConfigured(): boolean {
  return Boolean(token)
}

export function telemetryEnabled(): boolean {
  try {
    return !disabledForSession && Boolean(token) && localStorage.getItem(consentKey) === 'yes'
  } catch {
    return false
  }
}

export function setTelemetryEnabled(enabled: boolean): boolean {
  disabledForSession = !enabled
  try {
    if (enabled && token) localStorage.setItem(consentKey, 'yes')
    else localStorage.removeItem(consentKey)
  } catch {
    disabledForSession = true
    return false
  }
  return telemetryEnabled()
}

export function inspectAfterRecording(): boolean {
  void sampleMemory()
  const counts = getResourceCounts()
  const issue = checkWriters() ?? (counts.audioContext > 0
    ? { kind: 'audio_context_not_closed', count: counts.audioContext }
    : counts.mixedTrack > 0 ? { kind: 'mixed_track_not_stopped', count: counts.mixedTrack } : null)
  if (!issue) return false
  lastIssue = issue
  history.push({ ...issue, at: new Date().toISOString() })
  if (history.length > 10) history.shift()
  if (telemetryEnabled() && !reported) {
    reported = true
    deliveryStatus = 'Enviando'
    void fetch(`https://${region}.i.posthog.com/i/v0/e/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      body: JSON.stringify({
        token,
        event: 'diagnostic_resource_suspected',
        properties: {
          distinct_id: crypto.randomUUID(),
          $process_person_profile: false,
          issue: issue.kind,
          count: issue.count,
          version,
          operation: 'recording_cleanup',
        },
      }),
    }).then((response) => {
      deliveryStatus = response.ok ? 'Envío aceptado por el servidor' : 'Error de envío'
    }).catch(() => { deliveryStatus = 'Error de envío' })
  }
  return true
}

async function sampleMemory(): Promise<number | null> {
  const api = performance as Performance & {
    measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>
  }
  if (typeof window === 'undefined' || !window.crossOriginIsolated || !api.measureUserAgentSpecificMemory) return null
  try {
    const bytes = (await api.measureUserAgentSpecificMemory()).bytes
    memorySamples.push({ bytes, at: new Date().toISOString() })
    if (memorySamples.length > 10) memorySamples.shift()
    return bytes
  } catch {
    return null
  }
}

export async function createLocalReport(): Promise<string> {
  const memoryBytes = await sampleMemory()
  return JSON.stringify({
    version,
    resources: getResourceCounts(),
    lastSuspectedIssue: lastIssue,
    history,
    memoryBytes,
    memorySamples,
    memoryNote: 'Las muestras no confirman una fuga; null indica que no está disponible.',
    telemetryEnabled: telemetryEnabled(),
    deliveryStatus,
  }, null, 2)
}

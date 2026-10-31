const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    BYTE_UNITS.length - 1,
  )
  const value = bytes / 1024 ** exponent
  const fractionDigits = exponent === 0 ? 0 : value >= 100 ? 0 : decimals
  return `${value.toFixed(fractionDigits).replace('.', ',')} ${BYTE_UNITS[exponent]}`
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return [hours, minutes, seconds]
    .map((part) => part.toString().padStart(2, '0'))
    .join(':')
}

export function formatCompactDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds} s`
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) {
    return `${hours} h ${minutes.toString().padStart(2, '0')} min`
  }
  return `${minutes}:${seconds.toString().padStart(2, '0')} min`
}

export function formatDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'Fecha desconocida'
  return new Intl.DateTimeFormat('es-ES', {
    day: 'numeric',
    month: 'short',
    year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

export function formatResolution(width: number, height: number): string {
  if (!width || !height) return 'Resolución desconocida'
  return `${width} × ${height}`
}

export function formatBitrate(bitsPerSecond: number): string {
  if (bitsPerSecond >= 1_000_000) {
    return `${(bitsPerSecond / 1_000_000).toFixed(1).replace('.', ',')} Mbps`
  }
  return `${Math.round(bitsPerSecond / 1000)} kbps`
}

export function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural
}

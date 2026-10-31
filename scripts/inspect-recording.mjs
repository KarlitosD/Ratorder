import { spawnSync } from 'node:child_process'

const file = process.argv[2]
if (!file || process.argv.length !== 3) {
  console.error('Uso: node scripts/inspect-recording.mjs <archivo>')
  process.exit(1)
}

const probe = spawnSync('ffprobe', [
  '-v', 'error', '-count_packets', '-show_entries',
  'format=duration,size:stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,start_time,duration,sample_rate,channels,nb_read_packets',
  '-of', 'json', '-i', file,
], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
if (probe.error || probe.status !== 0) {
  console.error(`No se pudo inspeccionar el archivo: ${probe.error?.message ?? probe.stderr.trim()}`)
  process.exit(1)
}

const data = JSON.parse(probe.stdout)
const number = value => value != null && value !== 'N/A' && Number.isFinite(Number(value)) ? Number(value) : null
const result = {
  durationSeconds: number(data.format?.duration),
  bytes: number(data.format?.size),
  streams: (data.streams ?? []).map(stream => ({
    type: stream.codec_type,
    codec: stream.codec_name ?? null,
    startSeconds: number(stream.start_time),
    durationSeconds: number(stream.duration),
    packets: number(stream.nb_read_packets),
    ...(stream.codec_type === 'video' && {
      width: number(stream.width), height: number(stream.height),
      reportedFrameRate: stream.r_frame_rate ?? null, averageFrameRate: stream.avg_frame_rate ?? null,
    }),
    ...(stream.codec_type === 'audio' && {
      sampleRate: number(stream.sample_rate), channels: number(stream.channels),
    }),
  })),
}
console.log(JSON.stringify(result, null, 2))

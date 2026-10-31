// Measure event onsets in decoded, constant-rate mono audio and grayscale video.
// Stream start timestamps preserve container offsets when decoding streams separately.
function onsets(values, threshold, step, start = 0) {
  const events = []
  let active = false
  for (let i = 0; i < values.length; i++) {
    const above = Math.abs(values[i]) >= threshold
    if (above && !active) events.push(start + i * step)
    active = above
  }
  return events
}

export function analyzeSync({ video, audio, fps, rate, videoStart = 0, audioStart = 0 }) {
  const flashes = onsets(video, 160, 1 / fps, videoStart)
  // Average absolute PCM over 5 ms to avoid counting every oscillation as an event.
  const block = Math.max(1, Math.round(rate * 0.005))
  const levels = []
  for (let i = 0; i + block <= audio.length; i += block) {
    let sum = 0
    for (let j = 0; j < block; j++) sum += Math.abs(audio[i + j])
    levels.push(sum / block)
  }
  const pulses = onsets(levels, 0.04, block / rate, audioStart)
  if (flashes.length < 2 || flashes.length !== pulses.length) {
    throw new Error(`Event mismatch: ${flashes.length} flashes, ${pulses.length} pulses; flashes=${JSON.stringify(flashes)} pulses=${JSON.stringify(pulses)}`)
  }
  const events = flashes.map((videoTime, i) => ({ videoTime, audioTime: pulses[i], offsetMs: (pulses[i] - videoTime) * 1000 }))
  return { events, initialOffsetMs: events[0].offsetMs, driftMs: events.at(-1).offsetMs - events[0].offsetMs }
}

interface AudioMixerOptions {
  microphoneStream: MediaStream | null
  systemAudioStream: MediaStream | null
}

export class AudioMixer {
  readonly stream: MediaStream
  readonly track: MediaStreamTrack

  #context: AudioContext
  #microphoneGain: GainNode | null = null
  #systemAudioGain: GainNode | null = null
  #sourceNodes: AudioNode[] = []
  #closed = false

  private constructor(
    context: AudioContext,
    destination: MediaStreamAudioDestinationNode,
  ) {
    this.#context = context
    this.stream = destination.stream
    const [track] = this.stream.getAudioTracks()
    if (!track) {
      throw new Error('No se pudo crear la pista de audio mezclada.')
    }
    this.track = track
  }

  static async create({
    microphoneStream,
    systemAudioStream,
  }: AudioMixerOptions): Promise<AudioMixer> {
    const context = new AudioContext({
      sampleRate: 48_000,
      latencyHint: 'playback',
    })
    if (context.state === 'suspended') {
      await context.resume()
    }

    const destination = context.createMediaStreamDestination()
    destination.channelCount = 2
    destination.channelCountMode = 'explicit'
    destination.channelInterpretation = 'speakers'

    const mixer = new AudioMixer(context, destination)

    const compressor = context.createDynamicsCompressor()
    compressor.threshold.value = -6
    compressor.knee.value = 6
    compressor.ratio.value = 8
    compressor.attack.value = 0.003
    compressor.release.value = 0.25
    compressor.connect(destination)

    // Keep the graph rendering even though the monitor is silent. This avoids
    // irregular audio delivery from some Chromium-based browsers.
    const silentMonitor = context.createGain()
    silentMonitor.gain.value = 0
    compressor.connect(silentMonitor)
    silentMonitor.connect(context.destination)
    mixer.#sourceNodes.push(compressor, silentMonitor)

    if (microphoneStream) {
      const micTrack = microphoneStream.getAudioTracks()[0]
      if (micTrack) {
        const source = context.createMediaStreamSource(
          new MediaStream([micTrack]),
        )
        const gain = context.createGain()
        gain.gain.value = 1
        source.connect(gain)
        gain.connect(compressor)
        mixer.#sourceNodes.push(source, gain)
        mixer.#microphoneGain = gain
      }
    }

    if (systemAudioStream) {
      const systemTrack = systemAudioStream.getAudioTracks()[0]
      if (systemTrack) {
        const source = context.createMediaStreamSource(
          new MediaStream([systemTrack]),
        )
        const gain = context.createGain()
        gain.gain.value = 1
        source.connect(gain)
        gain.connect(compressor)
        mixer.#sourceNodes.push(source, gain)
        mixer.#systemAudioGain = gain
      }
    }

    return mixer
  }

  setMicrophoneMuted(muted: boolean): void {
    this.#setGain(this.#microphoneGain, muted ? 0 : 1)
  }

  setSystemAudioEnabled(enabled: boolean): void {
    this.#setGain(this.#systemAudioGain, enabled ? 1 : 0)
  }

  async resume(): Promise<void> {
    if (!this.#closed && this.#context.state === 'suspended') {
      await this.#context.resume()
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.setMicrophoneMuted(true)
    this.setSystemAudioEnabled(false)
    for (const node of this.#sourceNodes) {
      node.disconnect()
    }
    this.#sourceNodes = []
    this.stream.getTracks().forEach((track) => track.stop())
    await this.#context.close().catch(() => undefined)
  }

  #setGain(node: GainNode | null, value: number) {
    if (!node) return
    const now = this.#context.currentTime
    node.gain.cancelScheduledValues(now)
    node.gain.setTargetAtTime(value, now, 0.015)
  }
}

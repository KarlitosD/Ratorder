import {
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  Quality,
  type AudioCodec,
  type VideoCodec,
} from 'mediabunny'

export interface VideoCodecRequest {
  width: number
  height: number
  fps: number
  bitrate: number
}

export interface AudioCodecRequest {
  numberOfChannels: number
  sampleRate: number
  bitrate: number
}

export async function chooseVideoCodec(
  container: 'mp4' | 'webm',
  request: VideoCodecRequest,
): Promise<VideoCodec | null> {
  const candidates: VideoCodec[] =
    container === 'mp4' ? ['avc', 'av1', 'vp9', 'vp8'] : ['vp9', 'av1', 'vp8']
  return getFirstEncodableVideoCodec(candidates, {
    width: request.width,
    height: request.height,
    frameRate: request.fps,
    quality: new Quality({
      bitrate: request.bitrate,
      bitrateMode: 'variable',
    }),
  })
}

export async function chooseAudioCodec(
  container: 'mp4' | 'webm',
  request: AudioCodecRequest,
): Promise<AudioCodec | null> {
  const candidates: AudioCodec[] = container === 'mp4' ? ['aac', 'opus'] : ['opus']
  return getFirstEncodableAudioCodec(candidates, {
    numberOfChannels: request.numberOfChannels,
    sampleRate: request.sampleRate,
    quality: new Quality({ bitrate: request.bitrate }),
  })
}

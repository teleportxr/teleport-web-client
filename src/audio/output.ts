// WebAudio output for the audio_server_to_client channel.
// Phase 5 placeholder. Will own an AudioContext and an AudioWorkletNode that
// plays back PCM frames pushed in from the data channel.

export const DEFAULT_SAMPLE_RATE = 44100;
export const DEFAULT_BITS_PER_SAMPLE = 16;
export const DEFAULT_CHANNELS = 2;

export interface AudioOutputOptions {
  sampleRate?: number;
  bitsPerSample?: number;
  channels?: number;
}

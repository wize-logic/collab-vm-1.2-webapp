import { OpusDecoder } from 'opus-decoder';

interface OpusPlayerOptions {
  encoding?: '8bitInt' | '16bitInt' | '32bitInt' | '32bitFloat';
  channels?: number;
  sampleRate?: number;
  // lowered from 1000 ms to 20 ms so 10 ms Opus frames don’t sit in the buffer too long
  flushingTime?: number;
}

export class OpusPlayer {
  private option!: Required<OpusPlayerOptions>;
  private samples!: Float32Array;
  private intervalId!: number;
  private audioCtx!: AudioContext;
  private gainNode!: GainNode;
  private startTime!: number;

  private decoder: OpusDecoder;
  private decoderReady: Promise<void>;

  private _decodedSampleRate?: number;
  private _decodedChannels?: number;

  constructor(options: OpusPlayerOptions = {}) {
    this.initOptions(options);

    this.decoder = new OpusDecoder();
    this.decoderReady = this.decoder.ready;

    // Start the flush loop at a small interval (e.g. 20 ms)
    this.intervalId = window.setInterval(() => this.flush(), this.option.flushingTime);
  }

  private initOptions(options: OpusPlayerOptions) {
    this.option = {
      encoding: '16bitInt',
      channels: 2,
      sampleRate: 48000,
      flushingTime: 20, // flush every 20 ms by default
      ...options,
    };

    this.samples = new Float32Array(0);
    this.createContext();
  }

  private createContext() {
    this.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    this.gainNode = this.audioCtx.createGain();
    this.gainNode.connect(this.audioCtx.destination);
    this.startTime = this.audioCtx.currentTime;
    this.audioCtx.resume?.();
  }

  private isTypedArray(data: any): data is ArrayBufferView {
    return !!data && typeof data.byteLength === 'number' && data.buffer instanceof ArrayBuffer;
  }

  // Decode one Opus packet, buffer it for playback
  public async feed(data: ArrayBufferView) {
    if (!this.isTypedArray(data)) return;
    await this.decoderReady;

    const packet = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const { channelData, sampleRate } = this.decoder.decodeFrame(packet);

    if (this._decodedSampleRate == null) {
      this._decodedSampleRate = sampleRate;
      this._decodedChannels = channelData.length;
      /*
      console.log(
        `[OpusPlayer] Opus decoded at ${sampleRate} Hz, channels: ${this._decodedChannels}`
      );
      */
    }

    const ch = channelData.length;
    const len = channelData[0].length;
    const inter = new Float32Array(len * ch);
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < ch; c++) {
        inter[i * ch + c] = channelData[c][i];
      }
    }

    // Append decoded float PCM into internal buffer
    const buff = new Float32Array(this.samples.length + inter.length);
    buff.set(this.samples, 0);
    buff.set(inter, this.samples.length);
    this.samples = buff;
  }

  // Adjust playback volume (0.0 – 1.0)
  public volume(level: number) {
    this.gainNode.gain.value = level;
  }

  // Stop playback & clean up
  public destroy() {
    clearInterval(this.intervalId);
    this.samples = new Float32Array(0);
    this.audioCtx.close();
  }

  // Internal: push buffered samples into WebAudio
  private flush() {
    const sr = this._decodedSampleRate || this.option.sampleRate;
    const channels = this._decodedChannels || this.option.channels;
    const frameSamples = Math.floor((sr * this.option.flushingTime) / 1000); // e.g. 480 @ 20 ms
    const frameSize = frameSamples * channels;
  
    // How many full frames we have
    const fullFrames = Math.floor(this.samples.length / frameSize);
    if (fullFrames === 0) return;
  
    // Total samples to flush (only full frames)
    const totalSamples = fullFrames * frameSize;
  
    // Create one big AudioBuffer that’s an exact multiple of 20 ms
    const bufferLen = frameSamples * fullFrames;
    const audioBuffer = this.audioCtx.createBuffer(channels, bufferLen, sr);
  
    for (let c = 0; c < channels; c++) {
      const chData = audioBuffer.getChannelData(c);
      let readIdx = c;
      for (let i = 0; i < bufferLen; i++) {
        chData[i] = this.samples[readIdx];
        readIdx += channels;
      }
    }
  
    // Schedule it
    const src = this.audioCtx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(this.gainNode);
  
    // Make sure we start no earlier than now, and keep pushing at the correct intervals
    if (this.startTime < this.audioCtx.currentTime) {
      this.startTime = this.audioCtx.currentTime;
    }
    src.start(this.startTime);
    this.startTime += audioBuffer.duration;
  
    // Remove exactly the samples we just played, keep the remainder
    this.samples = this.samples.subarray(totalSamples);
  }  
}
// Audio-thread half of microphoneCapture.ts: downmixes and resamples to 16 kHz mono Float32,
// posting half-second chunks. Posts "limit" at five minutes and "stopped" once flushed.
import { PcmResampler } from "./pcmResampler";

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

const MAX_DICTATION_SAMPLES = 16_000 * 300;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  private readonly resampler = new PcmResampler(sampleRate);
  private chunk = new Float32Array(8_000);
  private length = 0;
  private recording = true;
  private samples = 0;

  constructor() {
    super();
    this.port.onmessage = ({ data }) => {
      if (data !== "stop") return;
      if (this.recording) this.append(this.resampler.flush());
      this.recording = false;
      if (this.length) this.publish();
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- AudioWorklet MessagePorts do not accept a target origin
      this.port.postMessage("stopped");
    };
  }

  private publish() {
    const pcm = this.chunk.slice(0, this.length);
    this.port.postMessage(pcm, [pcm.buffer]);
    this.length = 0;
  }

  private append(pcm: Float32Array) {
    for (const sample of pcm) {
      if (this.samples === MAX_DICTATION_SAMPLES) {
        this.recording = false;
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- AudioWorklet MessagePorts do not accept a target origin
        this.port.postMessage("limit");
        break;
      }
      this.chunk[this.length++] = sample;
      this.samples++;
      if (this.length === this.chunk.length) this.publish();
    }
  }

  process(inputs: Float32Array[][]): boolean {
    if (!this.recording) return true;
    const channels = inputs[0];
    if (!channels?.[0]) return true;
    const mono = new Float32Array(channels[0].length);
    for (const channel of channels)
      for (let i = 0; i < mono.length; i++) mono[i]! += channel[i]! / channels.length;
    this.append(this.resampler.push(mono));
    return true;
  }
}

registerProcessor("c3-pcm-capture", PcmCaptureProcessor);

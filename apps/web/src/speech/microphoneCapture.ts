import workletUrl from "./pcmWorklet.ts?worker&url";

export interface MicrophoneCapture {
  /** Stops recording and resolves the 16 kHz mono Float32 PCM bytes. */
  readonly stop: () => Promise<Uint8Array>;
  /** Stops recording and discards the audio. */
  readonly cancel: () => void;
}

export function concatPcm(chunks: readonly Float32Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const pcm = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    pcm.set(chunk, offset);
    offset += chunk.length;
  }
  return new Uint8Array(pcm.buffer);
}

/**
 * Opens the default microphone and records until stopped. `onLimit` fires when the five-minute
 * cap is reached; `onLost` when the microphone disconnects or processing fails.
 */
export async function openMicrophoneCapture(input: {
  readonly signal: AbortSignal;
  readonly onLimit: () => void;
  readonly onLost: (message: string) => void;
}): Promise<MicrophoneCapture> {
  const { signal } = input;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const chunks: Float32Array[] = [];
  let context: AudioContext | undefined;
  let node: AudioWorkletNode | undefined;
  let stopped: (() => void) | undefined;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    node?.disconnect();
    node?.port.close();
    stream.getTracks().forEach((track) => track.stop());
    void context?.close();
    stopped?.();
  };
  const onAbort = () => close();
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    signal.throwIfAborted();
    context = new AudioContext();
    await context.audioWorklet.addModule(workletUrl);
    signal.throwIfAborted();
    node = new AudioWorkletNode(context, "c3-pcm-capture", { channelCount: 1 });
    node.port.onmessage = ({ data }: MessageEvent<Float32Array | "stopped" | "limit">) => {
      if (data === "stopped") stopped?.();
      else if (data === "limit") input.onLimit();
      else chunks.push(data);
    };
    node.onprocessorerror = () => input.onLost("Microphone processing failed.");
    for (const track of stream.getTracks())
      track.addEventListener("ended", () => input.onLost("The microphone disconnected."), {
        once: true,
      });
    context.createMediaStreamSource(stream).connect(node);
    // The processor outputs silence; connecting it keeps the graph pulling audio.
    node.connect(context.destination);
    await context.resume();
    signal.throwIfAborted();
  } catch (error) {
    signal.removeEventListener("abort", onAbort);
    close();
    throw error;
  }

  return {
    stop: async () => {
      signal.removeEventListener("abort", onAbort);
      if (!closed && node) {
        const flushed = new Promise<void>((resolve) => {
          stopped = resolve;
        });
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- AudioWorklet MessagePorts do not accept a target origin
        node.port.postMessage("stop");
        // A suspended or crashed audio thread must not hold the transcript forever.
        await Promise.race([flushed, new Promise((resolve) => setTimeout(resolve, 2_000))]);
      }
      stopped = undefined;
      close();
      return concatPcm(chunks);
    },
    cancel: () => {
      signal.removeEventListener("abort", onAbort);
      chunks.length = 0;
      close();
    },
  };
}

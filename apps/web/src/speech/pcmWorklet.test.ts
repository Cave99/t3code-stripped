import { expect, it, vi } from "vite-plus/test";

it("records 16 kHz mono PCM, flushes on stop, and caps a recording at five minutes", async () => {
  using globals = new DisposableStack();
  const setGlobal = (name: string, value: unknown) => {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    globals.defer(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    });
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  };
  class Worklet {
    readonly port = {
      onmessage: null as ((event: { data: string }) => void) | null,
      postMessage: vi.fn<(data: unknown) => void>(),
    };
    process(_inputs: Float32Array[][]): boolean {
      return true;
    }
  }
  let Processor!: new () => Worklet;
  setGlobal("sampleRate", 16_000);
  setGlobal("AudioWorkletProcessor", Worklet);
  setGlobal("registerProcessor", (_name: string, processor: typeof Processor) => {
    Processor = processor;
  });
  await import("./pcmWorklet");

  const capture = new Processor();
  // Stereo input is averaged to mono.
  capture.process([[new Float32Array(128).fill(0.5), new Float32Array(128).fill(-0.5)]]);
  capture.port.onmessage?.({ data: "stop" });
  const messages = capture.port.postMessage.mock.calls.map(([data]) => data);
  expect(messages.at(-1)).toBe("stopped");
  const pcm = messages.find((data): data is Float32Array => data instanceof Float32Array);
  expect(pcm?.length).toBe(128);
  expect([...pcm!].every((sample) => sample === 0)).toBe(true);

  const long = new Processor();
  const block = new Float32Array(16_000);
  for (let second = 0; second < 301; second++) long.process([[block]]);
  const longMessages = long.port.postMessage.mock.calls.map(([data]) => data);
  expect(longMessages.filter((data) => data === "limit")).toHaveLength(1);
  const samples = longMessages
    .filter((data): data is Float32Array => data instanceof Float32Array)
    .reduce((sum, chunk) => sum + chunk.length, 0);
  expect(samples).toBe(16_000 * 300);
});

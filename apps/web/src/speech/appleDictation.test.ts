import type { DesktopAppleSpeechResult } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createDictationController,
  dictationInsertion,
  microphoneErrorMessage,
  type AppleSpeechBridge,
} from "./appleDictation";
import { concatPcm, type MicrophoneCapture } from "./microphoneCapture";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const pcm = concatPcm([new Float32Array([0.1, 0.2])]);

function fakeSetup(options?: {
  prepare?: DesktopAppleSpeechResult;
  transcribe?: () => Promise<DesktopAppleSpeechResult>;
  openError?: unknown;
  recorded?: Uint8Array;
}) {
  const capture = {
    stop: vi.fn(async () => options?.recorded ?? pcm),
    cancel: vi.fn(),
  } satisfies MicrophoneCapture;
  let captureInput!: Parameters<Parameters<typeof createDictationController>[0]["openCapture"]>[0];
  const speech = {
    supportedLocales: vi.fn(async () => ["en-US"]),
    prepare: vi.fn(async () => options?.prepare ?? { ok: true as const, value: "en-US" }),
    transcribe: vi.fn(
      options?.transcribe ?? (async () => ({ ok: true as const, value: " hello there " })),
    ),
    cancel: vi.fn(async () => {}),
  } satisfies AppleSpeechBridge;
  const transcripts: Array<[string, string]> = [];
  const controller = createDictationController<string>({
    speech,
    openCapture: async (input) => {
      captureInput = input;
      if (options?.openError) throw options.openError;
      return capture;
    },
    locale: () => "en-US",
    onTranscript: (target, text) => transcripts.push([target, text]),
  });
  return { controller, speech, capture, transcripts, captureInput: () => captureInput };
}

describe("dictation controller", () => {
  it("records, transcribes on this Mac, and delivers the trimmed transcript to its target", async () => {
    const { controller, speech, transcripts } = fakeSetup();
    await controller.start("thread-a");
    expect(controller.getState()).toEqual({ phase: "recording", error: null });
    expect(speech.prepare).toHaveBeenCalledWith({ locale: "en-US", install: false });
    await controller.stop();
    expect(speech.transcribe).toHaveBeenCalledWith({ locale: "en-US", pcm });
    expect(transcripts).toEqual([["thread-a", "hello there"]]);
    expect(controller.getState()).toEqual({ phase: "idle", error: null });
  });

  it("never downloads a missing model on its own and offers the install", async () => {
    const { controller, speech, capture } = fakeSetup();
    speech.prepare.mockResolvedValueOnce({ ok: false, code: "not-installed" });
    await controller.start("thread-a");
    expect(capture.cancel).toHaveBeenCalled();
    expect(controller.getState().phase).toBe("idle");
    expect(controller.getState().error?.installLocale).toBe("en-US");
    expect(speech.prepare).toHaveBeenCalledTimes(1);

    await expect(controller.install("en-US")).resolves.toBe(true);
    expect(speech.prepare).toHaveBeenLastCalledWith({ locale: "en-US", install: true });
    expect(controller.getState().error).toBeNull();
  });

  it("explains a denied microphone plainly", async () => {
    const { controller } = fakeSetup({
      openError: new DOMException("denied", "NotAllowedError"),
    });
    await controller.start("thread-a");
    expect(controller.getState().error?.message).toMatch(/Privacy & Security → Microphone/);
  });

  it("cancel discards the recording and sends nothing", async () => {
    const { controller, speech, capture, transcripts } = fakeSetup();
    await controller.start("thread-a");
    controller.cancel();
    expect(capture.cancel).toHaveBeenCalled();
    expect(controller.getState()).toEqual({ phase: "idle", error: null });
    await controller.stop();
    expect(speech.transcribe).not.toHaveBeenCalled();
    expect(transcripts).toEqual([]);
  });

  it("cancel during transcription kills the helper and drops its late result", async () => {
    const result = deferred<DesktopAppleSpeechResult>();
    const { controller, speech, transcripts } = fakeSetup({ transcribe: () => result.promise });
    await controller.start("thread-a");
    const stopping = controller.stop();
    await vi.waitFor(() => expect(speech.transcribe).toHaveBeenCalled());
    expect(controller.getState().phase).toBe("transcribing");
    controller.cancel();
    expect(speech.cancel).toHaveBeenCalled();
    result.resolve({ ok: true, value: "too late" });
    await stopping;
    expect(transcripts).toEqual([]);
    expect(controller.getState()).toEqual({ phase: "idle", error: null });
  });

  it("a stop that arrives while starting finishes as soon as recording begins", async () => {
    const prepared = deferred<DesktopAppleSpeechResult>();
    const { controller, speech, transcripts } = fakeSetup();
    speech.prepare.mockImplementationOnce(() => prepared.promise);
    const starting = controller.start("thread-a");
    await controller.stop();
    expect(speech.transcribe).not.toHaveBeenCalled();
    prepared.resolve({ ok: true, value: "en-US" });
    await starting;
    expect(transcripts).toEqual([["thread-a", "hello there"]]);
  });

  it("the five-minute cap stops and transcribes like a manual stop", async () => {
    const { controller, transcripts, captureInput } = fakeSetup();
    await controller.start("thread-a");
    captureInput().onLimit();
    await vi.waitFor(() => expect(transcripts).toEqual([["thread-a", "hello there"]]));
  });

  it("a lost microphone ends the session with its reason", async () => {
    const { controller, capture, captureInput } = fakeSetup();
    await controller.start("thread-a");
    captureInput().onLost("The microphone disconnected.");
    expect(capture.cancel).toHaveBeenCalled();
    expect(controller.getState()).toEqual({
      phase: "idle",
      error: { message: "The microphone disconnected." },
    });
  });

  it("an empty recording ends quietly without running the helper", async () => {
    const { controller, speech } = fakeSetup({ recorded: new Uint8Array(0) });
    await controller.start("thread-a");
    await controller.stop();
    expect(speech.transcribe).not.toHaveBeenCalled();
    expect(controller.getState()).toEqual({ phase: "idle", error: null });
  });
});

describe("dictationInsertion", () => {
  it.each([
    ["", 0, 0, "hello"],
    ["fix the", 7, 7, " hello"],
    ["fix the ", 8, 8, "hello"],
    ["the bug", 0, 0, "hello "],
    ["fix  now", 4, 4, "hello"],
    ["fix it.", 6, 6, " hello"],
    ["fix X now", 4, 5, "hello"],
  ])("inserts into %j at %i-%i as %j", (text, start, end, expected) => {
    expect(dictationInsertion(text, start, end, "hello")).toBe(expected);
  });
});

it("maps microphone errors to plain messages", () => {
  expect(microphoneErrorMessage(new DOMException("", "NotFoundError"))).toBe(
    "No microphone is connected.",
  );
  expect(microphoneErrorMessage(new Error("x"))).toBe("Couldn't start the microphone.");
});

import type { DesktopAppleSpeechResult, DesktopBridge } from "@t3tools/contracts";

import type { MicrophoneCapture } from "./microphoneCapture";

export type AppleSpeechBridge = NonNullable<DesktopBridge["appleSpeech"]>;

export type DictationPhase = "idle" | "starting" | "recording" | "transcribing";

export interface DictationError {
  readonly message: string;
  /** Set when the locale's on-device model is missing; installing it downloads from Apple. */
  readonly installLocale?: string;
}

export interface DictationState {
  readonly phase: DictationPhase;
  readonly error: DictationError | null;
}

export interface DictationDeps<Target> {
  readonly speech: AppleSpeechBridge;
  readonly openCapture: (input: {
    readonly signal: AbortSignal;
    readonly onLimit: () => void;
    readonly onLost: (message: string) => void;
  }) => Promise<MicrophoneCapture>;
  /** The Mac's language; the packaged app pins `navigator.language` to en-US. */
  readonly locale: () => string;
  readonly onTranscript: (target: Target, transcript: string) => void;
}

const IDLE: DictationState = { phase: "idle", error: null };

function failureMessage(
  result: Extract<DesktopAppleSpeechResult, { ok: false }>,
  locale: string,
): DictationError {
  switch (result.code) {
    case "unavailable":
      return { message: "Dictation needs macOS 26 or later with Apple Speech." };
    case "unsupported-locale":
      return { message: `Apple Speech can't transcribe ${locale} on this Mac.` };
    case "not-installed":
      return {
        message: `Apple's on-device speech model for ${locale} isn't installed. Downloading it fetches it from Apple once; after that dictation works offline.`,
        installLocale: locale,
      };
    case "failed":
      return { message: "Apple Speech couldn't transcribe the recording." };
  }
}

export function microphoneErrorMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "C3 Code can't use the microphone. Allow it in System Settings → Privacy & Security → Microphone, then try again.";
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return "No microphone is connected.";
  return "Couldn't start the microphone.";
}

/**
 * Where a transcript goes in a draft: at the selection, with a space on each side
 * unless the neighbor is already whitespace, or closing punctuation after it.
 */
export function dictationInsertion(
  text: string,
  start: number,
  end: number,
  transcript: string,
): string {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const lead = before.length > 0 && !/\s$/u.test(before) ? " " : "";
  const trail = after.length > 0 && !/^[\s.,;:!?)\]}]/u.test(after) ? " " : "";
  return `${lead}${transcript}${trail}`;
}

/**
 * One dictation at a time: record from the microphone, then transcribe on this Mac with
 * Apple Speech. The transcript goes to the target the recording started for, even if the
 * composer moved to another thread meanwhile.
 */
export function createDictationController<Target>(deps: DictationDeps<Target>) {
  let state = IDLE;
  const listeners = new Set<() => void>();
  interface Session {
    readonly target: Target;
    readonly abort: AbortController;
    capture?: MicrophoneCapture;
    locale?: string;
    stopRequested: boolean;
  }
  let session: Session | undefined;

  const set = (next: DictationState) => {
    state = next;
    listeners.forEach((listener) => listener());
  };
  const fail = (error: DictationError) => {
    session?.abort.abort();
    session?.capture?.cancel();
    session = undefined;
    set({ phase: "idle", error });
  };

  const stop = async () => {
    const current = session;
    if (!current) return;
    if (state.phase === "starting") {
      current.stopRequested = true;
      return;
    }
    if (state.phase !== "recording" || !current.capture || !current.locale) return;
    set({ phase: "transcribing", error: null });
    const pcm = await current.capture.stop();
    if (session !== current) return;
    if (pcm.byteLength === 0) {
      session = undefined;
      set(IDLE);
      return;
    }
    let result: DesktopAppleSpeechResult;
    try {
      result = await deps.speech.transcribe({ locale: current.locale, pcm });
    } catch {
      result = { ok: false, code: "failed" };
    }
    if (session !== current) return;
    session = undefined;
    if (!result.ok) {
      set({ phase: "idle", error: failureMessage(result, current.locale) });
      return;
    }
    set(IDLE);
    const transcript = result.value.trim();
    if (transcript) deps.onTranscript(current.target, transcript);
  };

  const start = async (target: Target) => {
    if (session) return;
    const current: Session = { target, abort: new AbortController(), stopRequested: false };
    session = current;
    set({ phase: "starting", error: null });
    const locale = deps.locale();
    // Open the microphone while the helper checks the model, so the first words are kept.
    const capture = deps
      .openCapture({
        signal: current.abort.signal,
        onLimit: () => {
          if (session === current) void stop();
        },
        onLost: (message) => {
          if (session === current) fail({ message });
        },
      })
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    let prepared: DesktopAppleSpeechResult;
    try {
      prepared = await deps.speech.prepare({ locale, install: false });
    } catch {
      prepared = { ok: false, code: "failed" };
    }
    const opened = await capture;
    if (session !== current) {
      if (opened.ok) opened.value.cancel();
      return;
    }
    if (opened.ok) current.capture = opened.value;
    if (!prepared.ok) {
      fail(failureMessage(prepared, locale));
      return;
    }
    if (!opened.ok) {
      fail({ message: microphoneErrorMessage(opened.error) });
      return;
    }
    current.locale = prepared.value;
    set({ phase: "recording", error: null });
    if (current.stopRequested) await stop();
  };

  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start,
    stop,
    /** Discards the recording, or stops a running transcription. */
    cancel: () => {
      const current = session;
      if (!current) return;
      const transcribing = state.phase === "transcribing";
      current.abort.abort();
      current.capture?.cancel();
      session = undefined;
      if (transcribing) void deps.speech.cancel().catch(() => {});
      set(IDLE);
    },
    dismissError: () => {
      if (state.error) set({ phase: state.phase, error: null });
    },
    /** Downloads the locale's on-device model from Apple; only on the user's request. */
    install: async (locale: string) => {
      set({ phase: state.phase, error: null });
      let result: DesktopAppleSpeechResult;
      try {
        result = await deps.speech.prepare({ locale, install: true });
      } catch {
        result = { ok: false, code: "failed" };
      }
      if (!result.ok) set({ phase: state.phase, error: failureMessage(result, locale) });
      return result.ok;
    },
  };
}

export type DictationController<Target> = ReturnType<typeof createDictationController<Target>>;

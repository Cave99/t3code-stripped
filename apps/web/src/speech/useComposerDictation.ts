import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useEffect, useRef, useSyncExternalStore } from "react";

import { type ComposerThreadTarget, useComposerDraftStore } from "../composerDraftStore";
import { isCommandPaletteOpen } from "../commandPaletteBus";
import { resolveShortcutCommand } from "../keybindings";
import { getTerminalFocusOwner } from "../lib/terminalFocus";
import {
  createDictationController,
  dictationInsertion,
  type DictationController,
  type DictationState,
} from "./appleDictation";
import { openMicrophoneCapture } from "./microphoneCapture";

type TranscriptHandler = (target: ComposerThreadTarget, transcript: string) => void;

let controller: DictationController<ComposerThreadTarget> | null | undefined;

/** Appends a transcript to a draft that is not on screen, such as the thread dictation started in. */
export function appendDictationToDraft(target: ComposerThreadTarget, transcript: string) {
  const store = useComposerDraftStore.getState();
  const prompt = store.getComposerDraft(target)?.prompt ?? "";
  store.setPrompt(
    target,
    prompt + dictationInsertion(prompt, prompt.length, prompt.length, transcript),
  );
}

let transcriptHandler: TranscriptHandler = appendDictationToDraft;

/** The app-wide dictation session, or null outside the macOS desktop app. */
function getController() {
  if (controller !== undefined) return controller;
  const speech = typeof window === "undefined" ? undefined : window.desktopBridge?.appleSpeech;
  controller = speech
    ? createDictationController<ComposerThreadTarget>({
        speech,
        openCapture: openMicrophoneCapture,
        locale: () => window.desktopBridge?.getSystemLocale?.() ?? navigator.language,
        onTranscript: (target, transcript) => transcriptHandler(target, transcript),
      })
    : null;
  return controller;
}

const IDLE: DictationState = { phase: "idle", error: null };
const noop = () => () => {};

export function useDictationState(): DictationState {
  const current = getController();
  return useSyncExternalStore(
    current?.subscribe ?? noop,
    current?.getState ?? (() => IDLE),
    () => IDLE,
  );
}

// Apple Speech answers only on macOS 26+ with the bundled helper; ask once, and again on focus
// while the answer is still "no" (a probe can time out on a busy Mac).
let available = false;
let probe: Promise<void> | undefined;
const availabilityListeners = new Set<() => void>();
function probeAvailability() {
  const speech = window.desktopBridge?.appleSpeech;
  if (available || probe || !speech) return;
  probe = speech
    .supportedLocales()
    .then((locales) => {
      if (locales.length === 0) return;
      available = true;
      availabilityListeners.forEach((notify) => notify());
    })
    .catch(() => {})
    .finally(() => {
      probe = undefined;
    });
}
function subscribeAvailability(listener: () => void) {
  if (availabilityListeners.size === 0) window.addEventListener("focus", probeAvailability);
  availabilityListeners.add(listener);
  probeAvailability();
  return () => {
    availabilityListeners.delete(listener);
    if (availabilityListeners.size === 0) window.removeEventListener("focus", probeAvailability);
  };
}

/** True in the macOS desktop app when on-device Apple Speech can dictate. */
export function useDictationAvailable(): boolean {
  return useSyncExternalStore(
    subscribeAvailability,
    () => available,
    () => false,
  );
}

const TOGGLE_EVENT = "c3code:toggle-dictation";

/** Lets the command palette start or finish dictation in the composer. */
export function requestDictationToggle(): void {
  window.dispatchEvent(new Event(TOGGLE_EVENT));
}

export const dictationActions = {
  stop: () => void getController()?.stop(),
  cancel: () => getController()?.cancel(),
  dismissError: () => getController()?.dismissError(),
  install: async (locale: string) => (await getController()?.install(locale)) ?? false,
};

function toggleDictation(target: ComposerThreadTarget, enabled: boolean) {
  const current = getController();
  if (!current) return;
  const { phase } = current.getState();
  if (phase === "idle") {
    if (enabled) void current.start(target);
  } else if (phase !== "transcribing") void current.stop();
}

const HOLD_THRESHOLD_MS = 300;

/** A short press toggles dictation; holding past this records until release. */
export function shouldFinishOnRelease(elapsedMs: number) {
  return elapsedMs >= HOLD_THRESHOLD_MS;
}

/** Escape inside a dialog that does not host the composer belongs to that dialog. */
export function escapeBelongsElsewhere(target: EventTarget | null, composer: Element | null) {
  if (!(target instanceof Element)) return false;
  const dialog = target.closest('[role="dialog"], [role="alertdialog"]');
  return dialog !== null && !dialog.contains(composer);
}

/**
 * Wires the composer to the dictation session: the button and palette toggle, the
 * `composer.dictation` shortcut (tap to toggle, hold to talk), Escape to cancel, and the
 * transcript handler. Only one composer is mounted, so it owns the handler.
 */
export function useComposerDictation(input: {
  readonly target: ComposerThreadTarget;
  readonly enabled: boolean;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly terminalOpen: boolean;
  readonly modelPickerOpen: boolean;
  readonly composerRef: React.RefObject<Element | null>;
  readonly onTranscript: TranscriptHandler;
}) {
  const latest = useRef(input);
  useEffect(() => {
    latest.current = input;
    transcriptHandler = input.onTranscript;
  });

  useEffect(() => {
    const current = getController();
    if (!current) return;
    let pressed: { code: string; modifiers: string[]; startedAt: number } | null = null;
    const release = (event: KeyboardEvent | null) => {
      const press = pressed;
      if (!press) return;
      // macOS can omit the letter keyup while Command is held; releasing a modifier ends it too.
      if (event && (event.code || event.key) !== press.code && !press.modifiers.includes(event.key))
        return;
      pressed = null;
      if (shouldFinishOnRelease(performance.now() - press.startedAt)) void current.stop();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || isCommandPaletteOpen()) return;
      const { phase } = current.getState();
      if (event.key === "Escape") {
        if (phase === "idle") return;
        if (escapeBelongsElsewhere(event.target, latest.current.composerRef.current)) return;
        event.preventDefault();
        event.stopPropagation();
        pressed = null;
        current.cancel();
        return;
      }
      const { keybindings, terminalOpen, modelPickerOpen } = latest.current;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: getTerminalFocusOwner() !== null,
          terminalOpen,
          modelPickerOpen,
        },
      });
      if (command !== "composer.dictation") return;
      if (phase === "idle" && !latest.current.enabled) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      pressed = null;
      if (phase !== "idle") {
        if (phase !== "transcribing") void current.stop();
        return;
      }
      pressed = {
        code: event.code || event.key,
        modifiers: ["Alt", "Control", "Meta", "Shift"].filter((key) => event.getModifierState(key)),
        startedAt: performance.now(),
      };
      void current.start(latest.current.target);
    };
    const onBlur = () => release(null);
    const toggle = () => toggleDictation(latest.current.target, latest.current.enabled);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", release, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener(TOGGLE_EVENT, toggle);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", release, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener(TOGGLE_EVENT, toggle);
    };
  }, []);

  // Dictation outlives the composer; a transcript that lands later goes straight to its draft.
  useEffect(
    () => () => {
      transcriptHandler = appendDictationToDraft;
    },
    [],
  );

  return { toggle: () => toggleDictation(input.target, input.enabled) };
}

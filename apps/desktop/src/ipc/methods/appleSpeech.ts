import {
  DesktopAppleSpeechPrepareInputSchema,
  DesktopAppleSpeechResultSchema,
  DesktopAppleSpeechTranscribeInputSchema,
} from "@t3tools/contracts";
import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as AppleSpeech from "../../speech/AppleSpeech.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

// Windows whose teardown already cancels their transcription.
const watchedOwners = new Set<number>();

/** A reloaded or closed window can no longer receive its transcript; kill its helper. */
function cancelWhenOwnerGoes(owner: number, cancel: Effect.Effect<void>) {
  if (watchedOwners.has(owner)) return;
  const contents = Electron.webContents?.fromId(owner);
  if (!contents) return;
  watchedOwners.add(owner);
  const release = () => {
    contents.off("did-start-navigation", onNavigate);
    watchedOwners.delete(owner);
    Effect.runFork(cancel);
  };
  const onNavigate = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
    if (details.isMainFrame && !details.isSameDocument) release();
  };
  contents.once("destroyed", release);
  contents.on("did-start-navigation", onNavigate);
}

export const appleSpeechAvailable = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.APPLE_SPEECH_AVAILABLE_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(Schema.String),
  handler: Effect.fn("desktop.ipc.appleSpeech.available")(function* () {
    return yield* (yield* AppleSpeech.AppleSpeech).supportedLocales;
  }),
});

export const appleSpeechPrepare = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.APPLE_SPEECH_PREPARE_CHANNEL,
  payload: DesktopAppleSpeechPrepareInputSchema,
  result: DesktopAppleSpeechResultSchema,
  handler: Effect.fn("desktop.ipc.appleSpeech.prepare")(function* (input) {
    return yield* (yield* AppleSpeech.AppleSpeech).prepare(input);
  }),
});

export const appleSpeechTranscribe = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.APPLE_SPEECH_TRANSCRIBE_CHANNEL,
  payload: DesktopAppleSpeechTranscribeInputSchema,
  result: DesktopAppleSpeechResultSchema,
  handler: Effect.fn("desktop.ipc.appleSpeech.transcribe")(function* ({ locale, pcm }, event) {
    const speech = yield* AppleSpeech.AppleSpeech;
    const owner = event?.sender.id ?? -1;
    cancelWhenOwnerGoes(owner, speech.cancel(owner));
    return yield* speech.transcribe(owner, locale, pcm);
  }),
});

export const appleSpeechCancel = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.APPLE_SPEECH_CANCEL_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.appleSpeech.cancel")(function* (_input, event) {
    yield* (yield* AppleSpeech.AppleSpeech).cancel(event?.sender.id ?? -1);
  }),
});

export const methods = [
  appleSpeechAvailable,
  appleSpeechPrepare,
  appleSpeechTranscribe,
  appleSpeechCancel,
] as const;

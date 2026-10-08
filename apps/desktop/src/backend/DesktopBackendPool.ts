// Owns the single local backend instance the desktop app runs. The window
// follows its readiness through the onReady/onShutdown callbacks.

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import * as DesktopBackendManager from "./DesktopBackendManager.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

const { logWarning: logBackendPoolWarning } =
  DesktopObservability.makeComponentLogger("desktop-backend-pool");

export type BackendInstanceId = DesktopBackendManager.BackendInstanceId;
export const BackendInstanceId = DesktopBackendManager.BackendInstanceId;
export type DesktopBackendInstance = DesktopBackendManager.DesktopBackendInstance;

export class DesktopBackendPool extends Context.Service<
  DesktopBackendPool,
  {
    readonly primary: Effect.Effect<DesktopBackendInstance>;
  }
>()("@t3tools/desktop/backend/DesktopBackendPool") {}

export const layer = Layer.effect(
  DesktopBackendPool,
  Effect.gen(function* () {
    const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
    const desktopWindow = yield* DesktopWindow.DesktopWindow;

    const primary = yield* DesktopBackendManager.makeBackendInstance({
      id: DesktopBackendManager.PRIMARY_INSTANCE_ID,
      // Keep this lazy. The pool layer is initialized before startup loads
      // persisted desktop settings, so resolving the primary label here would
      // permanently capture DEFAULT_DESKTOP_SETTINGS and mislabel WSL-only
      // primaries as Windows.
      label: configuration.resolvePrimaryLabel,
      configResolve: configuration.resolvePrimary,
      // Window creation errors propagating out of handleBackendReady must
      // not block the readiness callback (that would prevent restartAttempt
      // from being reset), so we absorb them here. The window service only
      // logs on success, so log the failure here before swallowing it —
      // otherwise a post-readiness window-open failure vanishes silently and
      // is near-impossible to diagnose in production.
      onReady: (httpBaseUrl) =>
        desktopWindow.handleBackendReady(httpBaseUrl).pipe(
          Effect.catch((error) =>
            logBackendPoolWarning("failed to open main window after backend readiness", {
              error: error.message,
            }),
          ),
        ),
      onShutdown: () => desktopWindow.handleBackendNotReady,
    });

    return DesktopBackendPool.of({ primary: Effect.succeed(primary) });
  }),
);

export const layerTest = (primary: DesktopBackendInstance): Layer.Layer<DesktopBackendPool> =>
  Layer.succeed(DesktopBackendPool, DesktopBackendPool.of({ primary: Effect.succeed(primary) }));

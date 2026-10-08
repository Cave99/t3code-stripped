import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

/** The bundled backend only ever listens on loopback; nothing is exposed to the network. */
const DESKTOP_LOOPBACK_HOST = "127.0.0.1";

export interface DesktopServerExposureBackendConfig {
  readonly port: number;
  readonly bindHost: string;
  readonly httpBaseUrl: URL;
}

export class DesktopServerExposure extends Context.Service<
  DesktopServerExposure,
  {
    readonly backendConfig: Effect.Effect<DesktopServerExposureBackendConfig>;
    readonly configureFromSettings: (input: { readonly port: number }) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/backend/DesktopServerExposure") {}

const loopbackConfig = (port: number): DesktopServerExposureBackendConfig => ({
  port,
  bindHost: DESKTOP_LOOPBACK_HOST,
  httpBaseUrl: new URL(`http://${DESKTOP_LOOPBACK_HOST}:${port}`),
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const configRef = yield* Ref.make(loopbackConfig(0));
  return DesktopServerExposure.of({
    backendConfig: Ref.get(configRef),
    configureFromSettings: ({ port }) => Ref.set(configRef, loopbackConfig(port)),
  });
});

export const layer = Layer.effect(DesktopServerExposure, make);

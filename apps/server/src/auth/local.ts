import { EnvironmentAuthenticatedAuth, EnvironmentAuthInvalidError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeCrypto from "node:crypto";
import { HttpServerRequest } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";

/** Origins owned by the Electron renderer, including its development server. */
export function desktopOrigins(config: Pick<ServerConfig.ServerConfig["Service"], "devUrl">) {
  return ["t3code://app", "t3code-dev://app", ...(config.devUrl ? [config.devUrl.origin] : [])];
}

/** The secret arrives through the desktop's private bootstrap pipe, never persisted. */
export const authenticateLocalRequest = Effect.fn("authenticateLocalRequest")(function* (
  request: HttpServerRequest.HttpServerRequest,
  transport: "http" | "websocket",
) {
  const config = yield* ServerConfig.ServerConfig;
  const origin = request.headers.origin;
  const url = HttpServerRequest.toURL(request);
  const presented =
    transport === "websocket"
      ? Option.isSome(url)
        ? url.value.searchParams.get("token")
        : null
      : request.headers.authorization?.startsWith("Bearer ")
        ? request.headers.authorization.slice(7)
        : undefined;
  const expected = config.desktopBootstrapToken;
  const left = Buffer.from(presented ?? "");
  const right = Buffer.from(expected ?? "");
  if (
    !expected ||
    !presented ||
    left.length !== right.length ||
    !NodeCrypto.timingSafeEqual(left, right) ||
    (origin !== undefined && !desktopOrigins(config).includes(origin))
  ) {
    return yield* new EnvironmentAuthInvalidError({
      code: "auth_invalid",
      reason: presented ? "invalid_credential" : "missing_credential",
      traceId: "unavailable",
    });
  }
});

export const localAuthHttpLayer = Layer.effect(
  EnvironmentAuthenticatedAuth,
  Effect.map(
    ServerConfig.ServerConfig,
    (config) => (httpEffect) =>
      Effect.gen(function* () {
        yield* authenticateLocalRequest(yield* HttpServerRequest.HttpServerRequest, "http");
        return yield* httpEffect;
      }).pipe(Effect.provideService(ServerConfig.ServerConfig, config)),
  ),
);

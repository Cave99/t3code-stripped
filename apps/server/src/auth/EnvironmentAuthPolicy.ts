import type { ServerAuthDescriptor } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { resolveSessionCookieName } from "./utils.ts";

export class EnvironmentAuthPolicy extends Context.Service<
  EnvironmentAuthPolicy,
  {
    readonly getDescriptor: () => Effect.Effect<ServerAuthDescriptor>;
  }
>()("t3/auth/EnvironmentAuthPolicy") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  // The backend only ever listens on loopback and is reached by the desktop
  // renderer, which exchanges the bootstrap token handed over on fd 3.
  const descriptor: ServerAuthDescriptor = {
    policy: "desktop-managed-local",
    bootstrapMethods: ["desktop-bootstrap"],
    sessionMethods: ["browser-session-cookie", "bearer-access-token", "dpop-access-token"],
    sessionCookieName: resolveSessionCookieName({ port: config.port }),
  };

  return EnvironmentAuthPolicy.of({
    getDescriptor: () =>
      Effect.succeed(descriptor).pipe(Effect.withSpan("EnvironmentAuthPolicy.getDescriptor")),
  });
});

export const layer = Layer.effect(EnvironmentAuthPolicy, make);

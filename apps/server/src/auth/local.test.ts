import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { EnvironmentAuthenticatedAuth } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest, HttpRouter } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import { authenticateLocalRequest, localAuthHttpLayer } from "./local.ts";

class ProtectedApi extends HttpApi.make("protected").add(
  HttpApiGroup.make("protected").add(
    HttpApiEndpoint.get("read", "/api/test", { success: Schema.String }).middleware(
      EnvironmentAuthenticatedAuth,
    ),
  ),
) {}

const secret = "launch-secret-123";
const configLayer = () =>
  ServerConfig.layerTest(process.cwd(), { prefix: "local-auth-" }).pipe(
    Layer.provide(NodeServices.layer),
  );

const authenticate = (input: {
  readonly transport: "http" | "websocket";
  readonly token?: string;
  readonly origin?: string;
  readonly expected?: string;
  readonly devOrigin?: string;
  readonly cookie?: string;
}) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const url = new URL("http://127.0.0.1:3773/ws");
    if (input.transport === "websocket" && input.token !== undefined)
      url.searchParams.set("token", input.token);
    const headers = new Headers();
    if (input.transport === "http" && input.token !== undefined)
      headers.set("authorization", `Bearer ${input.token}`);
    if (input.origin !== undefined) headers.set("origin", input.origin);
    if (input.cookie !== undefined) headers.set("cookie", input.cookie);
    return yield* authenticateLocalRequest(
      HttpServerRequest.fromWeb(new Request(url, { headers })),
      input.transport,
    ).pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        ...config,
        desktopBootstrapToken: input.expected ?? secret,
        devUrl: input.devOrigin ? new URL(input.devOrigin) : undefined,
      }),
    );
  }).pipe(Effect.provide(configLayer()));

describe("desktop launch authentication", () => {
  const transports = ["http", "websocket"] as const;
  it.effect.each(transports)(
    "%s accepts the launch secret from desktop origins and native clients",
    (transport) =>
      Effect.gen(function* () {
        for (const origin of [
          undefined,
          "t3code://app",
          "t3code-dev://app",
          "http://localhost:5173",
        ]) {
          yield* authenticate({
            transport,
            token: secret,
            ...(origin ? { origin } : {}),
            devOrigin: "http://localhost:5173",
          });
        }
      }),
  );
  it.effect.each(transports)(
    "%s rejects absent, wrong, expired-launch, and unconfigured credentials",
    (transport) =>
      Effect.gen(function* () {
        for (const token of [undefined, "wrong", "launch-secret-124"]) {
          const error = yield* Effect.flip(
            authenticate({ transport, ...(token ? { token } : {}) }),
          );
          expect(error._tag).toBe("EnvironmentAuthInvalidError");
        }
        const error = yield* Effect.flip(authenticate({ transport, token: secret, expected: "" }));
        expect(error._tag).toBe("EnvironmentAuthInvalidError");
      }),
  );
  it.effect.each(transports)(
    "%s rejects other web pages even with the correct secret",
    (transport) =>
      Effect.gen(function* () {
        for (const origin of [
          "https://evil.example",
          "http://localhost:9999",
          "http://127.0.0.1:3773",
          "null",
        ]) {
          const error = yield* Effect.flip(authenticate({ transport, token: secret, origin }));
          expect(error._tag).toBe("EnvironmentAuthInvalidError");
        }
      }),
  );
  it.effect.each(transports)("%s never accepts a legacy session cookie", (transport) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        authenticate({ transport, cookie: `t3_session_3773=${secret}` }),
      );
      expect(error.reason).toBe("missing_credential");
    }),
  );
});

it.effect("protects HTTP endpoints before their handlers run", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const handlerLayer = HttpApiBuilder.group(ProtectedApi, "protected", (handlers) =>
      handlers.handle("read", () => Effect.succeed("protected-result")),
    );
    const routes = HttpApiBuilder.layer(ProtectedApi).pipe(
      Layer.provide(handlerLayer),
      Layer.provide(localAuthHttpLayer),
      Layer.provide(
        Layer.succeed(ServerConfig.ServerConfig, { ...config, desktopBootstrapToken: secret }),
      ),
      Layer.provide(NodeHttpServer.layerHttpServices),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
    yield* Effect.acquireUseRelease(
      Effect.void,
      () =>
        Effect.promise(async () => {
          for (const [authorization, origin, status] of [
            [undefined, "t3code://app", 401],
            ["Bearer wrong", "t3code://app", 401],
            [`Bearer ${secret}`, "https://evil.example", 401],
            [`Bearer ${secret}`, "t3code://app", 200],
          ] as const) {
            const response = await handler(
              new Request("http://127.0.0.1:3773/api/test", {
                headers: { origin, ...(authorization ? { authorization } : {}) },
              }),
            );
            expect(response.status).toBe(status);
            if (status === 200) expect(await response.json()).toBe("protected-result");
          }
        }),
      () => Effect.promise(dispose),
    );
  }).pipe(Effect.provide(configLayer())),
);

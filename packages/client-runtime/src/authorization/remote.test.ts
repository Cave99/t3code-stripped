import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { resolveRemoteWebSocketConnectionUrl } from "./remote.ts";

describe("local WebSocket credentials", () => {
  it.effect("carries the launch secret directly without an HTTP exchange", () =>
    Effect.gen(function* () {
      const result = yield* resolveRemoteWebSocketConnectionUrl({
        wsBaseUrl: "ws://127.0.0.1:3773",
        bearerToken: "secret+with/symbols=",
        clientMetadata: { surface: "desktop", appVersion: "1.0" },
        connectionMethod: "direct",
      });
      const url = new URL(result);
      expect(url.pathname).toBe("/ws");
      expect(url.searchParams.get("token")).toBe("secret+with/symbols=");
      expect(url.searchParams.get("clientSurface")).toBe("desktop");
      expect(url.searchParams.has("wsTicket")).toBe(false);
    }),
  );
});

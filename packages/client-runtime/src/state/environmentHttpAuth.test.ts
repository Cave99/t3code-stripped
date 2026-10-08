import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  type AuthSessionState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  PrimaryConnectionTarget,
  type PreparedConnection,
  type PreparedHttpAuthorization,
} from "../connection/model.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import { withOrchestrationProtocolHeader } from "./environmentHttpAuth.ts";
import { fetchEnvironmentSessionState } from "./session.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Local environment",
  httpBaseUrl: "http://127.0.0.1:3773",
  wsBaseUrl: "ws://127.0.0.1:3773",
});
const prepared = (httpAuthorization: PreparedHttpAuthorization | null): PreparedConnection => ({
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: "ws://127.0.0.1:3773/ws",
  httpAuthorization,
  target: TARGET,
});
const SESSION = {
  authenticated: true,
  auth: {
    policy: "loopback-browser",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["browser-session-cookie", "bearer-access-token"],
    sessionCookieName: "t3_session",
  },
  scopes: ["orchestration:read", "orchestration:operate"],
  sessionMethod: "browser-session-cookie",
} satisfies AuthSessionState;

const requestSession = (httpAuthorization: PreparedHttpAuthorization | null) => {
  const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
  const fetchFn: typeof fetch = async (request, init) => {
    calls.push({ url: String(request), init: init ?? {} });
    return Response.json(SESSION);
  };
  return fetchEnvironmentSessionState({ prepared: prepared(httpAuthorization) }).pipe(
    Effect.provide(remoteHttpClientLayer(fetchFn)),
    Effect.map((session) => ({ session, calls })),
  );
};

describe("authenticated environment HTTP requests", () => {
  it.effect("sends the bearer token for bearer connections", () =>
    Effect.gen(function* () {
      const { session, calls } = yield* requestSession({ _tag: "Bearer", token: "token-1" });
      expect(session).toEqual(SESSION);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("http://127.0.0.1:3773/api/auth/session");
      expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer token-1");
    }),
  );

  it.effect("relies on the session cookie when there is no bearer token", () =>
    Effect.gen(function* () {
      const { calls } = yield* requestSession(null);
      expect(new Headers(calls[0]?.init.headers).has("authorization")).toBe(false);
    }),
  );
});

describe("orchestration HTTP compatibility header", () => {
  it("announces the current protocol without replacing bearer authentication", () => {
    expect(withOrchestrationProtocolHeader({ authorization: "Bearer access-token" })).toEqual({
      authorization: "Bearer access-token",
      [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
    });
  });
});

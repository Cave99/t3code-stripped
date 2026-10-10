import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  PrimaryConnectionTarget,
  type PreparedConnection,
  type PreparedHttpAuthorization,
} from "../connection/model.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import {
  executeAuthenticatedEnvironmentHttpRequest,
  withOrchestrationProtocolHeader,
} from "./environmentHttpAuth.ts";

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
const SNAPSHOT = { projects: [], updatedAt: "2026-10-10T00:00:00.000Z" };

const requestSession = (httpAuthorization: PreparedHttpAuthorization | null) => {
  const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
  const fetchFn: typeof fetch = async (request, init) => {
    calls.push({ url: String(request), init: init ?? {} });
    return Response.json(SNAPSHOT);
  };
  return executeAuthenticatedEnvironmentHttpRequest({
    prepared: prepared(httpAuthorization),
    group: "projects",
    method: "GET",
    timeoutMs: 1000,
    url: (base) => new URL("/api/projects", base).href,
    request: ({ client, headers }) => client.snapshot({ headers }),
  }).pipe(
    Effect.provide(remoteHttpClientLayer(fetchFn)),
    Effect.map((session) => ({ session, calls })),
  );
};

describe("authenticated environment HTTP requests", () => {
  it.effect("sends the bearer token for bearer connections", () =>
    Effect.gen(function* () {
      const { session, calls } = yield* requestSession({ _tag: "Bearer", token: "token-1" });
      expect(session).toEqual(SNAPSHOT);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("http://127.0.0.1:3773/api/projects");
      expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer token-1");
    }),
  );

  it.effect("never sends cookies when there is no credential", () =>
    Effect.gen(function* () {
      const { calls } = yield* requestSession(null);
      expect(new Headers(calls[0]?.init.headers).has("authorization")).toBe(false);
      expect(calls[0]?.init.credentials).toBe("omit");
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

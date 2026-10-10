import * as Effect from "effect/Effect";
import {
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
} from "@t3tools/contracts";
import { FetchHttpClient, type HttpMethod } from "effect/unstable/http";

import type { PreparedConnection } from "../connection/model.ts";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiGroupClient,
  RemoteEnvironmentAuthTimeoutError,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";

export interface EnvironmentHttpAuthHeaders {
  readonly authorization?: string;
}

export function withOrchestrationProtocolHeader(
  headers: EnvironmentHttpAuthHeaders,
): EnvironmentHttpAuthHeaders & {
  readonly [ORCHESTRATION_PROTOCOL_HEADER]: typeof ORCHESTRATION_PROTOCOL_VERSION_TEXT;
} {
  return {
    ...headers,
    [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  };
}

/**
 * Run an environment HTTP request with the desktop launch secret in a Bearer header.
 */
export const executeAuthenticatedEnvironmentHttpRequest = Effect.fn(
  "clientRuntime.state.executeAuthenticatedEnvironmentHttpRequest",
)(function* <
  Group extends Parameters<typeof makeEnvironmentHttpApiGroupClient>[1],
  A,
  E,
  R,
>(input: {
  readonly prepared: PreparedConnection;
  readonly method: HttpMethod.HttpMethod;
  readonly url: (httpBaseUrl: string) => string;
  readonly timeoutMs: number;
  readonly group: Group;
  readonly request: (input: {
    readonly client: Effect.Success<ReturnType<typeof makeEnvironmentHttpApiGroupClient<Group>>>;
    readonly headers: EnvironmentHttpAuthHeaders;
  }) => Effect.Effect<A, E, R>;
}): Effect.fn.Return<
  A,
  RemoteEnvironmentRequestError,
  Effect.Services<ReturnType<typeof makeEnvironmentHttpApiGroupClient<Group>>> | R
> {
  const { httpBaseUrl, httpAuthorization: authorization } = input.prepared;
  const requestUrl = input.url(httpBaseUrl);
  const client = yield* makeEnvironmentHttpApiGroupClient(httpBaseUrl, input.group);
  const headers: EnvironmentHttpAuthHeaders =
    authorization === null ? {} : { authorization: `Bearer ${authorization.token}` };
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs,
    input
      .request({ client, headers })
      .pipe(Effect.provideService(FetchHttpClient.RequestInit, { credentials: "omit" })),
  ).pipe(
    Effect.timeoutOrElse({
      duration: input.timeoutMs,
      orElse: () => Effect.fail(new RemoteEnvironmentAuthTimeoutError(requestUrl, input.timeoutMs)),
    }),
  );
});

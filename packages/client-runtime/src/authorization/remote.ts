import type { AuthClientPresentationMetadata } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
export type { RemoteEnvironmentRequestError as RemoteEnvironmentAuthError } from "../rpc/http.ts";

export const resolveRemoteWebSocketConnectionUrl = (input: {
  readonly wsBaseUrl: string;
  readonly bearerToken: string;
  readonly clientMetadata?: AuthClientPresentationMetadata;
}) =>
  Effect.sync(() => {
    const url = new URL(input.wsBaseUrl);
    if (url.pathname === "" || url.pathname === "/") url.pathname = "/ws";
    url.searchParams.set("token", input.bearerToken);
    if (input.clientMetadata?.surface)
      url.searchParams.set("clientSurface", input.clientMetadata.surface);
    if (input.clientMetadata?.appVersion)
      url.searchParams.set("clientAppVersion", input.clientMetadata.appVersion);
    return url.toString();
  });

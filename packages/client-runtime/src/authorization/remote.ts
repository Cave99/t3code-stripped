import type { AuthClientPresentationMetadata, ClientConnectionMethod } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
export type { RemoteEnvironmentRequestError as RemoteEnvironmentAuthError } from "../rpc/http.ts";

const appendClientConnectionParams = (
  url: URL,
  clientMetadata: AuthClientPresentationMetadata | undefined,
  connectionMethod?: ClientConnectionMethod,
): void => {
  if (clientMetadata?.surface) {
    url.searchParams.set("clientSurface", clientMetadata.surface);
  }
  if (clientMetadata?.appVersion) {
    url.searchParams.set("clientAppVersion", clientMetadata.appVersion);
  }
  if (clientMetadata?.deviceType) {
    const deviceType =
      clientMetadata.deviceType === "mobile"
        ? "phone"
        : clientMetadata.deviceType === "desktop" || clientMetadata.deviceType === "tablet"
          ? clientMetadata.deviceType
          : "unknown";
    url.searchParams.set("clientDeviceType", deviceType);
  }
  if (clientMetadata?.os) {
    url.searchParams.set("clientOs", clientMetadata.os);
  }
  if (clientMetadata?.surface === "web") {
    if (clientMetadata.webDeployment) {
      url.searchParams.set("clientWebDeployment", clientMetadata.webDeployment);
    }
    if (clientMetadata.browser) {
      url.searchParams.set("clientBrowser", clientMetadata.browser);
    }
  }
  if (clientMetadata?.surface === "mobile") {
    if (clientMetadata.osMajorVersion !== undefined) {
      url.searchParams.set("clientOsMajorVersion", String(clientMetadata.osMajorVersion));
    }
    if (clientMetadata.deviceModel) {
      url.searchParams.set("clientDeviceModel", clientMetadata.deviceModel);
    }
  }
  if (connectionMethod) {
    url.searchParams.set("connectionMethod", connectionMethod);
  }
};

export const resolveRemoteWebSocketConnectionUrl = (input: {
  readonly wsBaseUrl: string;
  readonly bearerToken: string;
  readonly clientMetadata?: AuthClientPresentationMetadata;
  readonly connectionMethod?: ClientConnectionMethod;
}) =>
  Effect.sync(() => {
    const url = new URL(input.wsBaseUrl);
    if (url.pathname === "" || url.pathname === "/") url.pathname = "/ws";
    url.searchParams.set("token", input.bearerToken);
    appendClientConnectionParams(url, input.clientMetadata, input.connectionMethod);
    return url.toString();
  });

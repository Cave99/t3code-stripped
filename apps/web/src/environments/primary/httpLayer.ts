import { remoteHttpClientLayer } from "@t3tools/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { readDesktopPrimaryBearerToken } from "./desktopAuth";

export function makePrimaryEnvironmentHttpLayer() {
  const bearerClientLayer = Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, (client) =>
      client.pipe(
        HttpClient.mapRequestEffect((request) =>
          Effect.promise(readDesktopPrimaryBearerToken).pipe(
            Effect.map((token) =>
              token ? HttpClientRequest.bearerToken(request, token) : request,
            ),
          ),
        ),
      ),
    ),
  ).pipe(Layer.provide(remoteHttpClientLayer(globalThis.fetch)));
  return Layer.merge(
    bearerClientLayer,
    Layer.succeed(FetchHttpClient.RequestInit, { credentials: "omit" }),
  );
}
export const primaryEnvironmentHttpLayer = makePrimaryEnvironmentHttpLayer();

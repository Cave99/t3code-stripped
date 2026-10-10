import {
  ClientCapabilities,
  PlatformConnectionSource,
  Persistence,
} from "@t3tools/client-runtime/platform";
import {
  ConnectionTransientError,
  Connectivity,
  mapRemoteEnvironmentError,
  type PlatformConnectionRegistration,
  PrimaryConnectionRegistration,
  PrimaryConnectionTarget,
  Wakeups,
} from "@t3tools/client-runtime/connection";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import { EnvironmentRpcRequestObserver } from "@t3tools/client-runtime/rpc";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/unstable/http";

import { APP_VERSION } from "../branding";
import { readDesktopPrimaryBearerToken } from "../environments/primary/desktopAuth";
import { primaryEnvironmentHttpLayer } from "../environments/primary/httpLayer";
import {
  readPrimaryEnvironmentTarget,
  type PrimaryEnvironmentTarget,
} from "../environments/primary/target";
import { clearComposerDraftsEnvironment } from "../composerDraftStore";
import { isLocalEnvironmentDisabled } from "../localEnvironment";
import { acknowledgeRpcRequest, trackRpcRequestSent } from "../rpc/requestLatencyState";
import { connectionStorageLayer } from "./storage";
import { clientPresentationMetadata } from "./clientMetadata";

let nextObservedRpcRequestId = 0;

function currentNetworkStatus(): "unknown" | "offline" | "online" {
  if (typeof navigator === "undefined") {
    return "unknown";
  }
  return navigator.onLine ? "online" : "offline";
}

const connectivityLayer = Connectivity.layer({
  status: Effect.sync(currentNetworkStatus),
  changes: Stream.callback((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const online = () => Queue.offerUnsafe(queue, "online");
        const offline = () => Queue.offerUnsafe(queue, "offline");
        window.addEventListener("online", online);
        window.addEventListener("offline", offline);
        return { online, offline };
      }),
      ({ online, offline }) =>
        Effect.sync(() => {
          window.removeEventListener("online", online);
          window.removeEventListener("offline", offline);
        }),
    ).pipe(Effect.asVoid),
  ),
});

const wakeupsLayer = Wakeups.layer({
  changes: Stream.callback<"application-active">((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const listener = () => {
          if (document.visibilityState === "visible") {
            Queue.offerUnsafe(queue, "application-active");
          }
        };
        document.addEventListener("visibilitychange", listener);
        return listener;
      }),
      (listener) =>
        Effect.sync(() => {
          document.removeEventListener("visibilitychange", listener);
        }),
    ).pipe(Effect.asVoid),
  ),
});

function clientMetadata() {
  return clientPresentationMetadata({
    appVersion: APP_VERSION,
    hosted: false,
    identity: {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      maxTouchPoints: navigator.maxTouchPoints,
    },
    desktopBridge: window.desktopBridge,
  });
}

const capabilitiesLayer = Layer.effectContext(
  Effect.sync(() => {
    const presentation = ClientCapabilities.ClientPresentation.of({
      metadata: clientMetadata(),
    });
    const primaryAuth = ClientCapabilities.PrimaryEnvironmentAuth.of({
      bearerToken: Effect.tryPromise({
        try: readDesktopPrimaryBearerToken,
        catch: (cause) =>
          new ConnectionTransientError({
            reason: "remote-unavailable",
            detail: `Could not load the desktop primary credential: ${String(cause)}`,
          }),
      }).pipe(Effect.map(Option.fromNullishOr)),
    });
    return Context.make(ClientCapabilities.PrimaryEnvironmentAuth, primaryAuth).pipe(
      Context.add(ClientCapabilities.ClientPresentation, presentation),
    );
  }),
);

const loadPrimaryConnectionRegistration = Effect.fn(
  "web.connectionPlatform.loadPrimaryConnectionRegistration",
)(function* (resolved: PrimaryEnvironmentTarget) {
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({
    httpBaseUrl: resolved.target.httpBaseUrl,
  }).pipe(Effect.provide(primaryEnvironmentHttpLayer), Effect.mapError(mapRemoteEnvironmentError));
  return new PrimaryConnectionRegistration({
    target: new PrimaryConnectionTarget({
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      httpBaseUrl: resolved.target.httpBaseUrl,
      wsBaseUrl: resolved.target.wsBaseUrl,
    }),
  });
});

// Poll cadence for the desktop bootstrap topology. There is no change event on
// the bridge, so the renderer polls; the registration is cached by a signature
// of its endpoints.
const PLATFORM_POLL_INTERVAL = "3 seconds";

interface CachedPlatformRegistration {
  readonly signature: string;
  readonly registration: PlatformConnectionRegistration;
}

export type PrimaryEnvironmentTargetRead =
  | {
      readonly _tag: "Success";
      readonly target: PrimaryEnvironmentTarget | null;
    }
  | {
      readonly _tag: "Failure";
      readonly cause: unknown;
    };

export function readPrimaryEnvironmentTargetResult(
  readTarget: () => PrimaryEnvironmentTarget | null = readPrimaryEnvironmentTarget,
): PrimaryEnvironmentTargetRead {
  try {
    return { _tag: "Success", target: readTarget() };
  } catch (cause) {
    return { _tag: "Failure", cause };
  }
}

const platformConnectionSourceLayer = Layer.effect(
  PlatformConnectionSource.PlatformConnectionSource,
  Effect.gen(function* () {
    if (isLocalEnvironmentDisabled()) {
      return PlatformConnectionSource.PlatformConnectionSource.of({
        registrations: Stream.empty,
      });
    }
    const cacheRef = yield* Ref.make(Option.none<CachedPlatformRegistration>());

    // Resolve the primary environment the desktop reports. A failed topology
    // read keeps the previous registration; a failed discovery is skipped and
    // retried on the next poll.
    const resolvePrimaryRegistration = Effect.gen(function* () {
      const previous = yield* Ref.get(cacheRef);
      const topologyRead = readPrimaryEnvironmentTargetResult();
      if (topologyRead._tag === "Failure") {
        yield* Effect.logWarning("Could not read the primary environment topology.", {
          cause: topologyRead.cause,
        });
        return previous;
      }
      if (topologyRead.target === null) {
        return Option.none();
      }
      const primaryTarget = topologyRead.target;
      const signature = `${primaryTarget.target.httpBaseUrl}|${primaryTarget.target.wsBaseUrl}`;
      if (Option.isSome(previous) && previous.value.signature === signature) {
        return previous;
      }
      const built = yield* loadPrimaryConnectionRegistration(primaryTarget).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Could not discover the primary environment.", { error }),
        ),
        Effect.option,
      );
      return Option.map(built, (registration) => ({ signature, registration }));
    });

    const buildPlatformRegistrations = resolvePrimaryRegistration.pipe(
      Effect.tap((next) => Ref.set(cacheRef, next)),
      Effect.map((next): ReadonlyArray<PlatformConnectionRegistration> =>
        Option.isSome(next) ? [next.value.registration] : [],
      ),
      Effect.provide(FetchHttpClient.layer),
    );

    return PlatformConnectionSource.PlatformConnectionSource.of({
      registrations: Stream.tick(PLATFORM_POLL_INTERVAL).pipe(
        Stream.mapEffect(() => buildPlatformRegistrations),
      ),
    });
  }),
);

const environmentOwnedDataCleanupLayer = Layer.succeed(
  Persistence.EnvironmentOwnedDataCleanup,
  Persistence.EnvironmentOwnedDataCleanup.of({
    clear: (environmentId) =>
      Effect.sync(() => {
        clearComposerDraftsEnvironment(environmentId);
      }),
  }),
);

const rpcRequestObserverLayer = Layer.succeed(
  EnvironmentRpcRequestObserver,
  EnvironmentRpcRequestObserver.of({
    observe: ({ environmentId, method }) =>
      Effect.sync(() => {
        nextObservedRpcRequestId += 1;
        const requestId = `${environmentId}:${nextObservedRpcRequestId}`;
        trackRpcRequestSent(requestId, method, `${method} · ${environmentId}`);
        return Effect.sync(() => {
          acknowledgeRpcRequest(requestId);
        });
      }),
  }),
);

type ConnectionPlatformLayerSource =
  | typeof connectionStorageLayer
  | typeof connectivityLayer
  | typeof wakeupsLayer
  | typeof capabilitiesLayer
  | typeof platformConnectionSourceLayer
  | typeof environmentOwnedDataCleanupLayer
  | typeof rpcRequestObserverLayer;

export const connectionPlatformLayer: Layer.Layer<
  Layer.Success<ConnectionPlatformLayerSource>,
  Layer.Error<ConnectionPlatformLayerSource>,
  Layer.Services<ConnectionPlatformLayerSource>
> = Layer.mergeAll(
  connectionStorageLayer,
  connectivityLayer,
  wakeupsLayer,
  capabilitiesLayer,
  platformConnectionSourceLayer,
  environmentOwnedDataCleanupLayer,
  rpcRequestObserverLayer,
);

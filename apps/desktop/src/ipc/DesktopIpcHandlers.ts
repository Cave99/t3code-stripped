import * as Effect from "effect/Effect";

import { receiveProviderAuthCallback, cancelProviderAuthCallback } from "./methods/providerAuth.ts";
import * as DesktopIpc from "./DesktopIpc.ts";
import { installNotificationBadge } from "./methods/notificationBadge.ts";
import { getClientSettings, setClientSettings } from "./methods/clientSettings.ts";
import {
  clearConnectionCatalog,
  getConnectionCatalog,
  setConnectionCatalog,
} from "./methods/connectionCatalog.ts";
import {
  getLocalEnvironmentEnabled,
  setLocalEnvironmentEnabled,
} from "./methods/localEnvironment.ts";
import {
  getAppBranding,
  getLocalEnvironmentBootstrap,
  getSystemLocale,
  getWindowFullscreenState,
  openExternal,
  pasteAsText,
  pickFolder,
  pickProjectFavicon,
  pickThemeFiles,
  setTheme,
  showContextMenu,
} from "./methods/window.ts";
import {
  acknowledgeSnapShot,
  checkSnapShotShortcut,
  dismissSnapShotAnimation,
  getSnapShotState,
  setupSnapShot,
  previewSnapShotConfig,
  applySnapShotConfig,
  listPendingSnapShots,
  readSnapShot,
  requestSnapShotPermissions,
  setSnapShotAnimationDestination,
  setSnapShotShortcutSuppressed,
} from "./methods/snapShot.ts";
import * as WebLinksIpc from "./methods/webLinks.ts";
import * as PreviewIpc from "./methods/preview.ts";

export const installDesktopIpcHandlers = Effect.fn("desktop.ipc.installHandlers")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  yield* installNotificationBadge();
  yield* ipc.handle(WebLinksIpc.setReady);
  yield* PreviewIpc.installPreviewEventForwarding();

  yield* ipc.handleSync(getAppBranding);
  yield* ipc.handleSync(getSystemLocale);
  yield* ipc.handleSync(getWindowFullscreenState);
  yield* ipc.handleSync(getLocalEnvironmentBootstrap);
  yield* ipc.handleSync(getLocalEnvironmentEnabled);
  yield* ipc.handle(setLocalEnvironmentEnabled);

  yield* ipc.handle(getClientSettings);
  yield* ipc.handle(setClientSettings);
  yield* ipc.handle(getConnectionCatalog);
  yield* ipc.handle(getSnapShotState);
  yield* ipc.handle(setupSnapShot);
  yield* ipc.handle(previewSnapShotConfig);
  yield* ipc.handle(applySnapShotConfig);
  yield* ipc.handle(requestSnapShotPermissions);
  yield* ipc.handle(checkSnapShotShortcut);
  yield* ipc.handle(setSnapShotShortcutSuppressed);
  yield* ipc.handle(listPendingSnapShots);
  yield* ipc.handle(readSnapShot);
  yield* ipc.handle(setSnapShotAnimationDestination);
  yield* ipc.handle(dismissSnapShotAnimation);
  yield* ipc.handle(acknowledgeSnapShot);
  yield* ipc.handle(setConnectionCatalog);
  yield* ipc.handle(clearConnectionCatalog);

  yield* ipc.handle(pickFolder);
  yield* ipc.handle(pickProjectFavicon);
  yield* ipc.handle(pickThemeFiles);
  yield* ipc.handle(setTheme);
  yield* ipc.handle(showContextMenu);
  yield* ipc.handle(openExternal);
  yield* ipc.handle(receiveProviderAuthCallback);
  yield* ipc.handle(cancelProviderAuthCallback);
  yield* ipc.handle(pasteAsText);
  for (const previewMethod of PreviewIpc.methods) {
    yield* ipc.handle(previewMethod);
  }
});

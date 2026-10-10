import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

import type * as Electron from "electron";

const { focusedWebContents, ownerWindow } = vi.hoisted(() => ({
  focusedWebContents: vi.fn(),
  ownerWindow: vi.fn(),
}));
vi.mock("electron", () => ({
  webContents: { getFocusedWebContents: focusedWebContents },
  BrowserWindow: { fromWebContents: ownerWindow },
}));

import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import {
  getLocalEnvironmentBootstrap,
  getWindowFullscreenState,
  pasteAsText,
  pickProjectFavicon,
} from "./window.ts";

describe("getWindowFullscreenState", () => {
  it.effect("reads the current native window state", () => {
    const window = { isFullScreen: () => true } as Electron.BrowserWindow;

    return Effect.gen(function* () {
      assert.isTrue(yield* getWindowFullscreenState.handler());
    }).pipe(
      Effect.provide(
        Layer.mock(ElectronWindow.ElectronWindow)({
          currentMainOrFirst: Effect.succeedSome(window),
        }),
      ),
    );
  });
});

describe("pasteAsText", () => {
  it.effect(
    "pastes into the focused guest only after the main renderer acknowledges the menu action",
    () => {
      const paste = vi.fn();
      const mainPaste = vi.fn();
      const window = {
        webContents: { id: 42, paste: mainPaste },
        isDestroyed: () => false,
      } as unknown as Electron.BrowserWindow;
      focusedWebContents.mockReturnValue({ paste, isDestroyed: () => false });
      ownerWindow.mockReturnValue(window);

      return Effect.gen(function* () {
        yield* pasteAsText.handler(undefined, { sender: { id: 42 } });
        assert.equal(paste.mock.calls.length, 1);
        assert.equal(mainPaste.mock.calls.length, 0);

        yield* pasteAsText.handler(undefined, { sender: { id: 99 } });
        assert.equal(paste.mock.calls.length, 1);
        ownerWindow.mockReturnValue({}); // A focused PiP/other BrowserWindow.
        yield* pasteAsText.handler(undefined, { sender: { id: 42 } });
        assert.equal(paste.mock.calls.length, 1);
        ownerWindow.mockReturnValue(null); // Detached contents.
        yield* pasteAsText.handler(undefined, { sender: { id: 42 } });
        assert.equal(paste.mock.calls.length, 1);
        ownerWindow.mockReturnValue(window);
        focusedWebContents.mockReturnValue({ paste, isDestroyed: () => true });
        yield* pasteAsText.handler(undefined, { sender: { id: 42 } });
        assert.equal(paste.mock.calls.length, 1);
        focusedWebContents.mockReturnValue(null);
        yield* pasteAsText.handler(undefined, { sender: { id: 42 } });
        assert.equal(paste.mock.calls.length, 1);
      }).pipe(
        Effect.provide(
          Layer.mock(ElectronWindow.ElectronWindow)({
            main: Effect.succeedSome(window),
          }),
        ),
      );
    },
  );
});

describe("pickProjectFavicon", () => {
  const pickerLayer = (
    pickFiles: () => Effect.Effect<Array<string>>,
    settings?: DesktopAppSettings.DesktopSettings,
  ) =>
    Layer.mergeAll(
      Layer.mock(ElectronDialog.ElectronDialog)({ pickFiles }),
      Layer.mock(ElectronWindow.ElectronWindow)({
        focusedMainOrFirst: Effect.succeedNone,
      }),
      DesktopAppSettings.layerTest(settings),
    );

  it.effect("opens a single-image picker from the project directory", () =>
    Effect.gen(function* () {
      const pickFiles = vi.fn(() => Effect.succeed(["/pictures/icon.png"]));
      const result = yield* pickProjectFavicon
        .handler("/project")
        .pipe(Effect.provide(pickerLayer(pickFiles)));

      assert.strictEqual(result, "/pictures/icon.png");
      assert.deepEqual(pickFiles.mock.calls, [
        [
          {
            owner: Option.none(),
            defaultPath: Option.some("/project"),
            multiple: false,
            filters: [
              {
                name: "Images",
                extensions: ["avif", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"],
              },
            ],
          },
        ],
      ]);
    }),
  );

  it.effect("does not open a picker while the local environment is off", () =>
    Effect.gen(function* () {
      const pickFiles = vi.fn(() => Effect.succeed(["/pictures/icon.png"]));
      const result = yield* pickProjectFavicon.handler("/project").pipe(
        Effect.provide(
          pickerLayer(pickFiles, {
            ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
            localEnvironmentEnabled: false,
          }),
        ),
      );

      assert.strictEqual(result, null);
      assert.strictEqual(pickFiles.mock.calls.length, 0);
    }),
  );
});

it.effect("hands the backend launch secret to the renderer through bootstrap IPC", () =>
  Effect.gen(function* () {
    const bootstrap = yield* getLocalEnvironmentBootstrap.handler();
    assert.deepEqual(bootstrap, {
      label: "This device",
      httpBaseUrl: "http://127.0.0.1:3773/",
      wsBaseUrl: "ws://127.0.0.1:3773/",
      bootstrapToken: "launch-secret",
    });
  }).pipe(
    Effect.provide(
      DesktopBackendPool.layerTest({
        label: Effect.succeed("This device"),
        currentConfig: Effect.succeedSome({
          bootstrap: { desktopBootstrapToken: "launch-secret" },
          httpBaseUrl: new URL("http://127.0.0.1:3773"),
        }),
      } as unknown as DesktopBackendPool.DesktopBackendInstance),
    ),
  ),
);

#!/usr/bin/env node
/**
 * Downloads the pinned HTML preview browser for a platform, checks its
 * SHA-256, and unpacks it so `<destination>/chrome-headless-shell` is the
 * executable. The desktop build and the dev kit bundle it so previews never
 * download a browser at runtime.
 *
 *   node scripts/fetch-preview-browser.ts <destination>
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { previewBrowserRelease } from "@t3tools/shared/previewBrowserRelease";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command } from "effect/unstable/cli";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export class PreviewBrowserFetchError extends Schema.TaggedError<PreviewBrowserFetchError>()(
  "PreviewBrowserFetchError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export const fetchPreviewBrowser = Effect.fn("fetchPreviewBrowser")(
  function* (input: {
    readonly destination: string;
    readonly platform: NodeJS.Platform;
    readonly arch: NodeJS.Architecture;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const hostPlatform = yield* HostProcessPlatform;
    const release = previewBrowserRelease(input.platform, input.arch);
    if (release === null) {
      return yield* new PreviewBrowserFetchError({
        detail: `No HTML preview browser exists for ${input.platform}-${input.arch}.`,
      });
    }

    const matchesPin = (bytes: Uint8Array) =>
      crypto
        .digest("SHA-256", bytes)
        .pipe(Effect.map((digest) => Encoding.encodeHex(digest) === release.sha256));

    // Cached by version so repeated local builds skip the 100 MB download.
    const cacheDir = path.join(
      path.resolve(import.meta.dirname, ".."),
      "node_modules/.cache/preview-browser",
      release.version,
    );
    const archive = path.join(cacheDir, `${release.platform}.zip`);
    const cached = yield* fs.readFile(archive).pipe(
      Effect.flatMap(matchesPin),
      Effect.orElseSucceed(() => false),
    );
    if (!cached) {
      const bytes = yield* HttpClient.get(release.url).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.arrayBuffer),
        Effect.map((buffer) => new Uint8Array(buffer)),
      );
      if (!(yield* matchesPin(bytes))) {
        return yield* new PreviewBrowserFetchError({
          detail: `${release.url} does not match its pinned SHA-256.`,
        });
      }
      yield* fs.makeDirectory(cacheDir, { recursive: true });
      yield* fs.writeFile(archive, bytes);
    }

    const unpacked = yield* fs.makeTempDirectoryScoped({ prefix: "preview-browser-" });
    const unpack =
      hostPlatform === "win32"
        ? ChildProcess.make("tar", ["-xf", archive, "-C", unpacked], { stderr: "inherit" })
        : ChildProcess.make("unzip", ["-q", archive, "-d", unpacked], { stderr: "inherit" });
    const exitCode = yield* spawner.spawn(unpack).pipe(Effect.flatMap((child) => child.exitCode));
    if (exitCode !== 0) {
      return yield* new PreviewBrowserFetchError({ detail: `Unpacking ${archive} failed.` });
    }
    yield* fs.remove(input.destination, { recursive: true, force: true });
    yield* fs.copy(
      path.join(unpacked, `chrome-headless-shell-${release.platform}`),
      input.destination,
    );

    const executable = path.join(
      input.destination,
      input.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell",
    );
    if (!(yield* fs.exists(executable))) {
      return yield* new PreviewBrowserFetchError({
        detail: `${release.url} did not contain ${path.basename(executable)}.`,
      });
    }
    return executable;
  },
  Effect.scoped,
  Effect.provide(FetchHttpClient.layer),
);

const fetchPreviewBrowserCommand = Command.make(
  "fetch-preview-browser",
  { destination: Argument.String("destination") },
  ({ destination }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const executable = yield* fetchPreviewBrowser({
        destination: path.resolve(destination),
        platform: yield* HostProcessPlatform,
        arch: yield* HostProcessArchitecture,
      });
      yield* Console.log(executable);
    }),
).pipe(Command.withDescription("Download and unpack the pinned HTML preview browser."));

if (import.meta.main) {
  Command.run(fetchPreviewBrowserCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}

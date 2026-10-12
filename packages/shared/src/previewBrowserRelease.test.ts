import { expect, it } from "vite-plus/test";

import { previewBrowserRelease } from "./previewBrowserRelease.ts";

it("pins one Chrome for Testing build per host", () => {
  const hosts = [
    ["linux", "x64"],
    ["linux", "arm64"],
    ["darwin", "arm64"],
    ["darwin", "x64"],
    ["win32", "x64"],
    ["win32", "arm64"],
    ["win32", "ia32"],
    ["linux", "ia32"],
    ["freebsd", "x64"],
  ] as const;
  expect(hosts.map(([platform, arch]) => previewBrowserRelease(platform, arch)?.platform)).toEqual([
    "linux64",
    "linux-arm64",
    "mac-arm64",
    "mac-x64",
    "win64",
    "win64",
    "win32",
    undefined,
    undefined,
  ]);
  expect(previewBrowserRelease("linux", "x64")).toMatchObject({
    url: "https://storage.googleapis.com/chrome-for-testing-public/154.0.8037.92/linux64/chrome-headless-shell-linux64.zip",
    bytes: 120_477_194,
  });
});

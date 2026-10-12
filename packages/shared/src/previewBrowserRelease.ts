// HTML previews only ever run T3's own pinned Chrome for Testing headless
// shell, never a browser the user installed. To bump the pin, pick a version
// from https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json,
// download each platform's chrome-headless-shell zip, and replace the version
// and every byte count and SHA-256 below. Hosts drop the old build after the
// new one installs. The desktop build and dev kit bundle this same build
// (scripts/fetch-preview-browser.ts), so a bump reaches them on their next build.
const VERSION = "154.0.8037.92";
const ARCHIVES = {
  linux64: {
    bytes: 120_477_194,
    sha256: "636aa5c79f2693632e9921b8bbb050038ba11672e02346c06c20f991aed096f9",
  },
  "linux-arm64": {
    bytes: 121_182_296,
    sha256: "0ed0e47d9e9f639197f508d62ada09e5c6b4c4c60edab3160a9312a733091df6",
  },
  "mac-arm64": {
    bytes: 99_221_129,
    sha256: "77da14e75d7f2568e6f7898d3df7cdc6faac74b15e903b2c9d486ebb6ca9b929",
  },
  "mac-x64": {
    bytes: 104_748_425,
    sha256: "a54292aaacbb77f76f6ef47558e7c51ab884044e0adacca315567f83c060bcc4",
  },
  win32: {
    bytes: 114_295_943,
    sha256: "56b30d2d6c35775ebf8dc3618680f6529e1c38c87f7feb28a16e9904273d51f7",
  },
  win64: {
    bytes: 120_822_223,
    sha256: "3ac2561f02d9d87aadc0399d00b9002d718a4c365624fa67db9e7bfaf6b1a568",
  },
} as const;

const chromePlatform = (platform: NodeJS.Platform, arch: NodeJS.Architecture) => {
  switch (platform) {
    case "linux":
      return arch === "x64" ? "linux64" : arch === "arm64" ? "linux-arm64" : null;
    case "darwin":
      return arch === "arm64" ? "mac-arm64" : arch === "x64" ? "mac-x64" : null;
    case "win32":
      // There is no Windows arm64 build; Windows on Arm runs the x64 one under emulation.
      return arch === "ia32" ? "win32" : arch === "x64" || arch === "arm64" ? "win64" : null;
    default:
      return null;
  }
};

export interface PreviewBrowserRelease {
  readonly version: string;
  /** Chrome for Testing's platform name, which also names the archive's top directory. */
  readonly platform: string;
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
}

export const previewBrowserRelease = (
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): PreviewBrowserRelease | null => {
  const chrome = chromePlatform(platform, arch);
  return chrome === null
    ? null
    : {
        version: VERSION,
        platform: chrome,
        url: `https://storage.googleapis.com/chrome-for-testing-public/${VERSION}/${chrome}/chrome-headless-shell-${chrome}.zip`,
        ...ARCHIVES[chrome],
      };
};

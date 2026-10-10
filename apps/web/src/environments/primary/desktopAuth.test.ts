import type { DesktopBridge } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";

import { readDesktopPrimaryBearerToken } from "./desktopAuth";

describe("desktop primary auth", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {},
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "window");
  });

  it("reads the launch secret from bootstrap IPC for each request", async () => {
    const getLocalEnvironmentBootstrap = vi
      .fn()
      .mockReturnValue({ bootstrapToken: "launch-secret" });
    window.desktopBridge = {
      getLocalEnvironmentBootstrap,
    } as unknown as DesktopBridge;

    await expect(readDesktopPrimaryBearerToken()).resolves.toBe("launch-secret");
    await expect(readDesktopPrimaryBearerToken()).resolves.toBe("launch-secret");
    expect(getLocalEnvironmentBootstrap).toHaveBeenCalledTimes(2);
  });

  it("returns no credential without the desktop bridge", async () => {
    await expect(readDesktopPrimaryBearerToken()).resolves.toBeNull();
  });
});

import { describe, expect, it } from "vite-plus/test";

import { readPrimaryEnvironmentTargetResult } from "./platform.ts";

describe("primary topology read", () => {
  it("captures synchronous primary target read failures", () => {
    const cause = new Error("invalid primary target");

    expect(
      readPrimaryEnvironmentTargetResult(() => {
        throw cause;
      }),
    ).toEqual({ _tag: "Failure", cause });
  });
});

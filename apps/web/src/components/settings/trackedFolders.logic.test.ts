import { describe, expect, it } from "vite-plus/test";

import {
  suggestedTrackedFolders,
  trackedFolderDisplayPath,
  trackedFolderFromPath,
} from "./trackedFolders.logic";

describe("trackedFolderDisplayPath", () => {
  it("names a folder inside the project relative to it and any other by its full path", () => {
    expect(trackedFolderDisplayPath("/work/shop/api", "/work/shop")).toBe("api");
    expect(trackedFolderDisplayPath("/work/shared", "/work/shop")).toBe("/work/shared");
  });
});

describe("trackedFolderFromPath", () => {
  it("adds a picked absolute folder under its own name", () => {
    expect(trackedFolderFromPath("/work/shared/")).toEqual({
      path: "/work/shared",
      name: "shared",
    });
    expect(trackedFolderFromPath("relative/folder")).toBeNull();
    expect(trackedFolderFromPath("   ")).toBeNull();
  });
});

describe("suggestedTrackedFolders", () => {
  it("offers only a workspace file's folders the project does not cover yet", () => {
    expect(
      suggestedTrackedFolders(
        [{ path: "/work/api", name: "api" }],
        [
          { path: "/work/api", name: "api", isGitRepository: true, source: "code-workspace" },
          { path: "/work/web", name: "web", isGitRepository: true, source: "code-workspace" },
          { path: "/work/shop/docs", name: "docs", isGitRepository: true, source: "child" },
        ],
      ),
    ).toEqual([{ path: "/work/web", name: "web" }]);
  });
});

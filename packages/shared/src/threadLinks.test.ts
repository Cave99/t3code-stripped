import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatThreadLink,
  parseThreadLinkHref,
  percentDecodedThreadLinkId,
} from "./threadLinks.ts";

describe("thread links", () => {
  it("takes the thread id verbatim, percent escapes included", () => {
    expect(parseThreadLinkHref("t3-thread://v1/mcp:1234")).toBe("mcp:1234");
    expect(parseThreadLinkHref("t3-thread://v1/thread:delegated-task:mcp%3A1")).toBe(
      "thread:delegated-task:mcp%3A1",
    );
  });

  it("rejects other links and an empty id", () => {
    expect(parseThreadLinkHref("https://t3.codes")).toBeNull();
    expect(parseThreadLinkHref("t3-thread://v1/")).toBeNull();
    expect(parseThreadLinkHref("t3-thread://v1/ ")).toBeNull();
  });

  it("decodes an encoded id for fallback lookup and tolerates malformed escapes", () => {
    expect(percentDecodedThreadLinkId(ThreadId.make("thread%3A1"))).toBe("thread:1");
    expect(percentDecodedThreadLinkId(ThreadId.make("thread:1"))).toBeNull();
    expect(percentDecodedThreadLinkId(ThreadId.make("thread%ZZ"))).toBeNull();
  });

  it("formats labels without breaking Markdown", () => {
    expect(formatThreadLink("t1", "Fix [ci] \\ build")).toBe("[Fix ci build](t3-thread://v1/t1)");
  });
});

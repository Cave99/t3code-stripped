import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  threads: new Map<string, { id: ThreadId; projectId: ProjectId; title: string }>(),
}));
vi.mock("../../state/entities", () => ({
  useThreadShell: (ref: { threadId: string } | null) =>
    ref ? (state.threads.get(ref.threadId) ?? null) : null,
  useProject: () => null,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ params, children }: { params: { threadId: string }; children: ReactNode }) => (
    <a href={`/${params.threadId}`}>{children}</a>
  ),
}));
import { MarkdownThreadLink, ToolOutputThreadLinks } from "./MarkdownThreadLink";

it("updates a thread link after a rename and resolves encoded ids only as a fallback", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const threadId = ThreadId.make("thread:1");
  const thread = { id: threadId, projectId: ProjectId.make("p1"), title: "Current title" };
  state.threads.set(threadId, thread);
  let renderer: ReactTestRenderer | undefined;
  const link = (id: string) => (
    <MarkdownThreadLink
      environmentId={EnvironmentId.make("local")}
      threadId={ThreadId.make(id)}
      label="Old title"
    />
  );
  try {
    await act(async () => {
      renderer = create(link("thread%3A1"));
    });
    expect(renderer!.root.findByType("a").children.at(-1)).toBe("Current title");
    expect(renderer!.root.findByType("a").props.href).toBe("/thread:1");
    state.threads.set(threadId, { ...thread, title: "Renamed" });
    await act(async () => {
      renderer!.update(link("thread%3A1"));
    });
    expect(renderer!.root.findByType("a").children.at(-1)).toBe("Renamed");
    state.threads.set("thread%3A1", {
      ...thread,
      id: ThreadId.make("thread%3A1"),
      title: "Literal id",
    });
    await act(async () => {
      renderer!.update(link("thread%3A1"));
    });
    expect(renderer!.root.findByType("a").children.at(-1)).toBe("Literal id");
    expect(renderer!.root.findByType("a").props.href).toBe("/thread%3A1");
    await act(async () => {
      renderer!.update(link("missing"));
    });
    expect(renderer!.root.findByType("a").children.at(-1)).toBe("Old title");
  } finally {
    await act(async () => {
      renderer?.unmount();
    });
    state.threads.clear();
    vi.unstubAllGlobals();
  }
});

it("renders thread links in tool output while retaining surrounding plain text", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.threads.set("t1", {
    id: ThreadId.make("t1"),
    projectId: ProjectId.make("p1"),
    title: "Current",
  });
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(
        <ToolOutputThreadLinks
          environmentId={EnvironmentId.make("local")}
          text={'{"result":"See [Old](t3-thread://v1/t1)"}'}
        />,
      );
    });
    expect(renderer!.root.findByType("a").props.href).toBe("/t1");
    expect(renderer!.root.findByType("a").children.at(-1)).toBe("Current");
    expect(JSON.stringify(renderer!.toJSON())).toContain("result");
  } finally {
    await act(async () => {
      renderer?.unmount();
    });
    state.threads.clear();
    vi.unstubAllGlobals();
  }
});

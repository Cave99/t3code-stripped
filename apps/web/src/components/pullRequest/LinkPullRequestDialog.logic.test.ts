import { describe, expect, it } from "vite-plus/test";

import { changeRequestWebUrl, resolveLinkPullRequestInput } from "./LinkPullRequestDialog";

const project = {
  host: "github.com",
  repository: "acme/web",
  webUrl: (number: number) => changeRequestWebUrl("github", "github.com", "acme/web", number),
};

describe("resolveLinkPullRequestInput", () => {
  it.each([["https://github.acme.test/acme/web/pull/42", "github.acme.test"]])(
    "links supported host URL %s without a thread project",
    (url, host) => {
      expect(
        resolveLinkPullRequestInput({
          reference: ` ${url} `,
          project: null,
          hasProject: (candidate) => candidate.host === host,
        }),
      ).toEqual({ link: { host, repository: "acme/web", number: 42, url } });
    },
  );

  it("returns null for input that is not a reference", () => {
    expect(
      resolveLinkPullRequestInput({ reference: "hello", project, hasProject: () => true }),
    ).toBeNull();
  });

  it("resolves a bare number against the thread's own repository", () => {
    expect(
      resolveLinkPullRequestInput({ reference: "#42", project, hasProject: () => true }),
    ).toEqual({
      link: {
        host: "github.com",
        repository: "acme/web",
        number: 42,
        url: "https://github.com/acme/web/pull/42",
      },
    });
  });

  it("links a URL from another repository on a host with a project", () => {
    expect(
      resolveLinkPullRequestInput({
        reference: "https://github.com/acme/api/pull/7",
        project,
        hasProject: (reference) => reference.host === "github.com",
      }),
    ).toEqual({
      link: {
        host: "github.com",
        repository: "acme/api",
        number: 7,
        url: "https://github.com/acme/api/pull/7",
      },
    });
  });

  it("refuses a URL on a host nothing is checked out from", () => {
    const result = resolveLinkPullRequestInput({
      reference: "https://github.example.test/acme/api/pull/7",
      project,
      hasProject: () => false,
    });
    expect(result).toMatchObject({ error: expect.stringContaining("github.example.test") });
  });

  it("asks for a URL when a bare number has no project to resolve against", () => {
    expect(
      resolveLinkPullRequestInput({ reference: "12", project: null, hasProject: () => true }),
    ).toMatchObject({ error: expect.stringContaining("full URL") });
  });

  it("accepts a checkout command as a reference", () => {
    expect(
      resolveLinkPullRequestInput({
        reference: "gh pr checkout https://github.com/acme/web/pull/3",
        project,
        hasProject: () => true,
      }),
    ).toMatchObject({ link: { number: 3, repository: "acme/web" } });
  });
});

describe("changeRequestWebUrl", () => {
  it("only builds GitHub URLs", () => {
    expect(changeRequestWebUrl("github", "github.com", "owner/repo", 5)).toBe(
      "https://github.com/owner/repo/pull/5",
    );
    expect(changeRequestWebUrl("unknown", "x", "a/b", 1)).toBeNull();
  });
});

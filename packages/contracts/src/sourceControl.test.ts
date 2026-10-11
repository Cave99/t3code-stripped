import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  SourceControlProviderInfo,
  SourceControlRepositoryLookupInput,
  SourceControlPublishRepositoryInput,
} from "./sourceControl.ts";

const decodeProvider = Schema.decodeUnknownSync(SourceControlProviderInfo);
const decodeLookup = Schema.decodeUnknownSync(SourceControlRepositoryLookupInput);
const decodePublish = Schema.decodeUnknownSync(SourceControlPublishRepositoryInput);

describe("historical source control compatibility", () => {
  it.each(["gitlab", "bitbucket", "azure-devops", "forgejo", "custom-forge"])(
    "decodes stored provider ID %s without enabling repository operations",
    (kind) => {
      expect(decodeProvider({ kind, name: kind, baseUrl: "" }).kind).toBe(kind);
      expect(() =>
        decodeLookup({
          provider: kind,
          repository: "owner/repo",
        }),
      ).toThrow();
      expect(() =>
        decodePublish({
          provider: kind,
          repository: "owner/repo",
          cwd: "/repo",
          visibility: "private",
        }),
      ).toThrow();
    },
  );
  it("accepts GitHub repository lookups", () => {
    expect(
      decodeLookup({
        provider: "github",
        repository: "owner/repo",
      }).provider,
    ).toBe("github");
  });
});

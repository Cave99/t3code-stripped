import { assert, it } from "@effect/vitest";

import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as SourceControlRateLimit from "../sourceControl/SourceControlRateLimit.ts";
import { gitHubProviderFailure } from "./GitHubPullRequestProvider.ts";

const cause = new Error("redacted provider failure");

it("keeps GitHub's exact retry time", () => {
  assert.deepStrictEqual(
    gitHubProviderFailure(
      new SourceControlRateLimit.SourceControlRateLimitPausedError({
        provider: "github",
        host: "github.com",
        retryAt: 1_786_802_400_000,
      }),
    ),
    { reason: "rate-limited", retryAt: 1_786_802_400_000 },
  );
});

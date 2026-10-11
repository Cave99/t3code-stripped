const GITHUB_PULL_REQUEST_URL_PATTERN =
  /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)(?:[/?#].*)?$/i;
const PULL_REQUEST_NUMBER_PATTERN = /^#?(\d+)$/;
const GITHUB_CLI_PR_CHECKOUT_PATTERN = /^gh\s+pr\s+checkout\s+(.+)$/i;

export function parsePullRequestReference(input: string): string | null {
  const trimmed = input.trim();
  const normalized = GITHUB_CLI_PR_CHECKOUT_PATTERN.exec(trimmed)?.[1]?.trim() ?? trimmed;
  if (GITHUB_PULL_REQUEST_URL_PATTERN.test(normalized)) return normalized;
  return PULL_REQUEST_NUMBER_PATTERN.exec(normalized)?.[1] ?? null;
}

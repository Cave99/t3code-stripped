# Contributing

This is a stripped-down, desktop-only fork of [T3 Code](https://github.com/pingdotgg/t3code); see
[STRIPPED.md](STRIPPED.md) for what was kept and cut. It is maintained for its owner's use, so
outside contributions are not actively sought and review capacity is limited. Opening a PR creates
no obligation to review or merge it.

## Developer setup

Work on the Electron renderer and its local backend; standalone web deployment is outside this fork.

See the [development runbook](docs/operations/development.md) for the initial checkout, commands,
checks, and desktop packaging prerequisites.

## What is likely to be accepted

Focused bug fixes, reliability fixes, performance improvements, and maintenance work. Features,
opinionated rewrites, and unrelated cleanup need prior agreement in an issue. Anything that
reintroduces a cut surface (mobile, hosted web, remote access, other providers or forges) is out of
scope for this fork; contribute those upstream.

## Pull requests

- **One problem per PR.** Split independent fixes, even when each is useful. Include the contract,
  server, client, test, and documentation changes that one problem needs.
- **Show evidence.** Explain how you established the problem, how you checked the change, and what
  you observed. Use focused tests for testable behavior. Do not run repo-wide checks to satisfy this
  guide, and say what you could not check. "Tests pass" alone is not evidence.
- **UI changes** need before/after screenshots, plus a short recording when motion or timing matters.
  Attach evidence to the PR; do not commit it.
- **Docs.** Follow the [documentation rules](AGENTS.md#documentation).
- Use conventional commit titles in plain language, such as `fix(web): new threads no longer spike CPU`.

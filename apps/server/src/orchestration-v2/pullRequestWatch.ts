import type {
  OrchestrationV2Notification,
  PullRequestCheck,
  PullRequestComment,
  PullRequestDetail,
  ThreadPullRequestWatch,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * Wakes in a row that bring only comments. Check, conflict, or push news resets the count, so
 * this only stops a chatty bot looping an agent that is replying to it.
 */
export const PULL_REQUEST_WATCH_WAKE_LIMIT = 10;
/** How long a GitHub head may go without any check before the agent is told none reported. */
export const PULL_REQUEST_WATCH_NO_CHECKS_MS = 15 * 60_000;
const LISTED_ITEMS = 10;
const SNIPPET_LENGTH = 200;

export type PullRequestWatchChange =
  | { readonly kind: "checks-failed"; readonly failed: ReadonlyArray<PullRequestCheck> }
  | { readonly kind: "checks-passed"; readonly count: number; readonly required: boolean }
  | {
      readonly kind: "checks-finished";
      readonly passed: number;
      readonly failing: ReadonlyArray<PullRequestCheck>;
    }
  | { readonly kind: "checks-awaiting-approval"; readonly checks: ReadonlyArray<PullRequestCheck> }
  | { readonly kind: "remarks"; readonly remarks: ReadonlyArray<PullRequestComment> }
  | { readonly kind: "no-checks"; readonly minutes: number }
  | { readonly kind: "conflicting" };

export interface PullRequestWatchReport {
  /** What the agent has not been told yet. Empty means no wake. */
  readonly changes: ReadonlyArray<PullRequestWatchChange>;
  /** The watch to record, whether or not anything is reported. */
  readonly next: ThreadPullRequestWatch;
  /** This report spends the last wake before the limit, so watching stops after it. */
  readonly exhausted: boolean;
}

const isFailedCheck = (check: PullRequestCheck) =>
  check.status === "failure" || check.status === "cancelled";

// A GitHub Actions job's URL extends its workflow run's URL; their names need not match.
const workflowRunOf = (url: string | null) => url?.match(/^.*\/actions\/runs\/\d+/)?.[0] ?? null;
const approvalKey = (check: PullRequestCheck) => workflowRunOf(check.url) ?? check.name;

/**
 * Compares a watched pull request with what its agent was last told. Each check is reported as
 * soon as it fails, so a check that never finishes (an advisory review bot) cannot hold the
 * news back. "Passed" is reported once the checks the base branch requires all passed, or all
 * checks where the host marks none required. Remarks count when someone other than the agent's
 * own account wrote them, so its own replies never wake it. `remarks` is null when the
 * conversation could not be read; remarks then wait for a later pass.
 */
export function evaluatePullRequestWatch(
  watch: ThreadPullRequestWatch,
  detail: Pick<PullRequestDetail, "headSha" | "checks" | "mergeability" | "viewer" | "author">,
  remarks: ReadonlyArray<PullRequestComment> | null,
  now: number,
): PullRequestWatchReport {
  const changes: Array<PullRequestWatchChange> = [];
  // A read without a head says nothing about pushes, so it keeps the last known one.
  const headSha = detail.headSha ?? watch.headSha;
  const headMoved = headSha !== watch.headSha;

  // Hosts can return no checks on read failure; preserve prior state.
  let failedChecks = headMoved ? [] : watch.failedChecks;
  let passed = headMoved ? false : watch.passed;
  let passedChecks = headMoved ? [] : watch.passedChecks;
  let owedChecks = headMoved ? [] : (watch.owedChecks ?? []);
  const owedBefore = owedChecks;
  let awaitingApproval = headMoved ? [] : (watch.awaitingApproval ?? []);
  let approvalAnnounced = headMoved ? false : (watch.approvalAnnounced ?? false);
  // A watch with no answer (saved before the field, or since a push) waits only while the clock
  // below runs.
  let checksPending = headMoved ? false : (watch.checksPending ?? watch.checksAwaitedSince != null);
  // An unavailable approval read cannot establish success or that no checks exist.
  const unread = detail.checks.some((check) => check.placeholder === true);
  const checks = detail.checks.filter((check) => check.placeholder !== true);
  const failed = checks.filter(isFailedCheck);
  const awaiting = checks.filter((check) => check.status === "action-required");
  const failedBefore = failedChecks;
  const newlyFailed = failed.filter((check) => !failedBefore.includes(check.name));
  if (checks.length > 0) {
    // A run awaiting approval waits on a person, like a review, so only running checks count.
    checksPending = checks.some((check) => check.status === "pending");
    if (newlyFailed.length > 0) changes.push({ kind: "checks-failed", failed: newlyFailed });
    if (!approvalAnnounced && awaiting.length > 0) {
      changes.push({ kind: "checks-awaiting-approval", checks: awaiting });
      approvalAnnounced = true;
    }
    failedChecks = failed.map((check) => check.name);

    // Approval reads can omit gated runs. Keep each hold until its jobs finish.
    const awaitingNow = [...new Set(awaiting.map(approvalKey))];
    const nameUnfinished = (name: string) => {
      const matching = checks.filter((check) => check.name === name);
      return (
        matching.length === 0 ||
        matching.some((check) => check.status === "pending" || check.status === "action-required")
      );
    };
    // GitHub deduplicates jobs across runs, so a visible pending job may hide one in an awaited run.
    // A pending check without a URL could be such a job; one with another host's URL cannot.
    const jobsPending = checks.some(
      (check) =>
        check.status === "pending" && (check.url === null || workflowRunOf(check.url) !== null),
    );
    const finished = new Set(
      jobsPending
        ? []
        : checks
            .filter((check) => check.status !== "action-required" && check.status !== "pending")
            .map((check) => workflowRunOf(check.url)),
    );
    awaitingApproval = [
      ...awaitingNow,
      ...awaitingApproval.filter(
        (key) =>
          !awaitingNow.includes(key) &&
          (workflowRunOf(key) === key ? !finished.has(key) : nameUnfinished(key)),
      ),
    ];
  }
  const required = checks.filter((check) => check.required === true);
  const gate = required.length > 0 ? required : checks;
  const passedNow =
    awaitingApproval.length === 0 &&
    gate.every((check) => check.status !== "pending" && !isFailedCheck(check));
  if (checks.length > 0 && !(unread && passedNow)) {
    const gateNames = gate.map((check) => check.name);
    const told = passed && passedChecks.length === 0 ? gateNames : passedChecks;
    // Required checks can finish between sweeps; detect new names. With no required checks, ignore advisory gate growth.
    const gateGrew = required.length > 0 && gateNames.some((name) => !told.includes(name));
    // Other checks still pending when required ones passed are owed one wake when all settle.
    // Only those are owed, so later advisory churn never wakes. One turned required is gate news.
    const owed =
      passedNow && passed
        ? checks
            .filter((check) => check.required !== true && owedChecks.includes(check.name))
            .map((check) => check.name)
        : [];
    const settled =
      failed.length === 0 &&
      awaitingApproval.length === 0 &&
      checks.every((check) => check.status !== "pending");
    owedChecks = owed;
    if (passedNow && (!passed || gateGrew)) {
      changes.push({ kind: "checks-passed", count: gate.length, required: required.length > 0 });
      owedChecks =
        required.length > 0
          ? checks
              .filter((check) => check.required !== true && check.status === "pending")
              .map((check) => check.name)
          : [];
    } else if (settled && owed.length > 0) {
      changes.push({ kind: "checks-passed", count: checks.length, required: false });
      owedChecks = [];
    } else if (gate.some(isFailedCheck)) {
      // A failed gate never sends the passed wake. A failure seen while other checks still run, or
      // a failed check that ran again, owes one wake once every check has finished. Only whether
      // the list is empty matters here, and the failed checks are never empty.
      const rerun = failedBefore.some((name) => !failedChecks.includes(name));
      const running =
        unread ||
        awaitingApproval.length > 0 ||
        checks.some((check) => check.status === "pending" || check.status === "action-required");
      if (running) {
        if (owedBefore.length > 0 || rerun || newlyFailed.length > 0) owedChecks = failedChecks;
      } else if (owedBefore.length > 0 || rerun) {
        changes.push({
          kind: "checks-finished",
          passed: checks.filter((check) => check.status === "success").length,
          failing: failed,
        });
      }
    }
    passed = passedNow;
    passedChecks = passedNow ? gateNames : [];
  }

  // Only a head never read with checks waits for them; a legacy watch's clock starts at its next
  // push. GitHub always reports the checks it runs, so running out of time is news.
  const awaitedBefore = headMoved
    ? DateTime.formatIso(DateTime.makeUnsafe(now))
    : (watch.checksAwaitedSince ?? null);
  let checksAwaitedSince = checks.length > 0 ? null : awaitedBefore;
  const awaitedMs = checksAwaitedSince === null ? 0 : now - Date.parse(checksAwaitedSince);
  if (!unread && awaitedMs >= PULL_REQUEST_WATCH_NO_CHECKS_MS) {
    changes.push({ kind: "no-checks", minutes: Math.round(awaitedMs / 60_000) });
    checksAwaitedSince = null;
    checksPending = false;
  } else if (checksAwaitedSince !== null) {
    checksPending = true;
  }

  const own = (detail.viewer ?? detail.author?.login)?.toLowerCase();
  const through = Date.parse(watch.remarksThrough);
  const activeAt = (remark: PullRequestComment) => remark.editedAt ?? remark.createdAt;
  // Hosts can stamp remarks to the second, so remarks at the boundary time are told apart by ID.
  const fresh = (remarks ?? []).filter((remark) => {
    const at = Date.parse(activeAt(remark));
    return (
      (at > through || (at === through && !watch.remarkIds.includes(remark.id))) &&
      remark.author?.login.toLowerCase() !== own
    );
  });
  if (fresh.length > 0) changes.push({ kind: "remarks", remarks: fresh });
  const latest = Math.max(through, ...fresh.map((remark) => Date.parse(activeAt(remark))));
  const atLatest = fresh.filter((remark) => Date.parse(activeAt(remark)) === latest);
  const remarksThrough = latest === through ? watch.remarksThrough : activeAt(atLatest[0]!);
  const remarkIds = [
    ...(latest === through ? watch.remarkIds : []),
    ...atLatest.map((remark) => remark.id),
  ];

  // Like a failed check, a conflict a push did not resolve is news for the new head.
  const toldConflict = !headMoved && watch.conflicting;
  if (detail.mergeability === "conflicting" && !toldConflict) {
    changes.push({ kind: "conflicting" });
  }
  // "unknown" is a host still computing after a push; only a clean answer clears a conflict.
  const conflicting =
    detail.mergeability === "unknown" ? toldConflict : detail.mergeability === "conflicting";

  const commentsOnly = changes.length > 0 && changes.every((change) => change.kind === "remarks");
  const progress = headMoved || (changes.length > 0 && !commentsOnly);
  const wakes = (progress ? 0 : watch.wakes) + (commentsOnly ? 1 : 0);
  return {
    changes,
    next: {
      startedAt: watch.startedAt,
      headSha,
      failedChecks,
      passed,
      passedChecks,
      owedChecks,
      awaitingApproval,
      approvalAnnounced,
      remarksThrough,
      remarkIds,
      conflicting,
      wakes,
      checksAwaitedSince,
      checksPending,
      ...(watch.until !== undefined && { until: watch.until }),
    },
    exhausted: commentsOnly && wakes >= PULL_REQUEST_WATCH_WAKE_LIMIT,
  };
}

function snippet(body: string): string {
  const text = body
    .replaceAll(/<!--[\s\S]*?-->/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  return text.length <= SNIPPET_LENGTH ? text : `${text.slice(0, SNIPPET_LENGTH - 3)}...`;
}

function listed<T>(items: ReadonlyArray<T>, line: (item: T) => string): Array<string> {
  const lines = items.slice(0, LISTED_ITEMS).map(line);
  if (items.length > LISTED_ITEMS) lines.push(`  - and ${items.length - LISTED_ITEMS} more`);
  return lines;
}

const failedCheckLine = (check: PullRequestCheck) =>
  `  - ${check.name}${check.status === "failure" ? "" : ` (${check.status})`}${check.url ? ` ${check.url}` : ""}`;

function changeLines(
  change: PullRequestWatchChange,
  context: { readonly baseBranch: string; readonly commit: string },
): Array<string> {
  switch (change.kind) {
    case "checks-failed":
      return [`- Checks failed${context.commit}:`, ...listed(change.failed, failedCheckLine)];
    case "checks-finished":
      return [
        `- Every check has finished${context.commit}: ${change.passed} passed, ${change.failing.length} still failing:`,
        ...listed(change.failing, failedCheckLine),
      ];
    case "checks-awaiting-approval":
      return [
        `- Checks are waiting for approval or action from a maintainer${context.commit}:`,
        ...listed(change.checks, (check) => `  - ${check.name}${check.url ? ` ${check.url}` : ""}`),
      ];
    case "checks-passed":
      return [
        `- All ${change.count} ${change.required ? "required " : ""}${change.count === 1 ? "check" : "checks"} passed${context.commit}.`,
      ];
    case "remarks":
      return [
        `- ${change.remarks.length} new ${change.remarks.length === 1 ? "comment" : "comments"}:`,
        ...listed(change.remarks, (remark) => {
          const where = remark.path === null ? "" : ` on ${remark.path}`;
          const body = snippet(remark.body);
          const said = body.length === 0 ? (remark.reviewState ?? "reviewed") : `"${body}"`;
          return `  - ${remark.author?.login ?? "someone"}${where}: ${said}${remark.url ? ` ${remark.url}` : ""}`;
        }),
      ];
    case "no-checks":
      return [
        `- No checks have reported${context.commit} after ${change.minutes} minutes. None may be configured to run on this change.`,
      ];
    case "conflicting":
      return [`- The branch now conflicts with ${context.baseBranch}.`];
  }
}

const SUMMARY: Record<PullRequestWatchChange["kind"], string> = {
  "checks-failed": "checks failed",
  "checks-passed": "checks passed",
  "checks-finished": "checks finished",
  "checks-awaiting-approval": "checks await approval",
  remarks: "new comments",
  "no-checks": "no checks reported",
  conflicting: "merge conflict",
};

/** The wake the agent reads and the timeline notification the user sees. */
export function pullRequestWatchMessage(input: {
  readonly number: number;
  readonly url: string;
  readonly baseBranch: string;
  readonly headSha: string | null;
  readonly report: PullRequestWatchReport;
}): { readonly text: string; readonly notification: OrchestrationV2Notification } {
  const { changes, exhausted } = input.report;
  const context = {
    baseBranch: input.baseBranch,
    commit: input.headSha === null ? "" : ` on ${input.headSha.slice(0, 7)}`,
  };
  const text = [
    `Update on pull request #${input.number} (${input.url}), which C3 Code is watching for you:`,
    ...changes.flatMap((change) => changeLines(change, context)),
    "",
    exhausted
      ? `C3 Code stopped watching after ${PULL_REQUEST_WATCH_WAKE_LIMIT} comment-only updates in a row. Call watch_pull_request to watch it again.`
      : "Look into each item and act on it as your task requires. C3 Code keeps watching and wakes you on the next change, so end your turn when you are done. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.",
  ].join("\n");
  const failed = changes.some(
    (change) =>
      change.kind === "checks-failed" ||
      change.kind === "checks-finished" ||
      change.kind === "conflicting",
  );
  const summary = changes.map((change) => SUMMARY[change.kind]);
  if (exhausted) summary.push("stopped watching");
  return {
    text,
    notification: {
      source: { kind: "monitor" },
      outcome: failed
        ? "failed"
        : changes.every((change) => change.kind === "checks-passed")
          ? "completed"
          : "updated",
      summary: `#${input.number}: ${summary.join(", ")}`,
    },
  };
}

import type { ProviderAdapterV2RuntimePolicy } from "../orchestration-v2/ProviderAdapter.ts";

export const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
When the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. As a delegated child task, do not watch or poll PRs; return PR URLs, head SHA, and pending review/check state to your parent. Otherwise, when asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: C3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When monitoring is done and you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.
</pull_request_linking>`;

/**
 * Shared runtime context; omit model and effort when the harness manages them dynamically.
 * `modelName` is the display name users see in the model picker; `model` is the slug.
 */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  /** Adds the folder list of a multi-folder thread. */
  readonly runtimePolicy?: Pick<ProviderAdapterV2RuntimePolicy, "cwd" | "workspace"> | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  const workspace =
    runtime.runtimePolicy === undefined ? "" : buildWorkspaceInstructions(runtime.runtimePolicy);
  return [
    `<runtime_info>In case you're asked: you are running in C3 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>`,
    PULL_REQUEST_LINKING_INSTRUCTIONS,
    ...(workspace === "" ? [] : [workspace]),
  ].join("\n\n");
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

// Codex truncates context entries over 4,000 bytes, and this block is sent as its own entry.
const WORKSPACE_INSTRUCTIONS_MAX_BYTES = 3_600;
const FOLDER_NAME_MAX_LENGTH = 64;
// Control characters and Unicode line separators would let a name or path add lines.
const LINE_BREAKING = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
const textEncoder = new TextEncoder();

const byteLength = (value: string) => textEncoder.encode(value).length;

/** Names come from users and disk; keep each one a short label that cannot close the block. */
function folderLabel(name: string): string {
  const label = Array.from(
    name.replaceAll(LINE_BREAKING, " ").replaceAll(/[<>`]/g, " ").replaceAll(/\s+/g, " ").trim(),
  );
  if (label.length === 0) return "folder";
  return label.length > FOLDER_NAME_MAX_LENGTH
    ? `${label.slice(0, FOLDER_NAME_MAX_LENGTH - 1).join("")}…`
    : label.join("");
}

const folderPath = (value: string) =>
  value.replaceAll(LINE_BREAKING, "?").replaceAll("<", "‹").replaceAll(">", "›");

/** Lists a multi-folder thread's folders. Empty for single-folder threads, so their text is unchanged. */
export function buildWorkspaceInstructions(
  runtimePolicy: Pick<ProviderAdapterV2RuntimePolicy, "cwd" | "workspace">,
): string {
  const workspace = runtimePolicy.workspace;
  if (workspace === undefined || workspace.folders.length === 0) return "";
  const head = [
    "<workspace_folders>",
    "This project spans several folders. Each Git repository has its own history and branches: run Git commands inside the repository you change, and commit each one separately.",
    ...(runtimePolicy.cwd === null
      ? []
      : [`- Your working directory: ${folderPath(runtimePolicy.cwd)}`]),
  ];
  const tail = ["</workspace_folders>"];
  const entries = workspace.folders.map(
    (folder) =>
      `- ${folderLabel(folder.name)} (${folder.isGitRepository ? "Git repository" : "folder"}): ${folderPath(folder.path)}`,
  );
  // Reserve room for the line that counts folders left out.
  let budget = WORKSPACE_INSTRUCTIONS_MAX_BYTES - byteLength([...head, ...tail].join("\n")) - 32;
  const shown: Array<string> = [];
  for (const entry of entries) {
    budget -= byteLength(entry) + 1;
    if (budget < 0) break;
    shown.push(entry);
  }
  const hidden = entries.length - shown.length;
  return [...head, ...shown, ...(hidden > 0 ? [`- Not listed: ${hidden} more`] : []), ...tail].join(
    "\n",
  );
}

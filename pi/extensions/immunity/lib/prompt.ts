/**
 * Decision menus. File paths prompt with the six-option
 * scope menu:
 *
 *   Allow for session / Allow for project / Allow globally
 *   Block for session / Block for project / Block globally
 *
 * Session choices are in-memory statements (final for the session). Project
 * and global choices persist rules via the saveRule hook — always exact:
 * commands as `{ action, exact: true, raw }`, paths as `{ action, kind, path }`.
 * After a Block* choice the user is asked whether to use immunity's
 * reasoning or provide their own (built-in, not configurable); a user-provided
 * reason overwrites the model's reason.
 *
 * Whole commands prompt with a plain Allow/Deny (`runCommandPrompt`) — scope
 * choices make sense only for the suggestion step's flagged subsections, not
 * for a one-shot command.
 *
 * Dismissed prompts (undefined) and UI failures deny — nothing gets through
 * a broken prompt (safety-first).
 */
import { dirname } from "node:path";
import type { SessionState } from "./session.ts";
import type { RuleKind } from "./rules.ts";
import type { Suggestions } from "./pipeline.ts";

export interface DialogOptions {
  /** pi dismisses the dialog when this signal aborts */
  signal?: AbortSignal;
}

export interface PromptUi {
  select(title: string, options: string[], opts?: DialogOptions): Promise<string | undefined>;
  input(title: string, placeholder?: string, opts?: DialogOptions): Promise<string | undefined>;
}

export type MenuScope = "session" | "project" | "global";

export interface PromptResult {
  action: "allow" | "block";
  scope: MenuScope;
  /** the session aborted while a dialog was open — nothing was persisted or audited */
  cancelled?: boolean;
  /** rule write success for project/global choices (audit); undefined for session */
  persisted?: boolean;
  /** present exactly when the user typed one after a Block* choice */
  userReason?: string;
  /** path requests only: effective rule kind (follow-up choice, or the inferred kind for directories) */
  pathKind?: "file" | "directory";
  /** path requests only: effective rule value (dirname-adjusted when a file target is applied as a directory) */
  pathValue?: string;
}

export interface PromptFlowOptions {
  ui: PromptUi;
  /** the pipeline reason shown in the prompt */
  reason: string;
  /** session statement key (grantKey) — session choices land here */
  sessionKey: string;
  session: Pick<SessionState, "addAllow" | "addDeny">;
  /** persists an allow/deny rule to a scope file; returns false when the save failed */
  saveRule: (kind: RuleKind, value: string, scope: "project" | "global", opts?: { pathKind?: "file" | "directory" }) => boolean | Promise<boolean>;
  /** raw command (bash requests) */
  command?: string;
  /** durable path value for rule writes (file requests; `~`-normalized) */
  path?: string;
  /** inferred kind (index.ts stats the target): directory targets skip the follow-up */
  pathKind?: "file" | "directory";
  /** session abort signal — cancels active dialogs without persisting or auditing */
  signal?: AbortSignal;
}

export const MENU_OPTIONS = [
  "Allow for session",
  "Allow for project",
  "Allow globally",
  "Block for session",
  "Block for project",
  "Block globally",
] as const;

/** Reason text for the picker title: line breaks preserved and nothing cut off;
 * the dialog wraps it to the terminal width. */
export function displayReason(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

/** Follow-up for path rules: narrow (the file) or recursive (the containing/this directory). */
const PATH_KIND_OPTIONS = ["Just this file", "The whole directory (recursive)"] as const;

const CANCELLED = Symbol("cancelled");

/** Resolve with the promise value, or CANCELLED when the signal aborts first. */
function raceAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T | typeof CANCELLED> {
  if (!signal) return p;
  if (signal.aborted) return Promise.resolve(CANCELLED);
  return new Promise<T | typeof CANCELLED>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      resolve(CANCELLED);
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (value) => {
        cleanup();
        resolve(signal.aborted ? CANCELLED : value);
      },
      (err) => {
        cleanup();
        reject(err);
      },
    );
  });
}

interface ChoiceResult {
  choice?: string;
  cancelled: boolean;
  failed: boolean;
}

async function choose(ui: PromptUi, title: string, options: string[], signal?: AbortSignal): Promise<ChoiceResult> {
  if (signal?.aborted) return { cancelled: true, failed: false };
  try {
    const choice = await raceAbort(ui.select(title, options, signal ? { signal } : undefined), signal);
    if (choice === CANCELLED || signal?.aborted) return { cancelled: true, failed: false };
    return { choice, cancelled: false, failed: false };
  } catch {
    return { cancelled: false, failed: true };
  }
}

async function askInput(ui: PromptUi, title: string, signal?: AbortSignal): Promise<{ value?: string; cancelled: boolean }> {
  if (signal?.aborted) return { cancelled: true };
  try {
    const value = await raceAbort(ui.input(title, undefined, signal ? { signal } : undefined), signal);
    if (value === CANCELLED || signal?.aborted) return { cancelled: true };
    return { value, cancelled: false };
  } catch {
    return { cancelled: false };
  }
}

function cancelledFlow(): PromptResult {
  return { action: "block", scope: "session", cancelled: true };
}

async function pathKindChoice(
  ui: PromptUi,
  inferred: "file" | "directory",
  signal?: AbortSignal,
): Promise<{ kind: "file" | "directory"; cancelled: boolean }> {
  if (inferred === "directory") return { kind: "directory", cancelled: false }; // a directory target is already the directory — no follow-up
  const result = await choose(ui, "Apply the rule to?", [...PATH_KIND_OPTIONS], signal);
  if (result.cancelled) return { kind: "file", cancelled: true };
  if (result.failed) return { kind: "file", cancelled: false }; // a broken follow-up must not widen the rule
  return { kind: result.choice === "The whole directory (recursive)" ? "directory" : "file", cancelled: false };
}

export async function runPromptFlow(opts: PromptFlowOptions): Promise<PromptResult> {
  const picked = await choose(opts.ui, `Immunity: ${displayReason(opts.reason)}`, [...MENU_OPTIONS], opts.signal);
  if (picked.cancelled) return cancelledFlow();
  if (picked.failed) return { action: "block", scope: "session" }; // broken prompt must not let the call through
  const choice = picked.choice;
  if (choice === undefined) return { action: "block", scope: "session" };

  // path requests: resolve the rule kind + effective value (follow-up for
  // file targets; a directory choice on a file target applies to its parent)
  let pathKind: "file" | "directory" | undefined;
  let pathValue: string | undefined;
  let sessionKey = opts.sessionKey;
  if (opts.path !== undefined) {
    const inferred = opts.pathKind ?? "file";
    const kindChoice = await pathKindChoice(opts.ui, inferred, opts.signal);
    if (kindChoice.cancelled) return cancelledFlow();
    pathKind = kindChoice.kind;
    pathValue = opts.path;
    if (pathKind === "directory" && inferred === "file") {
      pathValue = dirname(pathValue);
      if (sessionKey.startsWith("file:")) {
        sessionKey = `file:${dirname(sessionKey.slice("file:".length))}`;
      }
    }
  }

  const kind: RuleKind | null =
    choice === "Allow for project" || choice === "Allow globally"
      ? opts.command !== undefined
        ? "commandAllow"
        : "pathAllow"
      : choice === "Block for project" || choice === "Block globally"
        ? opts.command !== undefined
          ? "commandDeny"
          : "pathDeny"
        : null;

  if (kind) {
    const scope: "project" | "global" = choice.endsWith("globally") ? "global" : "project";
    const value = opts.command ?? pathValue;
    // Ask for a block reason before writing the rule: a dialog cancelled
    // mid-flow must not leave a persisted permission or block behind.
    const reason: ReasonResult = choice.startsWith("Block")
      ? await askReason(opts.ui, opts.signal)
      : { cancelled: false };
    if (reason.cancelled) return cancelledFlow();
    if (opts.signal?.aborted) return cancelledFlow();
    const persisted = value !== undefined ? await opts.saveRule(kind, value, scope, pathKind ? { pathKind } : undefined) : false;
    const common = { persisted, pathKind, pathValue };
    if (choice.startsWith("Block")) {
      return { action: "block", scope, userReason: reason.reason, ...common };
    }
    return { action: "allow", scope, ...common };
  }

  // session choices — memory only, final for the session
  if (choice === "Allow for session") {
    if (opts.signal?.aborted) return cancelledFlow();
    opts.session.addAllow(sessionKey, pathKind ?? "file");
    return { action: "allow", scope: "session", pathKind, pathValue };
  }
  const reason = await askReason(opts.ui, opts.signal);
  if (reason.cancelled) return cancelledFlow();
  if (opts.signal?.aborted) return cancelledFlow();
  opts.session.addDeny(sessionKey, pathKind ?? "file");
  return { action: "block", scope: "session", userReason: reason.reason, pathKind, pathValue };
}

/* ------------------------------------------------------------------ */
/* Command decision — plain Allow/Deny                                  */
/* ------------------------------------------------------------------ */

/** A whole command is never scope-persisted: accepting or rejecting one is
 * a one-shot call decision. Scope choices (session/project/global) are
 * reserved for the suggestion step's flagged subsections. When the analyzer
 * produced no response, the menu adds a manual *Retry analysis* option. */
export const COMMAND_OPTIONS = ["Allow", "Deny"] as const;
export const RETRY_ANALYSIS = "Retry analysis" as const;

export type CommandPromptResult =
  | { action: "allow" }
  | { action: "block"; userReason?: string }
  | { action: "retry" }
  | { action: "cancel" };

export async function runCommandPrompt(opts: {
  ui: PromptUi;
  reason: string;
  retryable?: boolean;
  signal?: AbortSignal;
}): Promise<CommandPromptResult> {
  const options = opts.retryable ? [...COMMAND_OPTIONS, RETRY_ANALYSIS] : [...COMMAND_OPTIONS];
  const picked = await choose(opts.ui, `Immunity: ${displayReason(opts.reason)}`, options, opts.signal);
  if (picked.cancelled) return { action: "cancel" };
  if (picked.failed) return { action: "block" }; // broken prompt must not let the call through
  const choice = picked.choice;
  if (choice === undefined) return { action: "block" }; // dismissed → block (safety-first)
  if (choice === "Allow") return { action: "allow" };
  if (choice === RETRY_ANALYSIS) return { action: "retry" };
  const reason = await askReason(opts.ui, opts.signal);
  if (reason.cancelled) return { action: "cancel" };
  return { action: "block", userReason: reason.reason };
}

interface ReasonResult {
  reason?: string;
  cancelled: boolean;
}

async function askReason(ui: PromptUi, signal?: AbortSignal): Promise<ReasonResult> {
  const answer = await choose(ui, "Provide reason for blocking?", ["Use immunity's reasoning", "Provide your reasoning"], signal);
  if (answer.cancelled) return { cancelled: true };
  if (answer.failed || answer.choice !== "Provide your reasoning") return { cancelled: false };
  const input = await askInput(ui, "Reason for blocking", signal);
  if (input.cancelled) return { cancelled: true };
  return { reason: input.value, cancelled: false };
}

/* ------------------------------------------------------------------ */
/* Suggestion step — the analyzer's flagged paths, resolved AFTER the   */
/* command was allowed. Choices persist path rules for future commands: */
/* allowing writes a pathAllow, protecting writes a pathDeny. The       */
/* already-allowed command is never blocked by this step.               */
/* ------------------------------------------------------------------ */

export type SuggestionChoice =
  | { action: "allow"; scope: "session" | "project" | "global"; value: string; pathKind: "file" | "directory"; persisted?: boolean }
  | { action: "protect"; scope: "project" | "global"; value: string; pathKind: "file" | "directory"; persisted?: boolean }
  | { action: "skip" };

export interface SuggestionStepOptions {
  ui: PromptUi;
  /** the pipeline reason shown in the dialog */
  reason: string;
  suggestions: Suggestions;
  session: Pick<SessionState, "addAllow">;
  /** persists an allow/ask rule to a scope file; returns false when the save failed */
  saveRule: (kind: RuleKind, value: string, scope: "project" | "global", opts?: { pathKind?: "file" | "directory" }) => boolean | Promise<boolean>;
  /** kind inference (stats the target); default file */
  pathKindFor?: (path: string) => "file" | "directory";
  /** session abort signal — cancels the active suggestion dialog */
  signal?: AbortSignal;
}

export interface SuggestionStepResult {
  /** one choice per flagged path (skip included), in order */
  choices: SuggestionChoice[];
  /** a path was protected → the loop stops (remaining paths stay unanswered) */
  protected: boolean;
  /** the protected path (reason text) */
  protectedPath?: string;
  /** the prompt failed → the caller decides; it never blocks an allowed command */
  failed: boolean;
  /** the session aborted the active dialog — no choice was recorded for it */
  cancelled?: boolean;
}

const SUGGESTION_OPTIONS = [
  "Allow for session",
  "Allow for project",
  "Allow globally",
  "Protect for project",
  "Protect for global",
  "Skip",
] as const;

/** Run the per-path suggestion dialogs. Stops early when a path is protected. */
export async function runSuggestionStep(opts: SuggestionStepOptions): Promise<SuggestionStepResult> {
  const choices: SuggestionChoice[] = [];
  // concrete, deduped, glob-free paths only — the model is instructed to
  // return concrete paths; anything else stays audit-only
  const paths = [...new Set(opts.suggestions.paths.filter((p) => p && !/[*?\[\]]/.test(p)))];

  for (let i = 0; i < paths.length; i++) {
    const path = paths[i];
    const pathKind = opts.pathKindFor?.(path) ?? "file";
    const picked = await choose(
      opts.ui,
      `Immunity (${i + 1}/${paths.length}): analyzer flagged ${path}`,
      [...SUGGESTION_OPTIONS],
      opts.signal,
    );
    if (picked.cancelled) return { choices, protected: true, failed: true, cancelled: true };
    if (picked.failed) return { choices, protected: true, failed: true }; // a broken prompt must not let the call through
    const choice = picked.choice;
    if (choice === undefined) {
      return { choices, protected: true, failed: true }; // dismissed → block (safety-first)
    }

    if (choice === "Skip") {
      choices.push({ action: "skip" });
      continue;
    }
    if (choice === "Allow for session") {
      opts.session.addAllow(`file:${path}`, pathKind);
      choices.push({ action: "allow", scope: "session", value: path, pathKind });
      continue;
    }
    const scope: "project" | "global" = choice === "Allow globally" || choice === "Protect for global" ? "global" : "project";
    if (choice === "Allow for project" || choice === "Allow globally") {
      const persisted = await opts.saveRule("pathAllow", path, scope, { pathKind });
      choices.push({ action: "allow", scope, value: path, pathKind, persisted });
      continue;
    }
    // protect — a deny rule; the command that touches this path is blocked, no command menu
    const persisted = await opts.saveRule("pathDeny", path, scope, { pathKind });
    choices.push({ action: "protect", scope, value: path, pathKind, persisted });
    return { choices, protected: true, protectedPath: path, failed: false };
  }
  return { choices, protected: false, failed: false };
}

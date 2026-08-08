/**
 * Prompt & block flow (design §6) — pure module, UI shapes mirror pi's
 * `ctx.ui` (`select`/`input` return undefined when dismissed).
 *
 * Primary menu: Allow once | Allow for session | Always allow | Deny |
 * Deny with reason.
 *   - Allow once        → proceed with this call, no grant recorded
 *                         (literally one call; the next identical call
 *                         prompts again)
 *   - Allow for session → session grant recorded (prompting.sessionGrants)
 *   - Always allow      → persisted grant via the persistGrant hook
 *                         (commands.allowed / pathnames.allowed in the
 *                         scope index.ts picks); still allows this call if
 *                         persistence fails (persisted: false)
 *   - Deny              → block, source "user"
 *   - Deny with reason  → optional reason → block with `userReason`; when
 *                         prompting.askReasonOnDeny, a follow-up offers to
 *                         persist the intent as a rule
 *   - dismissed (undefined) or UI failure → deny (safety-first: nothing
 *                         gets through a broken or dismissed prompt)
 *
 * Rule follow-up menu: No | Block this command pattern (bash) | Protect
 * this path (file) — gated on which value the request carries.
 */
import type { MemoryGrantStore } from "./grants.ts";
import type { PromptingConfig } from "./config.ts";
import type { Suggestions } from "./pipeline.ts";

export interface PromptUi {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
}

export type PromptResult =
  | { action: "allow"; grant: "once" | "session" | "always"; persisted?: boolean }
  | { action: "deny"; userReason?: string; savedRule?: "autoDeny" | "path" }
  | {
      action: "suggestion";
      /** writeRule kind the choice maps to */
      kind: "path" | "pathAllow" | "autoDeny";
      value: string;
      scope: "project" | "global";
    };

export interface PromptFlowOptions {
  ui: PromptUi;
  /** the pipeline reason shown in the prompt */
  reason: string;
  grantKey: string;
  /** session grant store ("Allow for session" lands here) */
  grants: Pick<MemoryGrantStore, "add">;
  prompting: Pick<PromptingConfig, "askReasonOnDeny" | "sessionGrants">;
  /** raw command for the "Block this command pattern" rule (bash requests) */
  command?: string;
  /** resolved target for the "Protect this path" rule (file requests) */
  protectPath?: string;
  /** the model's actionable suggestions — rendered as protect/allow/block options */
  suggestions?: Suggestions;
  /** persists a deny rule to config; return false when the save failed */
  saveRule?: (kind: "autoDeny" | "path", value: string, scope?: "project" | "global") => boolean | Promise<boolean>;
  /** persists an "always allow" grant to config (commands.allowed / pathnames.allowed) */
  persistGrant?: (kind: "command" | "path", value: string, scope?: "project" | "global") => boolean | Promise<boolean>;
}

const ALLOW_ONCE = "Allow once";
const ALLOW_SESSION = "Allow for session";
const ALWAYS_ALLOW = "Always allow";
const DENY = "Deny";
const DENY_WITH_REASON = "Deny with reason";

const NO = "No";
const BLOCK_PATTERN = "Block this command pattern";
const PROTECT_PATH = "Protect this path";

function suggestionOptions(suggestions: Suggestions): { label: string; result: Extract<PromptResult, { action: "suggestion" }> }[] {
  const out: { label: string; result: Extract<PromptResult, { action: "suggestion" }> }[] = [];
  // the model is instructed to return concrete paths; glob-ish entries are
  // audit-only (they can never become exact allow rules)
  const concrete = suggestions.paths.filter((p) => !/[*?\[\]]/.test(p));
  for (const p of concrete) {
    out.push({ label: `Protect ${p} (project)`, result: { action: "suggestion", kind: "path", value: p, scope: "project" } });
    out.push({ label: `Protect ${p} (global)`, result: { action: "suggestion", kind: "path", value: p, scope: "global" } });
    out.push({ label: `Allow ${p} (project)`, result: { action: "suggestion", kind: "pathAllow", value: p, scope: "project" } });
    out.push({ label: `Allow ${p} (global)`, result: { action: "suggestion", kind: "pathAllow", value: p, scope: "global" } });
  }
  for (const c of suggestions.commands) {
    out.push({ label: `Block ${c.raw}`, result: { action: "suggestion", kind: "autoDeny", value: c.raw, scope: "project" } });
  }
  return out;
}

export async function runPromptFlow(opts: PromptFlowOptions): Promise<PromptResult> {
  const suggestionEntries = opts.suggestions ? suggestionOptions(opts.suggestions) : [];
  const options = [
    ALLOW_ONCE,
    ...(opts.prompting.sessionGrants ? [ALLOW_SESSION] : []),
    ...(opts.persistGrant ? [ALWAYS_ALLOW] : []),
    DENY,
    DENY_WITH_REASON,
    ...suggestionEntries.map((e) => e.label),
  ];

  let choice: string | undefined;
  try {
    choice = await opts.ui.select(`Immunity: ${opts.reason}`, options);
  } catch {
    return { action: "deny" }; // a broken prompt must not let the call through
  }

  if (choice === undefined || choice === DENY) {
    return { action: "deny" };
  }
  const suggestion = suggestionEntries.find((e) => e.label === choice);
  if (suggestion) {
    return suggestion.result;
  }
  if (choice === ALLOW_ONCE) {
    return { action: "allow", grant: "once" };
  }
  if (choice === ALLOW_SESSION) {
    opts.grants.add(opts.grantKey, "session");
    return { action: "allow", grant: "session" };
  }
  if (choice === ALWAYS_ALLOW && opts.persistGrant) {
    const kind = opts.command !== undefined ? "command" : "path";
    const value = kind === "command" ? opts.command : opts.protectPath;
    const persisted = value !== undefined ? await opts.persistGrant(kind, value) : false;
    return { action: "allow", grant: "always", persisted };
  }
  // choice === DENY_WITH_REASON
  let userReason: string | undefined;
  try {
    userReason = await opts.ui.input("Reason for blocking (optional)");
  } catch {
    userReason = undefined;
  }

  const result: PromptResult = { action: "deny", userReason };
  if (userReason && opts.prompting.askReasonOnDeny) {
    const savedRule = await rememberRuleFlow(opts);
    if (savedRule) result.savedRule = savedRule;
  }
  return result;
}

async function rememberRuleFlow(opts: PromptFlowOptions): Promise<"autoDeny" | "path" | undefined> {
  const options = [NO];
  if (opts.command !== undefined) options.push(BLOCK_PATTERN);
  if (opts.protectPath !== undefined) options.push(PROTECT_PATH);
  if (options.length === 1 || !opts.saveRule) return undefined;

  let choice: string | undefined;
  try {
    choice = await opts.ui.select("Remember as a rule?", options);
  } catch {
    return undefined;
  }
  if (choice === BLOCK_PATTERN && opts.command !== undefined) {
    return (await opts.saveRule("autoDeny", opts.command)) ? "autoDeny" : undefined;
  }
  if (choice === PROTECT_PATH && opts.protectPath !== undefined) {
    return (await opts.saveRule("path", opts.protectPath)) ? "path" : undefined;
  }
  return undefined;
}

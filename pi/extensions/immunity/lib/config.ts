/**
 * pi-immunity config (2025-08 rework): types, defaults, normalization,
 * scope merge, loader.
 *
 * Pure module — no pi imports, so it runs under plain `node --test`.
 * The extension entry (index.ts) supplies the real paths (getAgentDir,
 * CONFIG_DIR_NAME, ctx.cwd) and the trust flag (ctx.isProjectTrusted()).
 *
 * Shape:
 *   strict        — LLM unavailable AND no rule match → prompt (true, default) or allow
 *   paths.rules   — { action: ask|allow|deny, kind: file|directory, path }
 *                    no globs; `~` allowed; relative must start with ./
 *                    directory = recursive; hard defaults: outside cwd + gitignored = block
 *   commands.rules— { action: allow|deny|ask, exact?, raw, regex? }
 *                    regex is deterministic-only, never fed to the LLM
 *   commands.promptWhen — 'asked' | 'blocked' (default) | 'everytime'
 *   llm           — disabled (opt-out, default on), provider/model/timeoutMs/userPrompt/piPath
 *   hooks.afterPrompt — user command run when a prompt opens
 *   audit.enabled — default on
 *
 * Merge (local overrules global): scalar sections are project-overrides-global;
 * rules are concatenated with PROJECT rules first (priority by order — both
 * for deterministic evaluation and for the LLM policy feed). Conflicts are
 * resolved by the evaluator (safest action wins); the LLM receives the
 * ordered list and resolves conflicts itself. `$schema` is tolerated on read
 * but never stamped on write.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type PathAction = "ask" | "allow" | "deny";
export type CommandAction = "allow" | "deny" | "ask";
export type PromptWhen = "asked" | "blocked" | "everytime";

export interface PathRule {
  action: PathAction;
  kind: "file" | "directory";
  path: string;
}

export interface CommandRule {
  action: CommandAction;
  /** true → full-string match; default (false) → substring match */
  exact: boolean;
  raw: string;
  /** deterministic-only matcher; never fed to the LLM */
  regex?: string;
}

export interface PathsConfig {
  rules: PathRule[];
}

export interface CommandsConfig {
  rules: CommandRule[];
  promptWhen: PromptWhen;
}

export interface LlmConfig {
  /** opt-out: the analysis layer is enabled unless disabled */
  disabled: boolean;
  provider: string;
  model: string;
  /** user-authored policy text appended to the analyzer system prompt */
  userPrompt: string;
  piPath: string;
  timeoutMs: number;
}

export interface HooksConfig {
  /** bash command run right before an approval prompt opens */
  afterPrompt: string;
}

export interface AuditConfig {
  enabled: boolean;
}

export interface ImmunityConfig {
  strict: boolean;
  paths: PathsConfig;
  commands: CommandsConfig;
  llm: LlmConfig;
  hooks: HooksConfig;
  audit: AuditConfig;
}

export const DEFAULT_CONFIG: ImmunityConfig = {
  strict: true,
  paths: { rules: [] },
  commands: { rules: [], promptWhen: "blocked" },
  llm: {
    disabled: false,
    provider: "",
    model: "",
    userPrompt: "",
    piPath: "",
    timeoutMs: 30_000,
  },
  hooks: { afterPrompt: "" },
  audit: { enabled: true },
};

export function defaultGlobalConfigPath(home: string): string {
  return join(home, ".pi", "agent", "immunity.json");
}

export function defaultProjectConfigPath(cwd: string, configDirName = ".pi"): string {
  return join(cwd, configDirName, "immunity.json");
}

/* ------------------------------------------------------------------ */
/* Normalization (garbage-in guard at the config boundary)              */
/* ------------------------------------------------------------------ */

function asRecord(x: unknown): Record<string, unknown> | null {
  return typeof x === "object" && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}

function asString(x: unknown): string | null {
  return typeof x === "string" ? x : null;
}

function asBoolean(x: unknown): boolean | null {
  return typeof x === "boolean" ? x : null;
}

const GLOB_METACHARS = /[*?[\]]/;

/** Path input contract: no globs; `~` allowed; relative must start with `./`. */
export function isValidPathInput(path: string): boolean {
  if (!path || GLOB_METACHARS.test(path)) return false;
  return path === "~" || path.startsWith("~/") || path.startsWith("./") || path.startsWith("/");
}

function isValidRegExp(s: string): boolean {
  try {
    new RegExp(s);
    return true;
  } catch {
    return false;
  }
}

export function asPathRule(x: unknown): PathRule | null {
  const r = asRecord(x);
  if (!r) return null;
  const action = r.action === "ask" ? "ask" : r.action === "allow" ? "allow" : r.action === "deny" ? "deny" : null;
  const kind = r.kind === "file" ? "file" : r.kind === "directory" ? "directory" : null;
  const path = asString(r.path);
  if (!action || !kind || !path || !isValidPathInput(path)) return null;
  return { action, kind, path };
}

export function asCommandRule(x: unknown): CommandRule | null {
  const r = asRecord(x);
  if (!r) return null;
  const action = r.action === "allow" ? "allow" : r.action === "deny" ? "deny" : r.action === "ask" ? "ask" : null;
  const raw = asString(r.raw);
  if (!action || !raw) return null;
  const rule: CommandRule = { action, exact: asBoolean(r.exact) ?? false, raw };
  // broken regex degrades to string matching per `exact` (never silently
  // drops the rule — a deny rule must not vanish because of a typo)
  const regex = asString(r.regex);
  if (regex && isValidRegExp(regex)) rule.regex = regex;
  return rule;
}

/* ------------------------------------------------------------------ */
/* Scope merge                                                         */
/* ------------------------------------------------------------------ */

function asBooleanOr(x: Record<string, unknown> | null, key: string, fallback: boolean): boolean {
  const v = x ? x[key] : undefined;
  return asBoolean(v) ?? fallback;
}

function asStringOr(x: Record<string, unknown> | null, key: string, fallback: string): string {
  const v = x ? x[key] : undefined;
  return asString(v) ?? fallback;
}

function asPositiveNumberOr(x: Record<string, unknown> | null, key: string, fallback: number): number {
  const v = x ? x[key] : undefined;
  return typeof v === "number" && v > 0 ? v : fallback;
}

function asPromptWhen(x: Record<string, unknown> | null, fallback: PromptWhen): PromptWhen {
  const v = x ? x["promptWhen"] : undefined;
  return v === "asked" || v === "blocked" || v === "everytime" ? v : fallback;
}

function rulesOf(section: Record<string, unknown> | null, key: string): unknown[] {
  return section && Array.isArray(section[key]) ? section[key] : [];
}

/**
 * Merge a raw project config over a normalized global config.
 * - Scalars: project value when present and valid, else keep global.
 * - Rules: union, PROJECT entries first — project rules overrule global
 *   rules by evaluation order, and the LLM policy feed lists them in the
 *   same priority order.
 */
export function mergeConfig(global: ImmunityConfig, projectRaw: Record<string, unknown> | null): ImmunityConfig {
  if (!projectRaw) return global;
  const p = asRecord(projectRaw.paths);
  const pc = asRecord(projectRaw.commands);
  const pl = asRecord(projectRaw.llm);
  const ph = asRecord(projectRaw.hooks);
  const pa = asRecord(projectRaw.audit);

  return {
    strict: asBooleanOr(projectRaw, "strict", global.strict),
    paths: {
      rules: [
        ...rulesOf(p, "rules").map(asPathRule).filter((e): e is PathRule => e !== null),
        ...global.paths.rules,
      ],
    },
    commands: {
      rules: [
        ...rulesOf(pc, "rules").map(asCommandRule).filter((e): e is CommandRule => e !== null),
        ...global.commands.rules,
      ],
      promptWhen: asPromptWhen(pc, global.commands.promptWhen),
    },
    llm: {
      disabled: asBooleanOr(pl, "disabled", global.llm.disabled),
      provider: asStringOr(pl, "provider", global.llm.provider),
      model: asStringOr(pl, "model", global.llm.model),
      userPrompt: asStringOr(pl, "userPrompt", global.llm.userPrompt),
      piPath: asStringOr(pl, "piPath", global.llm.piPath),
      timeoutMs: asPositiveNumberOr(pl, "timeoutMs", global.llm.timeoutMs),
    },
    hooks: {
      afterPrompt: asStringOr(ph, "afterPrompt", global.hooks.afterPrompt),
    },
    audit: {
      enabled: asBooleanOr(pa, "enabled", global.audit.enabled),
    },
  };
}

/** Keep only known fields with valid types; wrong types fall back to defaults. */
export function normalizeConfig(raw: unknown): ImmunityConfig {
  return mergeConfig(DEFAULT_CONFIG, asRecord(raw));
}

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

export interface ConfigScope {
  path: string;
  /** file existed and parsed cleanly */
  loaded: boolean;
  error?: string;
  /** project scope not honored because the project is untrusted */
  skipped?: boolean;
}

/** Scoped rule views for deterministic evaluation (project overrules global). */
export interface ScopedRules {
  paths: { project: PathRule[]; global: PathRule[] };
  commands: { project: CommandRule[]; global: CommandRule[] };
}

export interface LoadResult {
  /** merged config: rules ordered project-first then global (LLM feed) */
  config: ImmunityConfig;
  /** scoped rule views (deterministic evaluation) */
  rules: ScopedRules;
  scopes: ConfigScope[];
}

export interface LoadOptions {
  globalPath: string;
  projectPath: string | null;
  /** whether the project is trusted (ctx.isProjectTrusted()); false skips the project scope */
  trusted: boolean;
}

function readScope(path: string): { loaded: boolean; error?: string; raw?: unknown } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { loaded: false }; // missing or unreadable — fine, defaults apply
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { loaded: false, error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (asRecord(raw) === null) {
    return { loaded: false, error: "config must be a JSON object" };
  }
  return { loaded: true, raw };
}

/** Read + merge the two scopes. Errors are reported per scope, never thrown. */
export function loadConfig(opts: LoadOptions): LoadResult {
  const scopes: ConfigScope[] = [];
  const global = readScope(opts.globalPath);
  scopes.push({ path: opts.globalPath, loaded: global.loaded, error: global.error });

  let project: { loaded: boolean; error?: string; raw?: unknown } | null = null;
  if (opts.projectPath === null || !opts.trusted) {
    if (opts.projectPath !== null) {
      scopes.push({ path: opts.projectPath, loaded: false, skipped: !opts.trusted });
    }
  } else {
    project = readScope(opts.projectPath);
    scopes.push({ path: opts.projectPath, loaded: project.loaded, error: project.error });
  }

  const globalConfig = global.raw !== undefined ? normalizeConfig(global.raw) : DEFAULT_CONFIG;
  const projectConfig = project?.raw !== undefined ? normalizeConfig(project.raw) : null;

  return {
    config: mergeConfig(globalConfig, project?.raw !== undefined ? asRecord(project.raw) : null),
    rules: {
      paths: {
        project: projectConfig?.paths.rules ?? [],
        global: globalConfig.paths.rules,
      },
      commands: {
        project: projectConfig?.commands.rules ?? [],
        global: globalConfig.commands.rules,
      },
    },
    scopes,
  };
}

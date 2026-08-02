/**
 * pi-immunity config: types, defaults, normalization, scope merge, loader.
 *
 * Pure module — no pi imports, so it runs under plain `node --test`.
 * The extension entry (index.ts) supplies the real paths (getAgentDir,
 * CONFIG_DIR_NAME, ctx.cwd) and the trust flag (ctx.isProjectTrusted()).
 *
 * Merge semantics (design §3): scalar sections are project-overrides-global;
 * list sections are unions with global entries first (a project file can
 * never weaken a global protection); `enabled` is AND (either scope can
 * switch immunity off entirely). `$schema` is tolerated on read and stamped
 * on save (immunity.schema.json, hand-maintained).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface PathRule {
  pattern: string;
  mode: "read" | "modify";
  onlyIfExists?: boolean;
  regex?: boolean;
}

export interface PathAllow {
  kind: "file" | "directory";
  path: string;
}

export interface PathnameRules {
  protected: PathRule[];
  allowed: PathAllow[];
}

export interface CommandRules {
  patterns: string[];
  autoDenyPatterns: string[];
  /** exact command strings always allowed (persisted "always" grants) */
  allowed: string[];
  useBuiltinMatchers: boolean;
}

export interface LlmConfig {
  enabled: boolean;
  provider: string;
  model: string;
  appendSystemPrompt: string;
  piPath: string;
  timeoutMs: number;
  autoDeny: boolean;
  /** debug mode: an ALLOWED verdict prompts the user (showing the verdict) instead of auto-allowing */
  confirm: boolean;
}

export interface TreeSitterConfig {
  binPath: string;
  grammarDir: string | null;
}

export interface PromptingConfig {
  requireConfirmation: boolean;
  askReasonOnDeny: boolean;
  sessionGrants: boolean;
  onPromptCommand: string;
}

export interface AuditConfig {
  enabled: boolean;
  file: string;
}

export interface ImmunityConfig {
  version: 1;
  enabled: boolean;
  pathnames: PathnameRules;
  commands: CommandRules;
  llm: LlmConfig;
  treeSitter: TreeSitterConfig;
  prompting: PromptingConfig;
  audit: AuditConfig;
}

export const DEFAULT_CONFIG: ImmunityConfig = {
  version: 1,
  enabled: true,
  pathnames: { protected: [], allowed: [] },
  commands: { patterns: [], autoDenyPatterns: [], allowed: [], useBuiltinMatchers: true },
  llm: {
    enabled: false,
    provider: "",
    model: "",
    appendSystemPrompt: "",
    piPath: "",
    timeoutMs: 30_000,
    autoDeny: false,
    confirm: false,
  },
  treeSitter: { binPath: "tree-sitter", grammarDir: null },
  prompting: {
    requireConfirmation: true,
    askReasonOnDeny: true,
    sessionGrants: true,
    onPromptCommand: "",
  },
  audit: { enabled: true, file: "" },
};

/** Paths of the `$schema` target, resolved next to this module's sibling schema file. */
export const SCHEMA_URL = new URL("../immunity.schema.json", import.meta.url).href;

export function defaultGlobalConfigPath(home: string): string {
  return join(home, ".pi", "agent", "immunity.json");
}

export function defaultProjectConfigPath(cwd: string, configDirName = ".pi"): string {
  return join(cwd, configDirName, "immunity.json");
}

/** Stamp `$schema` first so editors pick it up; returns a new object. */
export function stampSchema(raw: Record<string, unknown>): Record<string, unknown> {
  return { $schema: SCHEMA_URL, ...raw };
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

function asStringArray(x: unknown): string[] {
  return Array.isArray(x) ? x.filter((e): e is string => typeof e === "string") : [];
}

function isValidRegExp(s: string): boolean {
  try {
    new RegExp(s);
    return true;
  } catch {
    return false;
  }
}

function asPathRule(x: unknown): PathRule | null {
  const r = asRecord(x);
  const pattern = r ? asString(r.pattern) : null;
  const mode = r && r.mode === "read" ? "read" : r && r.mode === "modify" ? "modify" : null;
  const regex = r ? asBoolean(r.regex) ?? false : false;
  if (!r || !pattern || !mode) return null;
  if (regex && !isValidRegExp(pattern)) return null; // broken regex rules are dropped at load
  return {
    pattern,
    mode,
    onlyIfExists: asBoolean(r.onlyIfExists) ?? false,
    regex,
  };
}

function asPathAllow(x: unknown): PathAllow | null {
  const r = asRecord(x);
  if (!r) return null;
  const kind = r.kind === "file" ? "file" : r.kind === "directory" ? "directory" : null;
  const path = asString(r.path);
  if (!kind || !path) return null;
  return { kind, path };
}

/* ------------------------------------------------------------------ */
/* Scope merge (raw project fields over the normalized global config)  */
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

/**
 * Merge a raw project config over the normalized global config.
 * - Scalar fields: project value when present and valid, else keep global.
 * - List fields: union, global entries first — a project file cannot
 *   weaken a global protection (or drop a global pattern).
 * - `enabled`: AND — a project can switch immunity off locally, but can
 *   never re-enable a globally-disabled extension (global is the root of
 *   trust).
 */
export function mergeConfig(global: ImmunityConfig, projectRaw: Record<string, unknown> | null): ImmunityConfig {
  if (!projectRaw) return global;
  const p = asRecord(projectRaw.pathnames);
  const pc = asRecord(projectRaw.commands);
  const pl = asRecord(projectRaw.llm);
  const pt = asRecord(projectRaw.treeSitter);
  const pp = asRecord(projectRaw.prompting);
  const pa = asRecord(projectRaw.audit);

  return {
    version: 1,
    enabled: global.enabled && asBooleanOr(projectRaw, "enabled", true),
    pathnames: {
      protected: [
        ...global.pathnames.protected,
        ...(p && Array.isArray(p.protected) ? p.protected.map(asPathRule).filter((e): e is PathRule => e !== null) : []),
      ],
      allowed: [
        ...global.pathnames.allowed,
        ...(p && Array.isArray(p.allowed) ? p.allowed.map(asPathAllow).filter((e): e is PathAllow => e !== null) : []),
      ],
    },
    commands: {
      patterns: [...global.commands.patterns, ...(pc ? asStringArray(pc.patterns) : [])],
      autoDenyPatterns: [...global.commands.autoDenyPatterns, ...(pc ? asStringArray(pc.autoDenyPatterns) : [])],
      allowed: [...global.commands.allowed, ...(pc ? asStringArray(pc.allowed) : [])],
      useBuiltinMatchers: asBooleanOr(pc, "useBuiltinMatchers", global.commands.useBuiltinMatchers),
    },
    llm: {
      enabled: asBooleanOr(pl, "enabled", global.llm.enabled),
      provider: asStringOr(pl, "provider", global.llm.provider),
      model: asStringOr(pl, "model", global.llm.model),
      appendSystemPrompt: asStringOr(pl, "appendSystemPrompt", global.llm.appendSystemPrompt),
      piPath: asStringOr(pl, "piPath", global.llm.piPath),
      timeoutMs: asPositiveNumberOr(pl, "timeoutMs", global.llm.timeoutMs),
      autoDeny: asBooleanOr(pl, "autoDeny", global.llm.autoDeny),
      confirm: asBooleanOr(pl, "confirm", global.llm.confirm),
    },
    treeSitter: {
      binPath: asStringOr(pt, "binPath", global.treeSitter.binPath),
      grammarDir: pt
        ? typeof pt.grammarDir === "string"
          ? pt.grammarDir
          : pt.grammarDir === null
            ? null
            : global.treeSitter.grammarDir
        : global.treeSitter.grammarDir,
    },
    prompting: {
      requireConfirmation: asBooleanOr(pp, "requireConfirmation", global.prompting.requireConfirmation),
      askReasonOnDeny: asBooleanOr(pp, "askReasonOnDeny", global.prompting.askReasonOnDeny),
      sessionGrants: asBooleanOr(pp, "sessionGrants", global.prompting.sessionGrants),
      onPromptCommand: asStringOr(pp, "onPromptCommand", global.prompting.onPromptCommand),
    },
    audit: {
      enabled: asBooleanOr(pa, "enabled", global.audit.enabled),
      file: asStringOr(pa, "file", global.audit.file),
    },
  };
}

/** Keep only known fields with valid types; wrong types fall back to defaults. */
export function normalizeConfig(raw: unknown): ImmunityConfig {
  return mergeConfig(DEFAULT_CONFIG, asRecord(raw));
}

/* ------------------------------------------------------------------ */
/* Loading                                                              */
/* ------------------------------------------------------------------ */

export interface ConfigScope {
  path: string;
  /** file existed and parsed cleanly */
  loaded: boolean;
  error?: string;
  /** project scope not honored because the project is untrusted */
  skipped?: boolean;
}

export interface LoadResult {
  config: ImmunityConfig;
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
  const projectRaw = project?.raw !== undefined ? asRecord(project.raw) : null;
  return { config: mergeConfig(globalConfig, projectRaw), scopes };
}

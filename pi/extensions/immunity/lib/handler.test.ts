import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, type ImmunityConfig } from "./config.ts";
import { handleToolCall, type HandlerEnv, type ScopedRuleViews } from "./handler.ts";
import { SessionState } from "./session.ts";
import { FakeBus, FakeUi } from "./testing.ts";
import { writeRule } from "./rules.ts";
import type { ToolRequest } from "./pipeline.ts";
import type { VerdictResult } from "./llm-client.ts";

const HOME = "/home/u";
const tmpDirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(import.meta.dirname, ".test-tmp-"));
  tmpDirs.push(dir);
  return dir;
}
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function auditLines(dir: string): Record<string, unknown>[] {
  const file = join(dir, "audit.jsonl");
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

interface EnvOpts {
  config?: Partial<ImmunityConfig>;
  rules?: Partial<ScopedRuleViews>;
  llmClient?: (command: string, opts: { cwd: string; policy: string }) => Promise<VerdictResult>;
  gitIgnoreCheck?: (path: string, cwd: string) => Promise<boolean>;
  onPromptCommand?: (command: string, env: Record<string, string>) => void;
  pathKindFor?: (target: string) => "file" | "directory";
  session?: SessionState;
}

function makeEnv(o: EnvOpts = {}): { env: HandlerEnv; ui: FakeUi; dir: string; bus: FakeBus } {
  const dir = tmp();
  mkdirSync(join(dir, "repo"));
  const config: ImmunityConfig = {
    ...DEFAULT_CONFIG,
    ...o.config,
    commands: { ...DEFAULT_CONFIG.commands, ...o.config?.commands },
    llm: { ...DEFAULT_CONFIG.llm, ...o.config?.llm },
    paths: { ...DEFAULT_CONFIG.paths, ...o.config?.paths },
    hooks: { ...DEFAULT_CONFIG.hooks, ...o.config?.hooks },
  };
  const rules: ScopedRuleViews = {
    paths: {
      project: [...(o.rules?.paths?.project ?? [])],
      global: [...(o.rules?.paths?.global ?? [])],
    },
    commands: {
      project: [...(o.rules?.commands?.project ?? [])],
      global: [...(o.rules?.commands?.global ?? [])],
    },
  };
  const ui = new FakeUi();
  const bus = new FakeBus();
  const env: HandlerEnv = {
    config,
    rules,
    session: o.session ?? new SessionState(),
    bus,
    sessionId: "test-session",
    cwd: join(dir, "repo"),
    home: HOME,
    ui,
    auditFile: join(dir, "audit.jsonl"),
    ruleScope: join(dir, "project-immunity.json"),
    globalRuleScope: join(dir, "global-immunity.json"),
    llmClient: o.llmClient,
    gitIgnoreCheck: o.gitIgnoreCheck ?? (async () => false),
    onPromptCommand: o.onPromptCommand ?? (() => {}),
    pathKindFor: o.pathKindFor,
  };
  // mirror index.ts writeRuleEffective: persist + reflect into the scoped views
  env.saveRule = async (kind, value, scope, w) => {
    const ok = writeRule(scope === "global" ? env.globalRuleScope : env.ruleScope, kind, value, w);
    if (!ok) return false;
    const paths = scope === "global" ? env.rules.paths.global : env.rules.paths.project;
    const commands = scope === "global" ? env.rules.commands.global : env.rules.commands.project;
    const pathKind = w?.pathKind ?? "file";
    switch (kind) {
      case "commandAllow":
        commands.push({ action: "allow", exact: true, raw: value });
        break;
      case "commandDeny":
        commands.push({ action: "deny", exact: true, raw: value });
        break;
      case "pathAllow":
        paths.push({ action: "allow", kind: pathKind, path: value });
        break;
      case "pathDeny":
        paths.push({ action: "deny", kind: pathKind, path: value });
        break;
    }
    return true;
  };
  return { env, ui, dir, bus };
}

const bash = (command: string): ToolRequest => ({ kind: "bash", command, cwd: "/repo", home: HOME });
const file = (target: string, tool = "read"): ToolRequest => ({ kind: "file", tool, target, cwd: "/repo", home: HOME });
const LLM_OFF = { ...DEFAULT_CONFIG.llm, disabled: true };
const verdict = (risk: "none" | "low" | "high", outcome: "ALLOWED" | "DENY" | "ASK_USER"): VerdictResult => ({ ok: true, verdict: { risk, outcome } });

describe("handleToolCall — allow paths", () => {
  it("file inside cwd, no rules, non-strict → allow, no menu, no audit", async () => {
    const { env, ui, dir } = makeEnv({ config: { strict: false, llm: LLM_OFF } });
    const r = await handleToolCall(file("./a.ts"), env);
    assert.deepEqual(r, { allow: true });
    assert.equal(ui.selectCalls.length, 0);
    assert.deepEqual(auditLines(dir), []);
  });

  it("project allow rule → allow without menu", async () => {
    const { env, ui } = makeEnv({
      config: { llm: LLM_OFF },
      rules: { paths: { project: [{ action: "allow", kind: "file", path: "./x" }] } },
    });
    const r = await handleToolCall(file("./x"), env);
    assert.deepEqual(r, { allow: true });
    assert.equal(ui.selectCalls.length, 0);
  });

  it("bash + LLM ALLOWED verdict → allow; verdict trail audited", async () => {
    const { env, dir } = makeEnv({ llmClient: async () => verdict("none", "ALLOWED") });
    const r = await handleToolCall(bash("ls -la"), env);
    assert.deepEqual(r, { allow: true });
    const lines = auditLines(dir);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].event, "verdict");
    assert.equal(lines[0].outcome, "ALLOWED");
  });
});

describe("handleToolCall — outside cwd boundary + menu", () => {
  it("outside file → prompt → Allow for session → allowed; session short-circuits next call", async () => {
    const { env, ui } = makeEnv({ config: { llm: LLM_OFF } });
    ui.selects.push("Allow for session");
    const r = await handleToolCall(file("/etc/hosts"), env);
    assert.deepEqual(r, { allow: true });
    assert.equal(ui.selectCalls.length, 2, "main menu + path-kind follow-up");
    // second identical call: no prompt, no menu
    const r2 = await handleToolCall(file("/etc/hosts"), env);
    assert.deepEqual(r2, { allow: true });
    assert.equal(ui.selectCalls.length, 2);
  });

  it("outside file → Block for project + reason → blocked; rule + audit written", async () => {
    const { env, ui, dir } = makeEnv({ config: { llm: LLM_OFF } });
    ui.selects.push("Block for project", undefined, "Yes"); // follow-up dismissed → file rule
    ui.inputs.push("never touch /etc/hosts");
    const r = await handleToolCall(file("/etc/hosts"), env);
    assert.equal(r.allow, false);
    assert.match(r.reason, /Blocked by user: never touch \/etc\/hosts/);

    const raw = JSON.parse(readFileSync(join(dir, "project-immunity.json"), "utf8"));
    assert.deepEqual(raw.paths.rules, [{ action: "deny", kind: "file", path: "/etc/hosts" }]);

    const lines = auditLines(dir);
    const rule = lines.find((l) => l.event === "rule");
    assert.equal(rule?.kind, "pathDeny");
    assert.equal(rule?.scope, "project");
    assert.equal(rule?.persisted, true);
    const block = lines.find((l) => l.event === "block");
    assert.equal(block?.source, "user");
    assert.equal(block?.userReason, "never touch /etc/hosts");
  });

  it("Allow globally writes to the global scope file", async () => {
    const { env, ui, dir } = makeEnv({ config: { llm: LLM_OFF } });
    ui.selects.push("Allow globally");
    const r = await handleToolCall(file("/etc/hosts"), env);
    assert.deepEqual(r, { allow: true });
    const raw = JSON.parse(readFileSync(join(dir, "global-immunity.json"), "utf8"));
    assert.deepEqual(raw.paths.rules, [{ action: "allow", kind: "file", path: "/etc/hosts" }]);
    // and the scoped view reflects it (effective immediately)
    assert.deepEqual(env.rules.paths.global.map((x) => x.path), ["/etc/hosts"]);
  });

  it("path rule kind comes from pathKindFor", async () => {
    const { env, ui, dir } = makeEnv({ config: { llm: LLM_OFF }, pathKindFor: () => "directory" });
    ui.selects.push("Allow for project");
    const r = await handleToolCall(file("/etc/hosts"), env);
    assert.deepEqual(r, { allow: true });
    const raw = JSON.parse(readFileSync(join(dir, "project-immunity.json"), "utf8"));
    assert.equal(raw.paths.rules[0].kind, "directory");
  });

  it("Allow for project on a file can widen to the containing directory", async () => {
    const { env, ui, dir } = makeEnv({ config: { llm: LLM_OFF } });
    ui.selects.push("Allow for project", "The whole directory (recursive)");
    const r = await handleToolCall(file("/etc/hosts"), env);
    assert.deepEqual(r, { allow: true });
    const raw = JSON.parse(readFileSync(join(dir, "project-immunity.json"), "utf8"));
    assert.deepEqual(raw.paths.rules, [{ action: "allow", kind: "directory", path: "/etc" }]);
    assert.deepEqual(env.rules.paths.project, [{ action: "allow", kind: "directory", path: "/etc" }]);
  });

  it("dismissed prompt → blocked, nothing leaks", async () => {
    const { env, ui } = makeEnv({ config: { llm: LLM_OFF } });
    ui.selects.push(undefined);
    const r = await handleToolCall(file("/etc/hosts"), env);
    assert.equal(r.allow, false);
    assert.match(r.reason, /Blocked by user/);
  });
});

describe("handleToolCall — bash verdicts and silent blocks", () => {
  it("LLM DENY + promptWhen asked → silent block, no menu", async () => {
    const { env, ui } = makeEnv({
      config: { commands: { ...DEFAULT_CONFIG.commands, promptWhen: "asked" } },
      llmClient: async () => verdict("high", "DENY"),
    });
    const r = await handleToolCall(bash("rm -rf x"), env);
    assert.equal(r.allow, false);
    assert.match(r.reason, /Blocked by llm/);
    assert.equal(ui.selectCalls.length, 0);
  });

  it("LLM DENY + blocked (default) → prompt → user blocks with session statement", async () => {
    const { env, ui, dir } = makeEnv({ llmClient: async () => verdict("high", "DENY") });
    ui.selects.push("Block for session", "No");
    const r = await handleToolCall(bash("rm -rf x"), env);
    assert.equal(r.allow, false);
    assert.ok(env.session.isDenied("bash:rm -rf x"));
    const lines = auditLines(dir);
    const ses = lines.find((l) => l.event === "session");
    assert.equal(ses?.kind, "sessionDeny");
  });

  it("fallback deny rule (LLM disabled) + asked → silent block; blocked → prompt", async () => {
    const { env, ui } = makeEnv({
      config: { llm: LLM_OFF, commands: { ...DEFAULT_CONFIG.commands, promptWhen: "asked" } },
      rules: { commands: { project: [{ action: "deny", exact: true, raw: "git push --force" }] } },
    });
    const r = await handleToolCall(bash("git push --force"), env);
    assert.equal(r.allow, false);
    assert.match(r.reason, /Blocked by policy/);
    assert.equal(ui.selectCalls.length, 0);

    const { env: env2, ui: ui2 } = makeEnv({
      config: { llm: LLM_OFF },
      rules: { commands: { project: [{ action: "deny", exact: true, raw: "git push --force" }] } },
    });
    ui2.selects.push("Allow for session");
    const r2 = await handleToolCall(bash("git push --force"), env2);
    assert.deepEqual(r2, { allow: true });
  });

  it("DENY with suggestions: protect → command blocked, rule written, no command menu", async () => {
    const { env, ui, dir } = makeEnv({
      llmClient: async () => ({
        ok: true,
        verdict: { risk: "high", outcome: "DENY", paths: { blocked: ["/Users/alican/repos"] } },
      }),
    });
    ui.selects.push("Protect for project");
    const r = await handleToolCall(bash("find ~/repos -maxdepth 1 -type d | wc -l"), env);
    assert.equal(r.allow, false);
    assert.match(r.reason, /command touches protected path \/Users\/alican\/repos/);
    const raw = JSON.parse(readFileSync(join(dir, "project-immunity.json"), "utf8"));
    assert.deepEqual(raw.paths.rules, [{ action: "deny", kind: "file", path: "/Users/alican/repos" }]);
    assert.equal(ui.selectCalls.length, 1, "suggestion dialog only — no command menu");
    const lines = auditLines(dir);
    const rule = lines.find((l) => l.event === "rule");
    assert.equal(rule?.kind, "pathDeny");
    assert.equal(rule?.source, "suggestion");
    const block = lines.find((l) => l.event === "block");
    assert.match(block?.reason ?? "", /touches protected path/);
  });

  it("DENY with suggestions: all skipped → six-option menu still appears", async () => {
    const { env, ui } = makeEnv({
      llmClient: async () => ({
        ok: true,
        verdict: { risk: "high", outcome: "DENY", paths: { blocked: ["/Users/alican/repos"] } },
      }),
    });
    ui.selects.push("Skip", "Allow for session");
    const r = await handleToolCall(bash("find ~/repos -maxdepth 1 -type d | wc -l"), env);
    assert.deepEqual(r, { allow: true });
    assert.equal(ui.selectCalls.length, 2, "suggestion dialog + command menu");
    assert.ok(env.session.isAllowed("bash:find ~/repos -maxdepth 1 -type d | wc -l"));
  });

  it("DENY with suggestions: allow path for session, then allow the command", async () => {
    const { env, ui, dir } = makeEnv({
      llmClient: async () => ({
        ok: true,
        verdict: { risk: "high", outcome: "DENY", paths: { blocked: ["/Users/alican/repos"] } },
      }),
    });
    ui.selects.push("Allow for session", "Allow for session");
    const r = await handleToolCall(bash("find ~/repos -maxdepth 1 -type d | wc -l"), env);
    assert.deepEqual(r, { allow: true });
    assert.ok(env.session.isAllowed("file:/Users/alican/repos"));
    assert.ok(env.session.isAllowed("bash:find ~/repos -maxdepth 1 -type d | wc -l"));
    const ses = auditLines(dir).filter((l) => l.event === "session");
    assert.equal(ses.length, 2, "path statement + command statement");
  });

  it("inconclusive LLM + no rules + strict (default) → prompt; strict:false → allow", async () => {
    const inconclusive = { ok: false as const, kind: "timeout" as const, error: "no verdict" };
    const { env, ui } = makeEnv({ llmClient: async () => inconclusive });
    ui.selects.push("Allow for session");
    const r = await handleToolCall(bash("ls -la"), env);
    assert.deepEqual(r, { allow: true });

    const { env: env2, ui: ui2 } = makeEnv({ config: { strict: false }, llmClient: async () => inconclusive });
    const r2 = await handleToolCall(bash("ls -la"), env2);
    assert.deepEqual(r2, { allow: true });
    assert.equal(ui2.selectCalls.length, 0);
  });

  it("Block for project on a command writes an exact deny rule", async () => {
    const { env, ui, dir } = makeEnv({
      config: { llm: LLM_OFF },
      rules: { commands: { project: [{ action: "ask", exact: false, raw: "npm install" }] } },
    });
    ui.selects.push("Block for project", "No");
    const r = await handleToolCall(bash("npm install lodash"), env);
    assert.equal(r.allow, false);
    const raw = JSON.parse(readFileSync(join(dir, "project-immunity.json"), "utf8"));
    assert.deepEqual(raw.commands.rules, [{ action: "deny", exact: true, raw: "npm install lodash" }]);
    assert.deepEqual(env.rules.commands.project.map((x) => x.raw), ["npm install", "npm install lodash"]);
  });
});

describe("handleToolCall — hooks", () => {
  it("hooks.afterPrompt runs before the menu with context env", async () => {
    let seen: { command: string; env: Record<string, string> } | null = null;
    const { env, ui } = makeEnv({
      config: { llm: LLM_OFF, hooks: { afterPrompt: "notify-send x" } },
      onPromptCommand: (command, e) => {
        seen = { command, env: e };
      },
    });
    ui.selects.push("Block for session", "No");
    await handleToolCall(file("/etc/hosts"), env);
    assert.equal(seen?.command, "notify-send x");
    assert.equal(seen?.env.IMMUNITY_FEATURE, "file");
    assert.ok(seen?.env.IMMUNITY_PROMPT_ID);
    assert.ok(seen?.env.IMMUNITY_REASON);
  });
});

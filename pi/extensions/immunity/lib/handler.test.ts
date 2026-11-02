import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, type ImmunityConfig } from "./config.ts";
import { handleToolCall, CANCELLED_REASON, type HandlerEnv, type ScopedRuleViews } from "./handler.ts";
import { SessionState } from "./session.ts";
import { FakeBus, FakeUi } from "./testing.ts";
import { writeRule } from "./rules.ts";
import type { ToolRequest } from "./pipeline.ts";
import type { VerdictResult } from "./llm-client.ts";
import { ApprovalQueue } from "./queue.ts";
import { AnalysisLimiter } from "./limiter.ts";

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
  approvals?: ApprovalQueue;
  limiter?: AnalysisLimiter;
  signal?: AbortSignal;
  ui?: FakeUi;
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
  const ui = o.ui ?? new FakeUi();
  const bus = new FakeBus();
  const env: HandlerEnv = {
    config,
    rules,
    session: o.session ?? new SessionState(),
    approvals: o.approvals ?? new ApprovalQueue(),
    limiter: o.limiter,
    bus,
    sessionId: "test-session",
    cwd: join(dir, "repo"),
    home: HOME,
    ui,
    signal: o.signal,
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
    ui.selects.push("Block for project", undefined, "Provide your reasoning"); // follow-up dismissed → file rule
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

  it("LLM DENY + blocked (default) → prompt → user denies once; no session state, no rule", async () => {
    const { env, ui, dir } = makeEnv({ llmClient: async () => verdict("high", "DENY") });
    ui.selects.push("Deny", "Use immunity's reasoning");
    const r = await handleToolCall(bash("rm -rf x"), env);
    assert.equal(r.allow, false);
    assert.match(r.reason, /Blocked by user/);
    assert.ok(!env.session.isDenied("bash:rm -rf x"), "one-shot deny leaves no session state");
    const lines = auditLines(dir);
    const block = lines.find((l) => l.event === "block");
    assert.equal(block?.source, "user");
    assert.equal(block?.userReason, undefined);
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
    ui2.selects.push("Allow");
    const r2 = await handleToolCall(bash("git push --force"), env2);
    assert.deepEqual(r2, { allow: true });
  });

  it("DENY with suggestions: command allowed first, then Protect persists a deny rule without blocking", async () => {
    const { env, ui, dir } = makeEnv({
      llmClient: async () => ({
        ok: true,
        verdict: { risk: "high", outcome: "DENY", paths: { blocked: ["/Users/alican/repos"] } },
      }),
    });
    ui.selects.push("Allow", "Protect for project");
    const r = await handleToolCall(bash("find ~/repos -maxdepth 1 -type d | wc -l"), env);
    assert.deepEqual(r, { allow: true }, "protect never blocks an already-allowed command");
    const raw = JSON.parse(readFileSync(join(dir, "project-immunity.json"), "utf8"));
    assert.deepEqual(raw.paths.rules, [{ action: "deny", kind: "file", path: "/Users/alican/repos" }]);
    assert.equal(ui.selectCalls.length, 2, "command decision first, then the suggestion dialog");
    assert.deepEqual(ui.selectCalls[0].options, ["Allow", "Deny"]);
    const lines = auditLines(dir);
    const rule = lines.find((l) => l.event === "rule");
    assert.equal(rule?.kind, "pathDeny");
    assert.equal(rule?.source, "suggestion");
    const decision = lines.find((l) => l.event === "decision");
    assert.equal(decision?.kind, "allow");
  });

  it("DENY with suggestions: denying the command skips the suggestions", async () => {
    const { env, ui } = makeEnv({
      llmClient: async () => ({
        ok: true,
        verdict: { risk: "high", outcome: "DENY", paths: { blocked: ["/Users/alican/repos"] } },
      }),
    });
    ui.selects.push("Deny", "Use immunity's reasoning");
    const r = await handleToolCall(bash("find ~/repos -maxdepth 1 -type d | wc -l"), env);
    assert.equal(r.allow, false);
    assert.ok(!ui.selectCalls.some((c) => c.title.includes("analyzer flagged")), "no suggestion dialogs after a Deny");
  });

  it("DENY with suggestions: allow the command, then skip the suggestions", async () => {
    const { env, ui } = makeEnv({
      llmClient: async () => ({
        ok: true,
        verdict: { risk: "high", outcome: "DENY", paths: { blocked: ["/Users/alican/repos"] } },
      }),
    });
    ui.selects.push("Allow", "Skip");
    const r = await handleToolCall(bash("find ~/repos -maxdepth 1 -type d | wc -l"), env);
    assert.deepEqual(r, { allow: true });
    assert.equal(ui.selectCalls.length, 2, "command decision first, suggestion dialog second");
    assert.deepEqual(ui.selectCalls[0].options, ["Allow", "Deny"], "whole-command menu is binary");
  });

  it("DENY with suggestions: allow the command, then allow a flagged path for the session", async () => {
    const { env, ui, dir } = makeEnv({
      llmClient: async () => ({
        ok: true,
        verdict: { risk: "high", outcome: "DENY", paths: { blocked: ["/Users/alican/repos"] } },
      }),
    });
    ui.selects.push("Allow", "Allow for session");
    const r = await handleToolCall(bash("find ~/repos -maxdepth 1 -type d | wc -l"), env);
    assert.deepEqual(r, { allow: true });
    assert.ok(env.session.isAllowed("file:/Users/alican/repos"));
    assert.ok(!env.session.isAllowed("bash:find ~/repos -maxdepth 1 -type d | wc -l"), "command is not memorized");
    const ses = auditLines(dir).filter((l) => l.event === "session");
    assert.equal(ses.length, 1, "only the path statement — the command was a one-shot allow");
    const decision = auditLines(dir).find((l) => l.event === "decision");
    assert.equal(decision?.kind, "allow");
    assert.equal(decision?.scope, "call");
  });

  it("inconclusive LLM + no rules + strict (default) → prompt; strict:false → allow", async () => {
    const inconclusive = { ok: false as const, kind: "timeout" as const, error: "no verdict" };
    const { env, ui } = makeEnv({ llmClient: async () => inconclusive });
    ui.selects.push("Allow");
    const r = await handleToolCall(bash("ls -la"), env);
    assert.deepEqual(r, { allow: true });

    const { env: env2, ui: ui2 } = makeEnv({ config: { strict: false }, llmClient: async () => inconclusive });
    const r2 = await handleToolCall(bash("ls -la"), env2);
    assert.deepEqual(r2, { allow: true });
    assert.equal(ui2.selectCalls.length, 0);
  });

  it("command ask rule (LLM off) — Deny blocks one-shot, no rule written", async () => {
    const { env, ui } = makeEnv({
      config: { llm: LLM_OFF },
      rules: { commands: { project: [{ action: "ask", exact: false, raw: "npm install" }] } },
    });
    ui.selects.push("Deny", "Use immunity's reasoning");
    const r = await handleToolCall(bash("npm install lodash"), env);
    assert.equal(r.allow, false);
    assert.match(r.reason, /Blocked by user/);
    assert.deepEqual(env.rules.commands.project.map((x) => x.raw), ["npm install"], "no commandDeny rule added");
  });
});

describe("handleToolCall — manual analysis retry", () => {
  const inconclusive: VerdictResult = { ok: false, kind: "timeout", error: "no verdict within 30000ms" };

  it("failed analysis → prompt offers Retry analysis; retry re-runs the analyzer", async () => {
    let calls = 0;
    const { env, ui } = makeEnv({
      llmClient: async () => (++calls === 1 ? inconclusive : verdict("none", "ALLOWED")),
    });
    ui.selects.push("Retry analysis");
    const r = await handleToolCall(bash("ls -la"), env);
    assert.deepEqual(r, { allow: true });
    assert.equal(calls, 2, "retry re-ran the analysis");
    assert.deepEqual(ui.selectCalls[0].options, ["Allow", "Deny", "Retry analysis"]);
  });

  it("a retried analysis that still fails prompts again with the option (uncapped, user-driven)", async () => {
    let calls = 0;
    const { env, ui } = makeEnv({ llmClient: async () => (++calls === 3 ? verdict("none", "ALLOWED") : inconclusive) });
    ui.selects.push("Retry analysis", "Retry analysis");
    const r = await handleToolCall(bash("ls -la"), env);
    assert.deepEqual(r, { allow: true });
    assert.equal(calls, 3);
    assert.equal(ui.selectCalls.length, 2, "one prompt per failed attempt");
  });

  it("deny after a failed analysis blocks without further attempts", async () => {
    let calls = 0;
    const { env, ui } = makeEnv({ llmClient: async () => (calls++, inconclusive) });
    ui.selects.push("Deny", "Use immunity's reasoning");
    const r = await handleToolCall(bash("ls -la"), env);
    assert.equal(r.allow, false);
    assert.equal(calls, 1);
  });

  it("no Retry analysis option when the model responded (DENY verdict)", async () => {
    const { env, ui } = makeEnv({ llmClient: async () => verdict("high", "DENY") });
    ui.selects.push("Allow");
    const r = await handleToolCall(bash("rm -rf x"), env);
    assert.deepEqual(r, { allow: true });
    assert.deepEqual(ui.selectCalls[0].options, ["Allow", "Deny"]);
  });

  it("no Retry analysis option when the LLM is disabled (deterministic prompt)", async () => {
    const { env, ui } = makeEnv({ config: { llm: LLM_OFF } });
    ui.selects.push("Allow");
    await handleToolCall(bash("ls -la"), env);
    assert.deepEqual(ui.selectCalls[0].options, ["Allow", "Deny"]);
    assert.ok(ui.selectCalls[0].title.includes("no LLM analysis available"), "reason notes the analysis absence");
  });

  it("every analysis attempt is audited (verdict trail) and the failed-kind reason surfaces", async () => {
    let calls = 0;
    const { env, ui, dir } = makeEnv({
      llmClient: async () => (++calls === 2 ? verdict("none", "ALLOWED") : inconclusive),
    });
    ui.selects.push("Retry analysis");
    await handleToolCall(bash("ls -la"), env);
    assert.ok(ui.selectCalls[0].title.includes("timeout"), "first prompt explains the failure kind");
    const verdicts = auditLines(dir).filter((l) => l.event === "verdict");
    assert.equal(verdicts.length, 2, "one verdict-trail line per attempt");
    assert.equal(verdicts[0].failure, "timeout: no verdict within 30000ms");
    assert.equal(verdicts[1].outcome, "ALLOWED");
  });
});

describe("handleToolCall — prestarted verdicts (sibling preflight)", () => {
  it("consumes the prestarted verdict on the first attempt without calling llmClient", async () => {
    let llmCalls = 0;
    const { env, dir } = makeEnv({ llmClient: async () => (llmCalls++, verdict("none", "ALLOWED")) });
    const r = await handleToolCall(bash("ls -la"), env, Promise.resolve(verdict("none", "ALLOWED")));
    assert.deepEqual(r, { allow: true });
    assert.equal(llmCalls, 0, "the prestarted verdict was used");
    const verdicts = auditLines(dir).filter((l) => l.event === "verdict");
    assert.equal(verdicts.length, 1);
    assert.equal(verdicts[0].outcome, "ALLOWED", "verdict trail still audited");
  });

  it("a manual retry after a prestarted failure re-analyzes via llmClient", async () => {
    let llmCalls = 0;
    const { env, ui } = makeEnv({ llmClient: async () => (llmCalls++, verdict("none", "ALLOWED")) });
    ui.selects.push("Retry analysis");
    const failed: VerdictResult = { ok: false, kind: "timeout", error: "no verdict within 30000ms" };
    const r = await handleToolCall(bash("ls -la"), env, Promise.resolve(failed));
    assert.deepEqual(r, { allow: true });
    assert.deepEqual(ui.selectCalls[0].options, ["Allow", "Deny", "Retry analysis"]);
    assert.equal(llmCalls, 1, "the retry ran a fresh analysis");
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
    ui.selects.push("Block for session", "Use immunity's reasoning");
    await handleToolCall(file("/etc/hosts"), env);
    assert.equal(seen?.command, "notify-send x");
    assert.equal(seen?.env.IMMUNITY_FEATURE, "file");
    assert.ok(seen?.env.IMMUNITY_PROMPT_ID);
    assert.ok(seen?.env.IMMUNITY_REASON);
  });
});

/** UI fake whose dialogs stay open until the test answers them. */
interface PendingSelect {
  title: string;
  options: string[];
  opts?: { signal?: AbortSignal };
  resolve: (value: string | undefined) => void;
}

class ControlledUi extends FakeUi {
  pending: PendingSelect[] = [];
  override select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined> {
    this.selectCalls.push({ title, options, opts });
    return new Promise<string | undefined>((resolve) => {
      const entry: PendingSelect = { title, options, opts, resolve };
      this.pending.push(entry);
      // pi dismisses dialogs when the signal aborts; mirror that here.
      opts?.signal?.addEventListener(
        "abort",
        () => {
          const index = this.pending.indexOf(entry);
          if (index >= 0) this.pending.splice(index, 1);
          resolve(undefined);
        },
        { once: true },
      );
    });
  }
  answer(value: string | undefined): void {
    const next = this.pending.shift();
    if (!next) throw new Error("no pending select");
    next.resolve(value);
  }
  /** Wait until a dialog is open, then return its title/options. */
  async nextSelect(): Promise<PendingSelect> {
    while (this.pending.length === 0) await new Promise((r) => setImmediate(r));
    return this.pending[0];
  }
}

const tick = () => new Promise((r) => setImmediate(r));

describe("handleToolCall — concurrent approval flows", () => {
  it("opens one dialog at a time and skips a stale dialog after a session grant", async () => {
    const approvals = new ApprovalQueue();
    const ui = new ControlledUi();
    const { env } = makeEnv({ config: { llm: LLM_OFF }, approvals, ui });

    const first = handleToolCall(file("/etc/hosts"), env);
    await ui.nextSelect();
    const second = handleToolCall(file("/etc/hosts"), env);
    while (approvals.pendingCount < 2) await tick();

    assert.equal(ui.pending.length, 1, "only one approval dialog is open");
    ui.answer("Allow for session");
    await ui.nextSelect(); // path-kind follow-up for the first flow
    ui.answer("Just this file");

    assert.deepEqual(await first, { allow: true });
    assert.deepEqual(await second, { allow: true });
    assert.equal(ui.selectCalls.length, 2, "the queued request rechecked and skipped its dialog");
  });

  it("rechecks a queued request against a newly granted session block", async () => {
    const approvals = new ApprovalQueue();
    const ui = new ControlledUi();
    const { env, dir } = makeEnv({ config: { llm: LLM_OFF }, approvals, ui });

    const first = handleToolCall(file("/etc/hosts"), env);
    await ui.nextSelect();
    const second = handleToolCall(file("/etc/hosts"), env);
    while (approvals.pendingCount < 2) await tick();

    ui.answer("Block for session");
    await ui.nextSelect(); // path-kind follow-up
    ui.answer("Just this file");
    await ui.nextSelect(); // reason ask
    ui.answer("Use immunity's reasoning");

    assert.equal((await first).allow, false);
    const secondResult = await second;
    assert.equal(secondResult.allow, false);
    assert.match(secondResult.allow === false ? secondResult.reason : "", /Blocked by session/);
    assert.equal(ui.selectCalls.length, 3, "the queued request rechecked and skipped its dialog");
    const blocks = auditLines(dir).filter((l) => l.event === "block");
    assert.equal(blocks.length, 2);
    assert.equal(blocks[1]?.source, "session");
  });

  it("queues a second command dialog instead of overlapping it", async () => {
    const ui = new ControlledUi();
    const { env } = makeEnv({
      llmClient: async () => verdict("high", "DENY"),
      ui,
    });
    const first = handleToolCall(bash("rm -rf a"), env);
    await ui.nextSelect();
    const second = handleToolCall(bash("rm -rf b"), env);
    await tick();

    assert.equal(ui.pending.length, 1, "the second command waits for the first dialog");
    ui.answer("Allow");
    await ui.nextSelect();
    assert.equal(ui.pending.length, 1);
    ui.answer("Allow");

    assert.deepEqual(await first, { allow: true });
    assert.deepEqual(await second, { allow: true });
    assert.equal(ui.selectCalls.length, 2);
  });
});

describe("handleToolCall — cancellation", () => {
  it("cancels an active dialog without auditing it as a user decision", async () => {
    const controller = new AbortController();
    const ui = new ControlledUi();
    const { env, dir } = makeEnv({ config: { llm: LLM_OFF }, signal: controller.signal, ui });

    const pending = handleToolCall(file("/etc/hosts"), env);
    await ui.nextSelect();
    assert.equal(ui.pending[0].opts?.signal, controller.signal, "the dialog receives the abort signal");
    controller.abort();

    assert.deepEqual(await pending, { allow: false, reason: CANCELLED_REASON });
    assert.deepEqual(auditLines(dir), [], "no user block, session statement, or rule audit");
    assert.equal(existsSync(join(dir, "project-immunity.json")), false);
    assert.equal(ui.pending.length, 0, "the active dialog was dismissed");
  });

  it("drops a queued flow when the session aborts before its turn", async () => {
    const approvals = new ApprovalQueue();
    const controller = new AbortController();
    const ui = new ControlledUi();
    const { env, dir } = makeEnv({
      config: { llm: LLM_OFF },
      approvals,
      ui,
      signal: controller.signal,
    });

    const first = handleToolCall(file("/etc/a"), env);
    await ui.nextSelect();
    const second = handleToolCall(file("/etc/b"), env);
    while (approvals.pendingCount < 2) await tick();

    controller.abort();
    assert.deepEqual(await second, { allow: false, reason: CANCELLED_REASON });
    assert.deepEqual(await first, { allow: false, reason: CANCELLED_REASON });
    assert.equal(ui.pending.length, 0, "no dialog was left open");
    assert.deepEqual(auditLines(dir), []);
  });

  it("does not persist a rule when the block-reason dialog is cancelled", async () => {
    const controller = new AbortController();
    const ui = new ControlledUi();
    const { env, dir } = makeEnv({ config: { llm: LLM_OFF }, signal: controller.signal, ui });

    const pending = handleToolCall(file("/etc/hosts"), env);
    await ui.nextSelect();
    ui.answer("Block for project");
    await ui.nextSelect(); // path-kind follow-up
    ui.answer("Just this file");
    await ui.nextSelect(); // reason ask
    controller.abort();

    assert.deepEqual(await pending, { allow: false, reason: CANCELLED_REASON });
    assert.equal(existsSync(join(dir, "project-immunity.json")), false, "no rule was persisted");
    assert.deepEqual(auditLines(dir), []);
  });

  it("blocks when the suggestion dialog is cancelled", async () => {
    const controller = new AbortController();
    const ui = new ControlledUi();
    const { env } = makeEnv({
      signal: controller.signal,
      ui,
      llmClient: async () => ({
        ok: true,
        verdict: { risk: "high", outcome: "DENY", paths: { blocked: ["/Users/alican/repos"] } },
      }),
    });

    const pending = handleToolCall(bash("find ~/repos -maxdepth 1 -type d | wc -l"), env);
    await ui.nextSelect(); // command decision
    ui.answer("Allow");
    await ui.nextSelect(); // flagged-path suggestion
    controller.abort();

    assert.deepEqual(await pending, { allow: false, reason: CANCELLED_REASON });
    assert.equal(ui.pending.length, 0, "the suggestion dialog was dismissed");
  });
});

describe("handleToolCall — session-wide analysis limit and status", () => {
  it("waits for a session limiter slot before analyzing", async () => {
    const limiter = new AnalysisLimiter(1);
    let release!: () => void;
    const blocker = limiter.schedule(
      () =>
        new Promise<VerdictResult>((resolve) => {
          release = () => resolve(verdict("none", "ALLOWED"));
        }),
    );
    let calls = 0;
    const { env } = makeEnv({
      limiter,
      llmClient: async () => {
        calls++;
        return verdict("none", "ALLOWED");
      },
    });

    const pending = handleToolCall(bash("ls -la"), env);
    await tick();
    assert.equal(calls, 0, "the analysis waits for the occupied session slot");

    release();
    assert.deepEqual(await pending, { allow: true });
    assert.equal(calls, 1);
    await blocker;
  });

  it("manual retries also wait for a session limiter slot", async () => {
    const limiter = new AnalysisLimiter(1);
    const ui = new ControlledUi();
    let calls = 0;
    const failed: VerdictResult = { ok: false, kind: "timeout", error: "no verdict within 30000ms" };
    const { env } = makeEnv({
      limiter,
      ui,
      llmClient: async () => (++calls === 1 ? failed : verdict("none", "ALLOWED")),
    });

    const pending = handleToolCall(bash("ls -la"), env);
    await ui.nextSelect(); // failed analysis → Retry analysis option
    assert.equal(calls, 1);

    let release!: () => void;
    const blocker = limiter.schedule(
      () =>
        new Promise<VerdictResult>((resolve) => {
          release = () => resolve(verdict("none", "ALLOWED"));
        }),
    );
    ui.answer("Retry analysis");
    await tick();
    assert.equal(calls, 1, "the retry waits for the occupied session slot");

    release();
    assert.deepEqual(await pending, { allow: true });
    assert.equal(calls, 2);
    await blocker;
  });

  it("shows the analysis status around each attempt and clears it", async () => {
    const writes: (string | null)[] = [];
    const { env } = makeEnv({ llmClient: async () => verdict("none", "ALLOWED") });
    env.setStatus = (label) => writes.push(label);
    await handleToolCall(bash("ls -la"), env);
    assert.deepEqual(writes, ["immunity: analyzing…", null]);
  });
});

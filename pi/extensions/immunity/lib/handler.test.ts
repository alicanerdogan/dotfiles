/**
 * Handler integration tests: the full tool-call flow — allow, notify,
 * prompt (allow once/session/always, deny, deny with reason), block —
 * with a fake UI/bus and a real audit file. Verifies events, grants,
 * audit entries and block reasons end-to-end.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { handleToolCall, toHomePath, type HandlerEnv } from "./handler.ts";
import { CompositeGrantStore, MemoryGrantStore } from "./grants.ts";
import { DEFAULT_CONFIG, type ImmunityConfig } from "./config.ts";
import { FakeBus, FakeUi } from "./testing.ts";
import type { ToolRequest } from "./pipeline.ts";

const HOME = "/home/u";
const CWD = "/repo";

/** every audit dir created by makeEnv, removed after the suite */
const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeEnv(partial: Partial<HandlerEnv> = {}): {
  ui: FakeUi;
  bus: FakeBus;
  grants: MemoryGrantStore;
  auditDir: string;
  env: HandlerEnv;
} {
  const ui = new FakeUi();
  const bus = new FakeBus();
  const grants = new MemoryGrantStore();
  const auditDir = mkdtempSync(join(import.meta.dirname, ".test-tmp-"));
  tempDirs.push(auditDir);
  const env: HandlerEnv = {
    config: DEFAULT_CONFIG,
    grants: new CompositeGrantStore([grants]),
    sessionGrants: grants,
    bus,
    sessionId: "sess-test",
    cwd: CWD,
    home: HOME,
    ui,
    auditFile: join(auditDir, "audit.jsonl"),
    ruleScope: join(auditDir, "immunity.json"),
    ...partial,
  };
  return { ui, bus, grants, auditDir, env };
}

const bash = (command: string): ToolRequest => ({ kind: "bash", command, cwd: CWD, home: HOME });
const file = (target: string, access: "read" | "modify" = "modify"): ToolRequest => ({
  kind: "file",
  tool: "edit",
  target,
  access,
  cwd: CWD,
  home: HOME,
});

function auditLines(dir: string): Record<string, unknown>[] {
  const p = join(dir, "audit.jsonl");
  try {
    return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

describe("allow path", () => {
  it("allows benign commands without prompting or auditing", async () => {
    const { ui, bus, auditDir, env } = makeEnv();
    const r = await handleToolCall(bash("ls -la"), env);
    assert.deepEqual(r, { allow: true });
    assert.equal(ui.selectCalls.length, 0);
    assert.equal(bus.events.length, 0);
    assert.deepEqual(auditLines(auditDir), []);
  });

  it("notifies (and allows) when requireConfirmation is off", async () => {
    const { ui, env } = makeEnv({
      config: {
        ...DEFAULT_CONFIG,
        prompting: { ...DEFAULT_CONFIG.prompting, requireConfirmation: false },
      },
    });
    const r = await handleToolCall(bash("rm -rf ~/tmp"), env);
    assert.deepEqual(r, { allow: true });
    assert.equal(ui.notifyCalls.length, 1);
    assert.ok(ui.notifyCalls[0].message.includes("rm -rf"));
  });

  it("warns on tree-sitter degradation but still allows benign calls", async () => {
    const { ui, env } = makeEnv({
      config: { ...DEFAULT_CONFIG, treeSitter: { binPath: "nope", grammarDir: null } },
    });
    const r = await handleToolCall(bash("ls -la"), env);
    assert.deepEqual(r, { allow: true });
    assert.ok(ui.notifyCalls.some((n) => n.message.includes("tree-sitter")));
  });
});

describe("block path", () => {
  it("blocks deterministic deny, audits it, and emits the blocked event", async () => {
    const { ui, bus, auditDir, env } = makeEnv();
    const r = await handleToolCall(bash("mkfs.ext4 /dev/sdb1"), env);
    assert.equal(r.allow, false);
    assert.ok(r.reason.startsWith("Blocked by policy:"));
    assert.equal(ui.selectCalls.length, 0, "no prompt for auto-denies");
    assert.equal(bus.events.length, 1);
    assert.equal(bus.events[0].channel, "immunity:action:blocked");
    const lines = auditLines(auditDir);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].source, "policy");
    assert.equal(lines[0].action, "mkfs.ext4 /dev/sdb1");
    assert.equal(lines[0].sessionId, "sess-test");
  });

  it("blocks autoDeny patterns with source autoDeny", async () => {
    const { bus, auditDir, env } = makeEnv({
      config: {
        ...DEFAULT_CONFIG,
        commands: { ...DEFAULT_CONFIG.commands, autoDenyPatterns: ["git push --force"] },
      },
    });
    const r = await handleToolCall(bash("git push --force"), env);
    assert.equal(r.allow, false);
    assert.ok(r.reason.startsWith("Blocked by autoDeny:"));
    const blocked = bus.events[0].data as { block: { source: string } };
    assert.equal(blocked.block.source, "autoDeny");
    assert.equal(auditLines(auditDir)[0].source, "autoDeny");
  });

  it("prompts on protected file writes and audits the block", async () => {
    const { ui, bus, auditDir, env } = makeEnv({
      config: {
        ...DEFAULT_CONFIG,
        pathnames: { protected: [{ pattern: "**/.env*", mode: "modify" }], allowed: [] },
      },
    });
    ui.selects.push("Deny");
    const r = await handleToolCall(file(".env"), env);
    assert.equal(r.allow, false);
    assert.equal(r.reason, "Blocked by user");
    const blocked = bus.events.find((e) => e.channel === "immunity:action:blocked")?.data as { action: string };
    assert.equal(blocked.action, "modify .env");
    assert.equal(auditLines(auditDir)[0].tool, "edit");
    assert.equal(auditLines(auditDir)[0].source, "user");
  });

  it("audit failures never crash the call", async () => {
    const { env } = makeEnv({ auditFile: null });
    const r = await handleToolCall(bash("mkfs.ext4 /dev/sdb1"), env);
    assert.equal(r.allow, false);
  });
});

describe("prompt flow", () => {
  it("allow once proceeds without a grant event", async () => {
    const { ui, bus, grants, env } = makeEnv();
    ui.selects.push("Allow once");
    const r = await handleToolCall(bash("rm -rf ~/tmp"), env);
    assert.deepEqual(r, { allow: true });
    assert.equal(grants.check("bash:rm -rf ~/tmp"), null);
    assert.ok(bus.events.some((e) => e.channel === "immunity:prompt:opened"));
    assert.ok(bus.events.some((e) => e.channel === "immunity:prompt:closed"));
    assert.equal(bus.events.some((e) => e.channel === "immunity:grant:created"), false);
  });

  it("allow for session records the grant and emits grant:created", async () => {
    const { ui, bus, grants, env } = makeEnv();
    ui.selects.push("Allow for session");
    const r = await handleToolCall(bash("rm -rf ~/tmp"), env);
    assert.deepEqual(r, { allow: true });
    assert.equal(grants.check("bash:rm -rf ~/tmp"), "session");
    assert.ok(bus.events.some((e) => e.channel === "immunity:grant:created"));
  });

  it("a session grant short-circuits the next identical call", async () => {
    const { ui, bus, grants, env } = makeEnv();
    ui.selects.push("Allow for session");
    await handleToolCall(bash("rm -rf ~/tmp"), env);
    ui.selectCalls.length = 0;
    bus.events.length = 0;
    const r = await handleToolCall(bash("rm -rf ~/tmp"), env);
    assert.deepEqual(r, { allow: true });
    assert.equal(ui.selectCalls.length, 0);
    assert.equal(bus.events.length, 0, "granted calls emit nothing");
  });

  it("always allow persists to commands.allowed and emits grant:created", async () => {
    const { ui, bus, env } = makeEnv();
    ui.selects.push("Always allow");
    const r = await handleToolCall(bash("rm -rf ~/tmp"), env);
    assert.deepEqual(r, { allow: true });
    const raw = JSON.parse(readFileSync(env.ruleScope, "utf8")) as { commands: { allowed: string[] } };
    assert.deepEqual(raw.commands.allowed, ["rm -rf ~/tmp"]);
    const grant = bus.events.find((e) => e.channel === "immunity:grant:created")?.data as {
      grant: { scope: string; persisted: boolean };
    };
    assert.equal(grant.grant.scope, "always");
    assert.equal(grant.grant.persisted, true);
  });

  it("deny blocks with source user and a plain block message", async () => {
    const { ui, bus, auditDir, env } = makeEnv();
    ui.selects.push("Deny");
    const r = await handleToolCall(bash("rm -rf ~/tmp"), env);
    assert.equal(r.allow, false);
    assert.equal(r.reason, "Blocked by user");
    const blocked = bus.events.find((e) => e.channel === "immunity:action:blocked")?.data as {
      block: { source: string };
    };
    assert.equal(blocked.block.source, "user");
    assert.equal(auditLines(auditDir)[0].source, "user");
  });

  it("deny with reason carries the reason into the block message and audit", async () => {
    const { ui, bus, auditDir, env } = makeEnv();
    ui.selects.push("Deny with reason");
    ui.inputs.push("I'll do it manually");
    const r = await handleToolCall(bash("rm -rf ~/tmp"), env);
    assert.equal(r.allow, false);
    assert.equal(r.reason, "Blocked by user: I'll do it manually");
    const line = auditLines(auditDir)[0];
    assert.equal(line.userReason, "I'll do it manually");
    assert.equal(line.source, "user");
  });

  it("deny with reason + remember-rule writes an autoDeny rule", async () => {
    const { ui, env } = makeEnv();
    ui.selects.push("Deny with reason", "Block this command pattern");
    ui.inputs.push("never again");
    const r = await handleToolCall(bash("rm -rf ~/tmp"), env);
    assert.equal(r.allow, false);
    const raw = JSON.parse(readFileSync(env.ruleScope, "utf8")) as { commands: { autoDenyPatterns: string[] } };
    assert.deepEqual(raw.commands.autoDenyPatterns, ["rm -rf ~/tmp"]);
  });

  it("prompt:closed fires even when the UI throws", async () => {
    const { ui, bus, env } = makeEnv();
    ui.failNext("select");
    const r = await handleToolCall(bash("rm -rf ~/tmp"), env);
    assert.equal(r.allow, false, "UI failure denies");
    assert.ok(bus.events.some((e) => e.channel === "immunity:prompt:closed"));
  });
});

describe("llm verdict trail", () => {
  it("records an ALLOWED verdict for benign commands when llm is on", async () => {
    const { auditDir, env } = makeEnv({
      config: { ...DEFAULT_CONFIG, llm: { ...DEFAULT_CONFIG.llm, enabled: true, provider: "opencode-go", model: "m" } },
      llmClient: async () => ({ ok: true, verdict: { risk: "none", outcome: "ALLOWED", reason: "benign" } }),
    });
    const r = await handleToolCall(bash("ls -la"), env);
    assert.deepEqual(r, { allow: true });
    const lines = auditLines(auditDir);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].event, "verdict");
    assert.equal(lines[0].action, "ls -la");
    assert.equal(lines[0].outcome, "ALLOWED");
    assert.equal(lines[0].reason, "benign");
    assert.equal(lines[0].llm.model, "m");
  });

  it("records DENY verdicts and the block entry when autoDeny blocks", async () => {
    const { auditDir, env } = makeEnv({
      config: {
        ...DEFAULT_CONFIG,
        llm: { ...DEFAULT_CONFIG.llm, enabled: true, autoDeny: true },
      },
      llmClient: async () => ({ ok: true, verdict: { risk: "high", outcome: "DENY", reason: "force push" } }),
    });
    const r = await handleToolCall(bash("git push --force"), env);
    assert.equal(r.allow, false);
    const lines = auditLines(auditDir);
    assert.equal(lines.length, 2);
    assert.ok(lines.some((l) => l.event === "verdict" && l.outcome === "DENY"));
    assert.ok(lines.some((l) => l.event === "block" && l.source === "llm"));
  });

  it("confirm mode: ALLOWED verdict prompts with the verdict; user allow → runs", async () => {
    const { ui, auditDir, env } = makeEnv({
      config: { ...DEFAULT_CONFIG, llm: { ...DEFAULT_CONFIG.llm, enabled: true, confirm: true } },
      llmClient: async () => ({ ok: true, verdict: { risk: "none", outcome: "ALLOWED", reason: "benign" } }),
    });
    ui.selects.push("Allow once");
    const r = await handleToolCall(bash("ls -la"), env);
    assert.deepEqual(r, { allow: true });
    assert.equal(ui.selectCalls.length, 1);
    assert.match(ui.selectCalls[0].title, /ALLOWED \(risk none\)/);
    const lines = auditLines(auditDir);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].event, "verdict");
    assert.equal(lines[0].outcome, "ALLOWED");
  });

  it("confirm mode: ALLOWED verdict prompts; user deny → block + audit", async () => {
    const { ui, auditDir, env } = makeEnv({
      config: { ...DEFAULT_CONFIG, llm: { ...DEFAULT_CONFIG.llm, enabled: true, confirm: true } },
      llmClient: async () => ({ ok: true, verdict: { risk: "none", outcome: "ALLOWED", reason: "benign" } }),
    });
    ui.selects.push("Deny");
    const r = await handleToolCall(bash("ls -la"), env);
    assert.equal(r.allow, false);
    const lines = auditLines(auditDir);
    assert.ok(lines.some((l) => l.event === "verdict" && l.outcome === "ALLOWED"));
    assert.ok(lines.some((l) => l.event === "block" && l.source === "user"));
  });

  it("outside-cwd file access prompts; user allow → runs, user deny → block", async () => {
    const { ui, auditDir, env } = makeEnv();
    ui.selects.push("Allow once");
    const allowed = await handleToolCall(file("~/keys/a.pem", "read"), env);
    assert.deepEqual(allowed, { allow: true });
    assert.equal(ui.selectCalls.length, 1);
    assert.match(ui.selectCalls[0].title, /outside project cwd/);
    assert.deepEqual(auditLines(auditDir), [], "allow leaves no audit entry");

    const { ui: ui2, auditDir: auditDir2, env: env2 } = makeEnv();
    ui2.selects.push("Deny");
    const denied = await handleToolCall(file("~/keys/a.pem", "read"), env2);
    assert.equal(denied.allow, false);
    const lines = auditLines(auditDir2);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].event, "block");
    assert.equal(lines[0].source, "user");
  });

  it("protect-path suggestion: writes the rule, blocks, audits rule + block", async () => {
    const saved: { kind: string; value: string; scope?: string }[] = [];
    const { ui, auditDir, env } = makeEnv({
      config: { ...DEFAULT_CONFIG, llm: { ...DEFAULT_CONFIG.llm, enabled: true } },
      llmClient: async () => ({
        ok: true,
        verdict: { risk: "high", outcome: "DENY", paths: { blocked: ["~/.ssh/id_rsa"] } },
      }),
      saveRule: async (kind, value, scope) => {
        saved.push({ kind, value, scope });
        return true;
      },
    });
    ui.selects.push("Protect ~/.ssh/id_rsa (project)");
    const r = await handleToolCall(bash("cat ~/.ssh/id_rsa"), env);
    assert.equal(r.allow, false);
    assert.deepEqual(saved, [{ kind: "path", value: "~/.ssh/id_rsa", scope: "project" }]);
    const lines = auditLines(auditDir);
    assert.ok(lines.some((l) => l.event === "rule" && l.kind === "path" && l.value === "~/.ssh/id_rsa" && l.scope === "project"));
    assert.ok(lines.some((l) => l.event === "block" && l.source === "user"));
    assert.ok(lines.some((l) => l.event === "verdict"));
  });

  it("block-command suggestion: writes an autoDeny pattern, blocks", async () => {
    const saved: { kind: string; value: string; scope?: string }[] = [];
    const { ui, env } = makeEnv({
      config: { ...DEFAULT_CONFIG, llm: { ...DEFAULT_CONFIG.llm, enabled: true } },
      llmClient: async () => ({
        ok: true,
        verdict: { risk: "high", outcome: "DENY", commands: { blocked: [{ raw: "git push --force", general: "git push" }] } },
      }),
      saveRule: async (kind, value, scope) => {
        saved.push({ kind, value, scope });
        return true;
      },
    });
    ui.selects.push("Block git push --force");
    const r = await handleToolCall(bash("git push --force"), env);
    assert.equal(r.allow, false);
    assert.deepEqual(saved, [{ kind: "autoDeny", value: "git push --force", scope: "project" }]);
  });

  it("allow-path suggestion: writes the rule, retries the pipeline, the LLM allows", async () => {
    let calls = 0;
    const saved: { kind: string; value: string; scope?: string }[] = [];
    const { ui, auditDir, env } = makeEnv({
      config: { ...DEFAULT_CONFIG, llm: { ...DEFAULT_CONFIG.llm, enabled: true } },
      llmClient: async () => {
        calls++;
        return calls === 1
          ? { ok: true, verdict: { risk: "high", outcome: "DENY", paths: { blocked: ["~/.ssh/id_rsa"] } } }
          : { ok: true, verdict: { risk: "none", outcome: "ALLOWED" } };
      },
      persistGrant: async (kind, value, scope) => {
        saved.push({ kind, value, scope });
        return true;
      },
    });
    ui.selects.push("Allow ~/.ssh/id_rsa (project)");
    const r = await handleToolCall(bash("cat ~/.ssh/id_rsa"), env);
    assert.deepEqual(r, { allow: true });
    assert.equal(calls, 2, "retry re-runs the analysis with the updated policy");
    assert.deepEqual(saved, [{ kind: "path", value: "~/.ssh/id_rsa", scope: "project" }]);
    const lines = auditLines(auditDir);
    assert.ok(lines.some((l) => l.event === "rule" && l.kind === "pathAllow" && l.scope === "project"));
    assert.equal(lines.filter((l) => l.event === "verdict").length, 2);
  });

  it("allow-path suggestion caps retries at 2, then honors the override", async () => {
    let calls = 0;
    const { ui, env } = makeEnv({
      config: { ...DEFAULT_CONFIG, llm: { ...DEFAULT_CONFIG.llm, enabled: true } },
      llmClient: async () => {
        calls++;
        return { ok: true, verdict: { risk: "high", outcome: "DENY", paths: { blocked: ["~/.ssh/id_rsa"] } } };
      },
      persistGrant: async () => true,
    });
    ui.selects.push("Allow ~/.ssh/id_rsa (project)", "Allow ~/.ssh/id_rsa (project)", "Allow ~/.ssh/id_rsa (project)");
    const r = await handleToolCall(bash("cat ~/.ssh/id_rsa"), env);
    assert.deepEqual(r, { allow: true });
    assert.equal(calls, 3, "two retries, then the user's explicit override wins");
  });

  it("glob-ish suggested paths are audit-only: no menu options, concrete ones render", async () => {
    const saved: { value: string; scope?: string }[] = [];
    let calls = 0;
    const { ui, env } = makeEnv({
      config: { ...DEFAULT_CONFIG, llm: { ...DEFAULT_CONFIG.llm, enabled: true } },
      llmClient: async () => {
        calls++;
        return calls === 1
          ? { ok: true, verdict: { risk: "high", outcome: "DENY", paths: { blocked: ["~/repos/*", "~/.ssh/id_rsa"] } } }
          : { ok: true, verdict: { risk: "none", outcome: "ALLOWED" } };
      },
      persistGrant: async (kind, value, scope) => {
        saved.push({ value, scope });
        return true;
      },
    });
    ui.selects.push("Allow ~/.ssh/id_rsa (project)");
    const r = await handleToolCall(bash("ls ~/.ssh/id_rsa"), env);
    assert.deepEqual(r, { allow: true });
    assert.deepEqual(saved, [{ value: "~/.ssh/id_rsa", scope: "project" }]);
    const labels = ui.selectCalls[0].options;
    assert.ok(labels.some((l) => l.includes("Allow ~/.ssh/id_rsa")), "concrete path renders");
    assert.ok(!labels.some((l) => l.includes("~/repos/*")), "glob suggestion never renders as an option");
  });

  it("records inconclusive failures in the verdict trail", async () => {
    const { auditDir, env } = makeEnv({
      config: { ...DEFAULT_CONFIG, llm: { ...DEFAULT_CONFIG.llm, enabled: true } },
      llmClient: async () => ({ ok: false, kind: "timeout", error: "slow model" }),
    });
    const r = await handleToolCall(bash("ls -la"), env);
    assert.equal(r.allow, false, "inconclusive prompts");
    const v = auditLines(auditDir).find((l) => l.event === "verdict");
    assert.equal(v?.failure, "timeout: slow model");
  });

  it("writes nothing when llm is off", async () => {
    const { auditDir, env } = makeEnv(); // DEFAULT_CONFIG: llm.enabled false
    await handleToolCall(bash("ls -la"), env);
    assert.deepEqual(auditLines(auditDir), []);
  });
});

describe("file prompts", () => {
  it("offers Protect this path and writes pathnames.protected", async () => {
    const { ui, env } = makeEnv({
      config: {
        ...DEFAULT_CONFIG,
        pathnames: { protected: [{ pattern: "**/.env*", mode: "modify" }], allowed: [] },
      },
    });
    ui.selects.push("Deny with reason", "Protect this path");
    ui.inputs.push("secrets");
    const r = await handleToolCall(file(".env"), env);
    assert.equal(r.allow, false);
    const raw = JSON.parse(readFileSync(env.ruleScope, "utf8")) as { pathnames: { protected: unknown[] } };
    assert.deepEqual(raw.pathnames.protected, [{ pattern: "/repo/.env", mode: "modify" }]);
  });

  it("always allow on a file persists a ~-relative path allow", async () => {
    const { ui, bus, env } = makeEnv({
      config: {
        ...DEFAULT_CONFIG,
        pathnames: { protected: [{ pattern: "**/.env*", mode: "modify" }], allowed: [] },
      },
    });
    ui.selects.push("Always allow");
    const r = await handleToolCall(file("~/secrets/.env", "modify"), env);
    assert.deepEqual(r, { allow: true });
    const raw = JSON.parse(readFileSync(env.ruleScope, "utf8")) as { pathnames: { allowed: unknown[] } };
    assert.deepEqual(raw.pathnames.allowed, [{ kind: "file", path: "~/secrets/.env" }]);
  });
});

describe("toHomePath", () => {
  it("rewrites home-relative targets for durable grants", () => {
    assert.equal(toHomePath("/home/u/keys/a.pem", "/home/u"), "~/keys/a.pem");
    assert.equal(toHomePath("/home/u", "/home/u"), "~");
    assert.equal(toHomePath("/repo/a", "/home/u"), "/repo/a");
    assert.equal(toHomePath("/home/others/x", "/home/u"), "/home/others/x", "sibling prefix not rewritten");
  });
});

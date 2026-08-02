/**
 * Pipeline tests: staged flow, short-circuiting, grant lookup, decision
 * mapping (deny > prompt > allow), LLM verdict routing, inconclusive
 * handling, degradation notify, mode-strict path gating.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runPipeline, grantKey, MemoryGrantStore, type PipelineOptions, type ToolRequest } from "./pipeline.ts";
import { DEFAULT_CONFIG, type ImmunityConfig } from "./config.ts";
import type { VerdictResult } from "./llm-client.ts";

const CWD = "/repo";
const HOME = "/home/u";

function opts(partial: Partial<PipelineOptions> = {}): PipelineOptions {
  return {
    rules: DEFAULT_CONFIG.commands,
    pathRules: DEFAULT_CONFIG.pathnames,
    llm: DEFAULT_CONFIG.llm,
    ts: DEFAULT_CONFIG.treeSitter,
    prompting: DEFAULT_CONFIG.prompting,
    ...partial,
  };
}

const bash = (command: string, extra: Partial<ToolRequest> = {}): ToolRequest => ({
  kind: "bash",
  command,
  cwd: CWD,
  home: HOME,
  ...extra,
});
const file = (target: string, access: "read" | "modify" = "modify"): ToolRequest => ({
  kind: "file",
  tool: "file",
  target,
  access,
  cwd: CWD,
  home: HOME,
});

describe("grant stage", () => {
  it("a matching grant short-circuits to allow", async () => {
    const grants = new MemoryGrantStore();
    grants.add("bash:ls -la", "session");
    const r = await runPipeline(bash("ls -la"), opts({ grants }));
    assert.equal(r.outcome.outcome, "allow");
    assert.equal(r.outcome.reason, "granted (session)");
    assert.deepEqual(r.stages.map((s) => s.stage), ["grant"]);
  });

  it("no grant falls through to the rules stage", async () => {
    const r = await runPipeline(bash("ls -la"), opts({ grants: new MemoryGrantStore() }));
    assert.equal(r.stages[0].stage, "grant");
    assert.equal((r.stages[0] as { grant: string | null }).grant, null);
    assert.equal(r.stages.length, 2);
  });

  it("bash grants are keyed on the raw command; file grants on resolved target + access", () => {
    assert.equal(grantKey(bash("rm -rf /x")), "bash:rm -rf /x");
    assert.equal(grantKey(file("~/keys/a.pem", "read")), "file:read:file:/home/u/keys/a.pem");
    assert.equal(grantKey(file("keys/a.pem", "modify")), "file:modify:file:/repo/keys/a.pem");
  });
});

describe("deterministic bash stage", () => {
  it("benign command with no rules allows", async () => {
    const r = await runPipeline(bash("ls -la"));
    assert.deepEqual(r.outcome, { outcome: "allow", reason: "no rule matched" });
    assert.equal(r.stages[1].stage, "rules");
  });

  it("autoDeny pattern blocks with source autoDeny", async () => {
    const r = await runPipeline(
      bash("git push --force"),
      opts({ rules: { ...DEFAULT_CONFIG.commands, autoDenyPatterns: ["git push --force"] } }),
    );
    assert.equal(r.outcome.outcome, "block");
    assert.equal(r.outcome.source, "autoDeny");
    assert.ok(r.outcome.reason.includes("git push --force"));
  });

  it("builtin deny blocks with source policy", async () => {
    const r = await runPipeline(bash("mkfs.ext4 /dev/sdb1"));
    assert.equal(r.outcome.outcome, "block");
    assert.equal(r.outcome.source, "policy");
    assert.ok(r.outcome.reason.includes("disk formatting"));
  });

  it("builtin prompt prompts with source policy", async () => {
    const r = await runPipeline(bash("rm -rf ~/tmp"));
    assert.equal(r.outcome.outcome, "prompt");
    assert.equal(r.outcome.source, "policy");
    assert.ok(r.outcome.reason.includes("rm -rf"));
  });

  it("prompt becomes notify when requireConfirmation is off", async () => {
    const r = await runPipeline(
      bash("rm -rf ~/tmp"),
      opts({ prompting: { requireConfirmation: false } }),
    );
    assert.equal(r.outcome.outcome, "notify");
  });

  it("deny beats prompt in a mixed command", async () => {
    const r = await runPipeline(
      bash("sudo rm -rf /bin"),
      opts({ rules: { ...DEFAULT_CONFIG.commands, autoDenyPatterns: ["rm -rf"] } }),
    );
    assert.equal(r.outcome.outcome, "block");
    assert.equal(r.outcome.source, "autoDeny");
  });

  it("records model source and degraded state in the trace", async () => {
    const r = await runPipeline(
      bash("ls -la"),
      opts({ ts: { binPath: "definitely-missing-ts-bin", grammarDir: null } }),
    );
    const stage = r.stages[1] as { stage: "rules"; modelSource: string; degraded: string | null };
    assert.equal(stage.modelSource, "words");
    assert.ok(stage.degraded);
  });

  it("notifies on degradation", async () => {
    const notices: string[] = [];
    await runPipeline(bash("ls -la"), opts({ ts: { binPath: "nope", grammarDir: null }, notify: (m) => notices.push(m) }));
    assert.equal(notices.length, 1);
    assert.ok(notices[0].includes("tree-sitter"));
  });
});

describe("deterministic file stage", () => {
  const protectedEnv = () => ({
    pathRules: {
      protected: [{ pattern: "**/.env*", mode: "modify" as const }],
      allowed: [] as { kind: "file"; path: string }[],
    },
  });

  it("a protected path prompts with source policy", async () => {
    const r = await runPipeline(file(".env"), opts(protectedEnv()));
    assert.equal(r.outcome.outcome, "prompt");
    assert.equal(r.outcome.source, "policy");
    assert.ok(r.outcome.reason.includes("**/.env*"));
  });

  it("is mode-strict: read rules do not gate modify access", async () => {
    const r = await runPipeline(
      file(".env", "read"),
      opts({ pathRules: { protected: [{ pattern: "**/.env*", mode: "read" }], allowed: [] } }),
    );
    assert.equal(r.outcome.outcome, "prompt");
    const r2 = await runPipeline(
      file(".env", "modify"),
      opts({ pathRules: { protected: [{ pattern: "**/.env*", mode: "read" }], allowed: [] } }),
    );
    assert.equal(r2.outcome.outcome, "allow");
  });

  it("an allow entry bypasses protection", async () => {
    const r = await runPipeline(
      file(".env"),
      opts({
        pathRules: {
          protected: [{ pattern: "**/.env*", mode: "modify" }],
          allowed: [{ kind: "file", path: "/repo/.env" }],
        },
      }),
    );
    assert.equal(r.outcome.outcome, "allow");
  });

  it("onlyIfExists rules do not fire for new files", async () => {
    const r = await runPipeline(
      file("/repo/new.env"),
      opts({ pathRules: { protected: [{ pattern: "**/.env", mode: "modify", onlyIfExists: true }], allowed: [] } }),
    );
    assert.equal(r.outcome.outcome, "allow", "creating a new .env is not gated");
  });
});

describe("llm stage", () => {
  const llmEnv = (partial: Partial<PipelineOptions["llm"]> = {}) => ({
    llm: { ...DEFAULT_CONFIG.llm, enabled: true, ...partial },
  });
  const fakeClient = (result: VerdictResult) => async (): Promise<VerdictResult> => result;

  it("supervises every bash command when enabled (grant → llm → rules)", async () => {
    let called = 0;
    const r = await runPipeline(
      bash("ls -la"),
      opts({ ...llmEnv(), llmClient: async () => (called++, { ok: true, verdict: { risk: "none", outcome: "ALLOWED" } }) }),
    );
    assert.equal(called, 1);
    assert.equal(r.outcome.outcome, "allow");
    assert.equal(r.stages[1].stage, "llm");
    assert.equal(r.stages[2].stage, "rules");
  });

  it("an LLM ALLOWED cannot override a rule deny (floor blocks)", async () => {
    let called = 0;
    const r = await runPipeline(
      bash("mkfs.ext4 /dev/sdb1"),
      opts({
        ...llmEnv(),
        llmClient: async () => (called++, { ok: true, verdict: { risk: "none", outcome: "ALLOWED" } }),
      }),
    );
    assert.equal(called, 1); // supervision still ran and was recorded
    assert.equal(r.outcome.outcome, "block");
    assert.equal(r.outcome.source, "policy");
    assert.equal(r.stages[2].stage, "rules");
    assert.equal(r.stages[2].verdict, "deny");
  });

  it("an LLM ALLOWED cannot override a rule prompt (floor prompts)", async () => {
    const r = await runPipeline(
      bash("rm -rf ./node_modules"),
      opts({ ...llmEnv(), llmClient: fakeClient({ ok: true, verdict: { risk: "none", outcome: "ALLOWED" } }) }),
    );
    assert.equal(r.outcome.outcome, "prompt");
    assert.equal(r.outcome.source, "policy");
  });

  it("autoDeny pattern blocks even when the LLM allowed", async () => {
    const r = await runPipeline(
      bash("git reset --hard HEAD"),
      opts({
        rules: { ...DEFAULT_CONFIG.commands, autoDenyPatterns: ["git reset --hard HEAD"] },
        ...llmEnv(),
        llmClient: fakeClient({ ok: true, verdict: { risk: "none", outcome: "ALLOWED" } }),
      }),
    );
    assert.equal(r.outcome.outcome, "block");
    assert.equal(r.outcome.source, "autoDeny");
  });

  it("does not run when disabled", async () => {
    const r = await runPipeline(bash("ls -la"), opts({ llm: DEFAULT_CONFIG.llm }));
    assert.equal(r.stages.length, 2);
    assert.equal(r.outcome.outcome, "allow");
  });

  it("skips the llm stage for file requests", async () => {
    const r = await runPipeline(file("notes.txt"), opts(llmEnv()));
    assert.equal(r.outcome.outcome, "allow");
    assert.equal(r.stages.length, 2);
  });

  it("ALLOWED → allow with the verdict reason", async () => {
    const r = await runPipeline(
      bash("ls -la"),
      opts({ ...llmEnv(), llmClient: fakeClient({ ok: true, verdict: { risk: "low", outcome: "ALLOWED", reason: "benign" } }) }),
    );
    assert.equal(r.outcome.outcome, "allow");
    assert.equal(r.outcome.reason, "benign");
  });

  it("ALLOWED + confirm → prompt showing the verdict (user decides)", async () => {
    const r = await runPipeline(
      bash("ls -la"),
      opts({
        ...llmEnv({ confirm: true }),
        llmClient: fakeClient({ ok: true, verdict: { risk: "low", outcome: "ALLOWED", reason: "benign" } }),
      }),
    );
    assert.equal(r.outcome.outcome, "prompt");
    assert.equal(r.outcome.source, "llm");
    assert.match(r.outcome.reason, /ALLOWED \(risk low\)/);
    assert.match(r.outcome.reason, /benign/);
  });

  it("DENY with autoDeny off → prompt (user decides)", async () => {
    const r = await runPipeline(
      bash("git push --force"),
      opts({
        ...llmEnv(),
        llmClient: fakeClient({ ok: true, verdict: { risk: "high", outcome: "DENY", reason: "force push" } }),
      }),
    );
    assert.equal(r.outcome.outcome, "prompt");
    assert.equal(r.outcome.source, "llm");
    assert.equal(r.outcome.reason, "force push");
  });

  it("DENY with autoDeny on → block source llm", async () => {
    const r = await runPipeline(
      bash("git push --force"),
      opts({
        ...llmEnv({ autoDeny: true }),
        llmClient: fakeClient({ ok: true, verdict: { risk: "high", outcome: "DENY", reason: "force push" } }),
      }),
    );
    assert.equal(r.outcome.outcome, "block");
    assert.equal(r.outcome.source, "llm");
  });

  it("ASK_USER → prompt even with autoDeny on", async () => {
    const r = await runPipeline(
      bash("rm old.log"),
      opts({
        ...llmEnv({ autoDeny: true }),
        llmClient: fakeClient({ ok: true, verdict: { risk: "low", outcome: "ASK_USER", reason: "unclear" } }),
      }),
    );
    assert.equal(r.outcome.outcome, "prompt");
    assert.equal(r.outcome.source, "llm");
  });

  it("client failure → prompt, never approval", async () => {
    const r = await runPipeline(
      bash("ls -la"),
      opts({
        ...llmEnv(),
        llmClient: async () => ({ ok: false as const, kind: "spawn" as const, error: "pi not found" }),
      }),
    );
    assert.equal(r.outcome.outcome, "prompt");
    assert.equal(r.outcome.source, "llm");
    assert.ok(r.outcome.reason.includes("inconclusive"));
  });

  it("records the verdict in the trace", async () => {
    const r = await runPipeline(
      bash("ls -la"),
      opts({
        ...llmEnv(),
        llmClient: fakeClient({ ok: true, verdict: { risk: "none", outcome: "ALLOWED" } }),
      }),
    );
    const stage = r.stages[1] as { stage: "llm"; verdict: { outcome: string } };
    assert.equal(stage.verdict.outcome, "ALLOWED");
  });
});

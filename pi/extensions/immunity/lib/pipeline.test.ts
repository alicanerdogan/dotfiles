import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatPolicy, runPipeline, type PipelineOptions, type ToolRequest } from "./pipeline.ts";
import { SessionState } from "./session.ts";
import type { CommandRule, LlmConfig, PathRule } from "./config.ts";
import type { VerdictResult } from "./llm-client.ts";

const HOME = "/home/u";
const CWD = "/repo";

const bash = (command: string): ToolRequest => ({ kind: "bash", command, cwd: CWD, home: HOME });
const file = (target: string, tool = "read"): ToolRequest => ({ kind: "file", tool, target, cwd: CWD, home: HOME });

const PR = (action: PathRule["action"], path: string, kind: PathRule["kind"] = "file"): PathRule => ({ action, kind, path });
const CR = (action: CommandRule["action"], raw: string, opts: Partial<CommandRule> = {}): CommandRule => ({ action, exact: false, raw, ...opts });

const LLM_OFF: LlmConfig = { disabled: true, provider: "", model: "", userPrompt: "", piPath: "", timeoutMs: 30_000 };

function opts(over: Partial<PipelineOptions> = {}): PipelineOptions {
  return {
    strict: true,
    paths: { project: [], global: [] },
    commands: { project: [], global: [] },
    promptWhen: "blocked",
    llm: LLM_OFF,
    gitIgnoreCheck: async () => false,
    ...over,
  };
}

function verdict(risk: "none" | "low" | "high", outcome: "ALLOWED" | "DENY" | "ASK_USER"): VerdictResult {
  return { ok: true, verdict: { risk, outcome } };
}

describe("session statements", () => {
  it("a session allow short-circuits: allow, no LLM call", async () => {
    const session = new SessionState();
    session.addAllow("bash:ls -la");
    let llmCalls = 0;
    const r = await runPipeline(
      bash("ls -la"),
      opts({ session, llmClient: async () => (llmCalls++, verdict("none", "ALLOWED")) }),
    );
    assert.deepEqual(r.outcome, { outcome: "allow", reason: "allowed for session" });
    assert.equal(llmCalls, 0);
    assert.deepEqual(r.stages[0], { stage: "session", denied: false, allowed: true });
  });

  it("a session deny blocks silently, no LLM call", async () => {
    const session = new SessionState();
    session.addDeny("bash:rm -rf /");
    let llmCalls = 0;
    const r = await runPipeline(
      bash("rm -rf /"),
      opts({ session, llmClient: async () => (llmCalls++, verdict("none", "ALLOWED")) }),
    );
    assert.deepEqual(r.outcome, { outcome: "block", reason: "blocked for session", source: "session" });
    assert.equal(llmCalls, 0);
  });
});

describe("files — deterministic only", () => {
  it("inside cwd, not ignored, no rules → allow", async () => {
    const r = await runPipeline(file("./a.ts"), opts());
    assert.deepEqual(r.outcome, { outcome: "allow", reason: "in project cwd" });
  });

  it("ask rule → prompt", async () => {
    const r = await runPipeline(file("./.env"), opts({ paths: { project: [PR("ask", "./.env")], global: [] } }));
    assert.equal(r.outcome.outcome, "prompt");
    assert.equal(r.outcome.source, "policy");
    assert.match(r.outcome.reason, /path requires permission: \.\/\.env \(project\)/);
  });

  it("deny rule → prompt (blocked requests are prompted)", async () => {
    const r = await runPipeline(file("./x"), opts({ paths: { project: [PR("deny", "./x")], global: [] } }));
    assert.equal(r.outcome.outcome, "prompt");
    assert.match(r.outcome.reason, /path denied by rule: \.\/x \(project\)/);
  });

  it("outside cwd → prompt (default)", async () => {
    const r = await runPipeline(file("/etc/hosts"), opts());
    assert.equal(r.outcome.outcome, "prompt");
    assert.equal(r.outcome.source, "default");
    assert.match(r.outcome.reason, /outside project cwd/);
  });

  it("gitignored → prompt (default)", async () => {
    const r = await runPipeline(file("./dist/x.js"), opts({ gitIgnoreCheck: async () => true }));
    assert.equal(r.outcome.outcome, "prompt");
    assert.match(r.outcome.reason, /gitignored file/);
  });

  it("project allow overrides global deny", async () => {
    const r = await runPipeline(
      file("./x"),
      opts({ paths: { project: [PR("allow", "./x")], global: [PR("deny", "./x")] } }),
    );
    assert.deepEqual(r.outcome, { outcome: "allow", reason: "allowed by rule: ./x" });
  });

  it("no LLM stage for files even when enabled", async () => {
    const r = await runPipeline(
      file("./a.ts"),
      opts({ llm: { ...LLM_OFF, disabled: false }, llmClient: async () => verdict("none", "ALLOWED") }),
    );
    assert.ok(!r.stages.some((s) => s.stage === "llm"));
  });
});

describe("commands — LLM verdicts × promptWhen", () => {
  const llm = (res: VerdictResult) => ({ llm: { ...LLM_OFF, disabled: false }, llmClient: async () => res });

  it("ALLOWED → allow; everytime → prompt", async () => {
    const r = await runPipeline(bash("ls -la"), opts(llm(verdict("none", "ALLOWED"))));
    assert.equal(r.outcome.outcome, "allow");
    const r2 = await runPipeline(bash("ls -la"), opts({ ...llm(verdict("none", "ALLOWED")), promptWhen: "everytime" }));
    assert.equal(r2.outcome.outcome, "prompt");
    assert.equal(r2.outcome.source, "llm");
    assert.match(r2.outcome.reason, /LLM verdict: ALLOWED/);
  });

  it("DENY + promptWhen=asked → silent block; blocked → prompt", async () => {
    const r = await runPipeline(bash("rm -rf x"), opts({ ...llm(verdict("high", "DENY")), promptWhen: "asked" }));
    assert.deepEqual(r.outcome, { outcome: "block", reason: "LLM: deny", source: "llm" });
    const r2 = await runPipeline(bash("rm -rf x"), opts(llm(verdict("high", "DENY"))));
    assert.equal(r2.outcome.outcome, "prompt");
    assert.equal(r2.outcome.source, "llm");
  });

  it("ASK_USER → prompt", async () => {
    const r = await runPipeline(bash("npm install"), opts(llm(verdict("low", "ASK_USER"))));
    assert.equal(r.outcome.outcome, "prompt");
    assert.equal(r.outcome.source, "llm");
  });

  it("DENY verdicts carry the flagged paths into the prompt outcome", async () => {
    const r = await runPipeline(
      bash("find ~/repos | wc -l"),
      opts({
        llm: { ...LLM_OFF, disabled: false },
        llmClient: async () => ({
          ok: true,
          verdict: { risk: "high", outcome: "DENY", reason: "outside cwd", paths: { blocked: ["/Users/alican/repos"] } },
        }),
      }),
    );
    assert.equal(r.outcome.outcome, "prompt");
    assert.deepEqual(r.outcome.suggestions?.paths, ["/Users/alican/repos"]);
  });

  it("ALLOWED verdicts carry no suggestions", async () => {
    const r = await runPipeline(
      bash("ls -la"),
      opts({
        llm: { ...LLM_OFF, disabled: false },
        llmClient: async () => ({
          ok: true,
          verdict: { risk: "none", outcome: "ALLOWED", paths: { blocked: ["/x"] } },
        }),
      }),
    );
    assert.equal(r.outcome.outcome, "allow");
    assert.equal(r.outcome.suggestions, undefined);
  });

  it("LLM verdicts carry the policy feed", async () => {
    let seen: string | undefined;
    await runPipeline(
      bash("ls -la"),
      opts({
        paths: { project: [PR("allow", "~/repos", "directory")], global: [] },
        commands: { project: [CR("ask", "npm install")], global: [] },
        llm: { ...LLM_OFF, disabled: false },
        llmClient: async (_c, o) => {
          seen = o.policy;
          return verdict("none", "ALLOWED");
        },
      }),
    );
    assert.ok(seen?.includes("allow directory ~/repos"), "path rules in feed");
    assert.ok(seen?.includes("ask npm install"), "command rules in feed");
  });
});

describe("commands — deterministic fallback", () => {
  it("LLM disabled + allow rule → allow", async () => {
    const r = await runPipeline(bash("npm install lodash"), opts({ commands: { project: [CR("allow", "npm install")], global: [] } }));
    assert.equal(r.outcome.outcome, "allow");
  });

  it("deny rule → block when promptWhen=asked, prompt otherwise", async () => {
    const r = await runPipeline(
      bash("git push --force"),
      opts({ commands: { project: [CR("deny", "git push --force", { exact: true })], global: [] }, promptWhen: "asked" }),
    );
    assert.deepEqual(r.outcome, { outcome: "block", reason: "command rule: deny git push --force", source: "policy" });
    const r2 = await runPipeline(
      bash("git push --force"),
      opts({ commands: { project: [CR("deny", "git push --force", { exact: true })], global: [] } }),
    );
    assert.equal(r2.outcome.outcome, "prompt");
  });

  it("ask rule → prompt", async () => {
    const r = await runPipeline(bash("npm install lodash"), opts({ commands: { project: [CR("ask", "npm install")], global: [] } }));
    assert.equal(r.outcome.outcome, "prompt");
  });

  it("project rule beats global rule in the fallback", async () => {
    const r = await runPipeline(
      bash("npm install lodash"),
      opts({ commands: { project: [CR("allow", "npm install")], global: [CR("deny", "npm install")] } }),
    );
    assert.equal(r.outcome.outcome, "allow");
  });

  it("inconclusive LLM → fallback; no match → strict (prompt) or non-strict (allow)", async () => {
    const inconclusive = { ok: false as const, kind: "timeout" as const, error: "no verdict" };
    const r = await runPipeline(bash("ls -la"), opts({ llm: { ...LLM_OFF, disabled: false }, llmClient: async () => inconclusive }));
    assert.equal(r.outcome.outcome, "prompt");
    assert.equal(r.outcome.source, "default");
    assert.match(r.outcome.reason, /no rule matched/);

    const r2 = await runPipeline(bash("ls -la"), opts({ strict: false, llm: { ...LLM_OFF, disabled: false }, llmClient: async () => inconclusive }));
    assert.deepEqual(r2.outcome, { outcome: "allow", reason: "no rule matched" });
  });
});

describe("formatPolicy", () => {
  it("lists project rules first with scope labels; regex and empty sections omitted", () => {
    const p = formatPolicy(
      { project: [PR("allow", "~/repos", "directory")], global: [PR("deny", "~/.ssh", "directory")] },
      { project: [CR("ask", "npm install")], global: [CR("deny", "git push --force", { exact: true, regex: "^git push" })] },
    );
    assert.equal(
      p,
      "project rules (higher priority): paths [allow directory ~/repos]; commands [ask npm install] | global rules: paths [deny directory ~/.ssh]; commands [deny (exact) git push --force]",
    );
    assert.ok(!p.includes("regex"), "regex never leaves the config");
  });

  it("empty policy", () => {
    assert.equal(formatPolicy({ project: [], global: [] }, { project: [], global: [] }), "");
  });
});

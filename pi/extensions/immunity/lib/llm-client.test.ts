/**
 * Unit tests for the LLM verdict client — no real subprocess, no model
 * calls. A fake spawn captures argv and feeds fixture JSONL through a
 * PassThrough stdout.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  requestVerdict,
  buildArgs,
  defaultAnalysisToolPath,
  DEFAULT_SYSTEM_PROMPT,
  type SpawnFn,
  type VerdictChild,
} from "./llm-client.ts";

function fakeChild() {
  const emitter = new EventEmitter();
  const child: VerdictChild & { killed: string[] } = {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    killed: [],
    kill(sig = "SIGTERM") {
      child.killed.push(sig);
      return true;
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      emitter.on(event, listener);
      return child;
    },
  };
  return {
    child,
    spawnFn: ((_cmd: string, _args: string[], _opts: unknown) => child) as SpawnFn,
    emitError(err: Error) {
      emitter.emit("error", err);
    },
    emitClose() {
      child.exitCode = 0;
      emitter.emit("close");
    },
  };
}

function recordSpawn() {
  let cmd: string | undefined;
  let args: string[] | undefined;
  const f = fakeChild();
  const spawnFn: SpawnFn = (c, a, _opts) => {
    cmd = c;
    args = a;
    return f.child;
  };
  return { ...f, spawnFn, cmd: () => cmd, args: () => args };
}

const VERDICT_TEXT = (v: unknown) => JSON.stringify(v);
const START = (id: string) =>
  JSON.stringify({ type: "tool_execution_start", toolCallId: id, toolName: "immunity_verdict", args: {} });
const END = (id: string, text: string) =>
  JSON.stringify({
    type: "tool_execution_end",
    toolCallId: id,
    toolName: "immunity_verdict",
    result: { content: [{ type: "text", text }], details: {} },
    isError: false,
  });

describe("buildArgs — verified subprocess invocation", () => {
  it("defaults to the exact spike-verified flag set", () => {
    assert.deepEqual(buildArgs("ls -la"), [
      "--mode", "json",
      "--no-extensions",
      "--no-session",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--extension", defaultAnalysisToolPath(),
      "--tools", "immunity_verdict",
      "--system-prompt", DEFAULT_SYSTEM_PROMPT,
      "ls -la",
    ]);
  });

  it("appends the project cwd to the analysis message when provided", () => {
    const args = buildArgs("cat ../x", { cwd: "/repo" });
    assert.equal(args[args.length - 1], "Command: cat ../x\nProject cwd: /repo");
    assert.equal(buildArgs("ls -la").at(-1), "ls -la", "no cwd → message stays the bare command");
  });

  it("appends the policy line when provided", () => {
    const args = buildArgs("cat .env", {
      cwd: "/repo",
      policy: "project rules (higher priority): paths [ask file ./.env]; global rules: commands [deny (exact) git push --force]",
    });
    assert.equal(
      args[args.length - 1],
      "Command: cat .env\nProject cwd: /repo\nPolicy: project rules (higher priority): paths [ask file ./.env]; global rules: commands [deny (exact) git push --force]",
    );
    assert.equal(buildArgs("ls -la", { cwd: "/repo" }).at(-1), "Command: ls -la\nProject cwd: /repo", "no policy → no line");
  });

  it("inserts provider/model/userPrompt before --system-prompt", () => {
    const args = buildArgs("git status", {
      provider: "openai",
      model: "gpt-4o",
      userPrompt: "extra instructions",
      systemPrompt: "persona",
    });
    const idx = (flag: string) => args.indexOf(flag);
    assert.ok(idx("--provider") < idx("--model") && idx("--model") < idx("--append-system-prompt"));
    assert.ok(idx("--append-system-prompt") < idx("--system-prompt"));
    assert.equal(args[idx("--provider") + 1], "openai");
    assert.equal(args[idx("--model") + 1], "gpt-4o");
    assert.equal(args[idx("--append-system-prompt") + 1], "extra instructions");
    assert.equal(args[idx("--system-prompt") + 1], "persona");
    assert.equal(args.at(-1), "git status");
  });

  it("omits optional flags when not provided", () => {
    const args = buildArgs("x");
    assert.ok(!args.includes("--provider"));
    assert.ok(!args.includes("--model"));
    assert.ok(!args.includes("--append-system-prompt"));
  });
});

describe("defaultAnalysisToolPath", () => {
  it("resolves to the subprocess tool, absolute", () => {
    const p = defaultAnalysisToolPath();
    assert.ok(p.startsWith("/"), p);
    assert.ok(p.endsWith("/subprocess/analysis-tool.ts"), p);
  });
});

describe("requestVerdict — happy path", () => {
  it("spawns `pi` with the verified args and resolves the verdict", async () => {
    const r = recordSpawn();
    const p = requestVerdict("ls -la", { spawn: r.spawnFn, timeoutMs: 10_000 });
    assert.equal(r.cmd(), "pi");
    assert.deepEqual(r.args(), buildArgs("ls -la"));

    r.child.stdout.write(START("c1") + "\n");
    r.child.stdout.write(JSON.stringify({ type: "message_update", ignored: true }) + "\n");
    r.child.stdout.write(END("c1", VERDICT_TEXT({ risk: "low", outcome: "ASK_USER", reason: "destructive" })) + "\n");

    const res = await p;
    assert.deepEqual(res, { ok: true, verdict: { risk: "low", outcome: "ASK_USER", reason: "destructive" } });
    assert.deepEqual(r.child.killed, ["SIGKILL"], "child is killed once the verdict is in");
  });

  it("treats an empty piPath as unset (config default) — regression: spawn(\"\") crash", async () => {
    const r = recordSpawn();
    const p = requestVerdict("ls -la", { spawn: r.spawnFn, piPath: "", timeoutMs: 10_000 });
    assert.equal(r.cmd(), "pi", "empty piPath falls back to `pi` on PATH");
    r.child.stdout.write(START("c1") + "\n");
    r.child.stdout.write(END("c1", VERDICT_TEXT({ risk: "none", outcome: "ALLOWED" })) + "\n");
    const res = await p;
    assert.equal(res.ok, true);
  });

  it("treats a whitespace piPath as unset too", async () => {
    const r = recordSpawn();
    void requestVerdict("ls", { spawn: r.spawnFn, piPath: "   ", timeoutMs: 10_000 });
    assert.equal(r.cmd(), "pi");
  });

  it("accepts a verdict without a reason and honours piPath/provider", async () => {
    const r = recordSpawn();
    const p = requestVerdict("rm -rf /x", {
      spawn: r.spawnFn,
      piPath: "/custom/pi",
      provider: "google",
      timeoutMs: 10_000,
    });
    assert.equal(r.cmd(), "/custom/pi");
    r.child.stdout.write(START("c1") + "\n");
    r.child.stdout.write(END("c1", VERDICT_TEXT({ risk: "high", outcome: "DENY" })) + "\n");
    const res = await p;
    assert.deepEqual(res, { ok: true, verdict: { risk: "high", outcome: "DENY" } });
  });
});

describe("requestVerdict — inconclusive paths", () => {
  it("passes through valid suggestions (paths + commands)", async () => {
    const r = fakeChild();
    const p = requestVerdict("x", { spawn: r.spawnFn, timeoutMs: 10_000 });
    r.child.stdout.write(START("c1") + "\n");
    r.child.stdout.write(
      END("c1", VERDICT_TEXT({ risk: "high", outcome: "DENY", paths: { blocked: ["~/.ssh/id_rsa"] }, commands: { blocked: [{ raw: "git push --force", general: "git push" }] } })) + "\n",
    );
    const res = await p;
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.deepEqual(res.verdict.paths, { blocked: ["~/.ssh/id_rsa"] });
      assert.deepEqual(res.verdict.commands, { blocked: [{ raw: "git push --force", general: "git push" }] });
    }
  });

  it("rejects malformed suggestions", async () => {
    for (const bad of [
      { paths: { blocked: [42] } },
      { paths: { blocked: "nope" } },
      { commands: { blocked: [{ general: "git push" }] } },
      { commands: { blocked: "nope" } },
    ]) {
      const r = fakeChild();
      const p = requestVerdict("x", { spawn: r.spawnFn, timeoutMs: 10_000 });
      r.child.stdout.write(START("c1") + "\n");
      r.child.stdout.write(END("c1", VERDICT_TEXT({ risk: "high", outcome: "DENY", ...bad })) + "\n");
      const res = await p;
      assert.equal(res.ok, false, `expected parse failure for ${JSON.stringify(bad)}`);
      if (!res.ok) assert.equal(res.kind, "parse");
    }
  });

  it("rejects a verdict with an invalid risk", async () => {
    const r = fakeChild();
    const p = requestVerdict("x", { spawn: r.spawnFn, timeoutMs: 10_000 });
    r.child.stdout.write(START("c1") + "\n");
    r.child.stdout.write(END("c1", VERDICT_TEXT({ risk: "extreme", outcome: "ALLOWED" })) + "\n");
    const res = await p;
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.kind, "parse");
      assert.match(res.error, /invalid risk/);
    }
  });

  it("rejects a verdict with an invalid outcome", async () => {
    const r = fakeChild();
    const p = requestVerdict("x", { spawn: r.spawnFn, timeoutMs: 10_000 });
    r.child.stdout.write(START("c1") + "\n");
    r.child.stdout.write(END("c1", VERDICT_TEXT({ risk: "low", outcome: "MAYBE" })) + "\n");
    const res = await p;
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.kind, "parse");
  });

  it("rejects non-JSON verdict text", async () => {
    const r = fakeChild();
    const p = requestVerdict("x", { spawn: r.spawnFn, timeoutMs: 10_000 });
    r.child.stdout.write(START("c1") + "\n");
    r.child.stdout.write(END("c1", "the answer is 42") + "\n");
    const res = await p;
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.kind, "parse");
      assert.match(res.error, /not JSON/);
    }
  });

  it("rejects a result without text content", async () => {
    const r = fakeChild();
    const p = requestVerdict("x", { spawn: r.spawnFn, timeoutMs: 10_000 });
    r.child.stdout.write(START("c1") + "\n");
    r.child.stdout.write(JSON.stringify({ type: "tool_execution_end", toolCallId: "c1", toolName: "immunity_verdict", result: { content: [] } }) + "\n");
    const res = await p;
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.kind, "parse");
  });

  it("rejects a verdict whose reason is not a string", async () => {
    const r = fakeChild();
    const p = requestVerdict("x", { spawn: r.spawnFn, timeoutMs: 10_000 });
    r.child.stdout.write(START("c1") + "\n");
    r.child.stdout.write(END("c1", VERDICT_TEXT({ risk: "low", outcome: "ALLOWED", reason: 42 })) + "\n");
    const res = await p;
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /reason/);
  });

  it("fails on tool call id mismatch (start c1, end c2)", async () => {
    const r = fakeChild();
    const p = requestVerdict("x", { spawn: r.spawnFn, timeoutMs: 10_000 });
    r.child.stdout.write(START("c1") + "\n");
    r.child.stdout.write(END("c2", VERDICT_TEXT({ risk: "low", outcome: "ALLOWED" })) + "\n");
    const res = await p;
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.kind, "parse");
      assert.match(res.error, /mismatch/);
    }
  });

  it("reports no-verdict when the stream ends without a verdict", async () => {
    const r = fakeChild();
    const p = requestVerdict("x", { spawn: r.spawnFn, timeoutMs: 10_000 });
    r.child.stdout.write(JSON.stringify({ type: "turn_end" }) + "\n");
    r.emitClose();
    const res = await p;
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.kind, "no-verdict");
      assert.match(res.error, /without a verdict/);
    }
  });

  it("includes stderr in the no-verdict error", async () => {
    const r = fakeChild();
    const p = requestVerdict("x", { spawn: r.spawnFn, timeoutMs: 10_000 });
    r.child.stderr.write("model provider misconfigured\n");
    r.emitClose();
    const res = await p;
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /model provider misconfigured/);
  });

  it("times out and SIGKILLs the child", async () => {
    const r = fakeChild();
    const p = requestVerdict("x", { spawn: r.spawnFn, timeoutMs: 20 });
    const res = await p;
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.kind, "timeout");
      assert.match(res.error, /20ms/);
    }
    assert.deepEqual(r.child.killed, ["SIGKILL"]);
  });

  it("fails on spawn error", async () => {
    const r = fakeChild();
    const p = requestVerdict("x", { spawn: r.spawnFn, timeoutMs: 10_000 });
    r.emitError(new Error("ENOENT: no such file"));
    const res = await p;
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.kind, "spawn");
      assert.match(res.error, /failed to spawn/);
    }
  });

  it("fails when the event stream exceeds the output cap", async () => {
    const r = fakeChild();
    const p = requestVerdict("x", { spawn: r.spawnFn, timeoutMs: 10_000 });
    const chunk = Buffer.alloc(600_000, "a"); // no newlines — accumulates in the pending buffer
    r.child.stdout.write(chunk);
    r.child.stdout.write(chunk);
    const res = await p;
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.kind, "output");
  });
});

describe("requestVerdict — abort signal", () => {
  it("aborts mid-flight like a timeout", async () => {
    const ac = new AbortController();
    const r = fakeChild();
    const p = requestVerdict("x", { spawn: r.spawnFn, signal: ac.signal, timeoutMs: 10_000 });
    setTimeout(() => ac.abort(), 5);
    const res = await p;
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.kind, "timeout");
      assert.equal(res.error, "analysis aborted");
    }
    assert.deepEqual(r.child.killed, ["SIGKILL"]);
  });

  it("handles a pre-aborted signal immediately", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = fakeChild();
    const res = await requestVerdict("x", { spawn: r.spawnFn, signal: ac.signal, timeoutMs: 10_000 });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.kind, "timeout");
  });
});

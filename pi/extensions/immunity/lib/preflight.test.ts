import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bashSiblings, startSiblingVerdicts } from "./preflight.ts";
import { SessionState } from "./session.ts";
import type { LlmConfig } from "./config.ts";
import type { VerdictOptions, VerdictResult } from "./llm-client.ts";

const HOME = "/home/u";
const CWD = "/repo";
const LLM: LlmConfig = { disabled: false, provider: "p", model: "m", userPrompt: "up", piPath: "pi", timeoutMs: 1000, maxParallel: 8 };

/** minimal AgentMessage-shaped assistant message (structural — the real type is pi's) */
function assistant(toolCalls: { id: string; name: string; command?: string }[]) {
  return {
    role: "assistant",
    content: toolCalls.map((t) => ({ type: "toolCall", id: t.id, name: t.name, arguments: { command: t.command } })),
  };
}

const verdict = (): VerdictResult => ({ ok: true, verdict: { risk: "none", outcome: "ALLOWED" } });

function fakeRequest(calls: { command: string; opts: VerdictOptions }[]) {
  return (command: string, opts: VerdictOptions) => {
    calls.push({ command, opts });
    return Promise.resolve(verdict());
  };
}

describe("bashSiblings", () => {
  const msg = [
    assistant([
      { id: "a", name: "bash", command: "ls" },
      { id: "b", name: "grep" },
      { id: "c", name: "bash", command: "" },
      { id: "d", name: "bash", command: "rm -rf /" },
    ]),
  ];

  it("collects the bash siblings of the current call, skipping non-bash and empty commands", () => {
    assert.deepEqual(bashSiblings(msg, "a"), [
      { id: "a", command: "ls" },
      { id: "d", command: "rm -rf /" },
    ]);
  });

  it("returns null when the call is not in the last assistant message", () => {
    assert.equal(bashSiblings(msg, "zz"), null);
    assert.equal(bashSiblings([], "a"), null);
  });

  it("only looks at the last assistant message", () => {
    assert.equal(bashSiblings([...msg, assistant([{ id: "z", name: "bash", command: "pwd" }])], "a"), null);
  });
});

describe("startSiblingVerdicts", () => {
  it("starts a verdict per non-session sibling and returns the current call's", async () => {
    const calls: { command: string; opts: VerdictOptions }[] = [];
    const batch = new Map<string, Promise<VerdictResult> | null>();
    const p = startSiblingVerdicts(
      [
        { id: "a", command: "ls" },
        { id: "b", command: "git status" },
      ],
      "a",
      { cwd: CWD, home: HOME, llm: LLM, policy: "POL", maxParallel: 8, request: fakeRequest(calls) },
      batch,
    );
    assert.equal(batch.size, 2);
    const res = await p!;
    assert.equal(res.ok, true);
    assert.deepEqual(calls.map((c) => c.command), ["ls", "git status"]);
    assert.equal(calls[0].opts.policy, "POL");
    assert.equal(calls[0].opts.cwd, CWD);
    assert.equal(calls[0].opts.timeoutMs, 1000);
    assert.equal(calls[0].opts.provider, "p");
  });

  it("marks session-resolved siblings as null without an LLM call", () => {
    const session = new SessionState();
    session.addAllow("bash:ls");
    const calls: { command: string; opts: VerdictOptions }[] = [];
    const batch = new Map<string, Promise<VerdictResult> | null>();
    const p = startSiblingVerdicts(
      [
        { id: "a", command: "ls" },
        { id: "b", command: "git status" },
      ],
      "a",
      { session, cwd: CWD, home: HOME, llm: LLM, policy: "", maxParallel: 8, request: fakeRequest(calls) },
      batch,
    );
    assert.equal(p, undefined);
    assert.equal(batch.get("a"), null);
    assert.deepEqual(calls.map((c) => c.command), ["git status"]);
  });

  it("clears the previous batch when a new one starts", () => {
    const batch = new Map<string, Promise<VerdictResult> | null>();
    batch.set("stale", Promise.resolve(verdict()));
    startSiblingVerdicts([{ id: "a", command: "ls" }], "a", { cwd: CWD, home: HOME, llm: LLM, policy: "", maxParallel: 8, request: fakeRequest([]) }, batch);
    assert.equal(batch.has("stale"), false);
  });

  it("caps in-flight verdicts at maxParallel and starts queued ones as slots free", async () => {
    // manual-verdict fake: each call returns a promise resolved by release[i]()
    const calls: { command: string; release: (r: VerdictResult) => void }[] = [];
    const request = (command: string) =>
      new Promise<VerdictResult>((resolve) => {
        calls.push({ command, release: resolve });
      });
    const siblings = [
      { id: "a", command: "c1" },
      { id: "b", command: "c2" },
      { id: "c", command: "c3" },
    ];
    const batch = new Map<string, Promise<VerdictResult> | null>();
    const p = startSiblingVerdicts(siblings, "a", { cwd: CWD, home: HOME, llm: LLM, policy: "", maxParallel: 2, request }, batch);

    assert.equal(calls.length, 2, "only maxParallel verdicts start immediately");
    assert.deepEqual(calls.map((c) => c.command), ["c1", "c2"]);
    assert.ok(batch.get("c"), "queued sibling still has a batch entry");

    calls[0].release(verdict());
    await Promise.resolve();
    assert.equal(calls.length, 3, "the queued verdict starts when a slot frees");
    assert.equal(calls[2].command, "c3");

    calls[1].release(verdict());
    calls[2].release(verdict());
    const res = await p!;
    assert.equal(res.ok, true);
    assert.equal((await batch.get("c"))!.ok, true);
  });

  it("maxParallel below 1 still runs every verdict (clamped to 1)", async () => {
    const calls: { command: string; opts: VerdictOptions }[] = [];
    const batch = new Map<string, Promise<VerdictResult> | null>();
    startSiblingVerdicts(
      [
        { id: "a", command: "c1" },
        { id: "b", command: "c2" },
      ],
      "a",
      { cwd: CWD, home: HOME, llm: LLM, policy: "", maxParallel: 0, request: fakeRequest(calls) },
      batch,
    );
    assert.equal(calls.length, 1, "one at a time");
  });
});

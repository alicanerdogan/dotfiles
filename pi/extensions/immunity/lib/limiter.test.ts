import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AnalysisLimiter, abortedVerdict } from "./limiter.ts";
import type { VerdictResult } from "./llm-client.ts";

const verdict = (): VerdictResult => ({ ok: true, verdict: { risk: "none", outcome: "ALLOWED" } });

describe("AnalysisLimiter — session-wide concurrency", () => {
  it("caps in-flight requests and starts queued ones as slots free", async () => {
    const limiter = new AnalysisLimiter(2);
    const releases: (() => void)[] = [];
    const started: string[] = [];
    const request = (name: string) => () => {
      started.push(name);
      return new Promise<VerdictResult>((resolve) => releases.push(() => resolve(verdict())));
    };

    const a = limiter.schedule(request("a"));
    const b = limiter.schedule(request("b"));
    const c = limiter.schedule(request("c"));

    assert.deepEqual(started, ["a", "b"]);
    assert.equal(limiter.running, 2);
    assert.equal(limiter.queued, 1);

    releases[0]();
    await Promise.resolve();
    assert.deepEqual(started, ["a", "b", "c"], "the queued request starts when a slot frees");

    releases[1]();
    releases[2]();
    assert.equal((await a).ok, true);
    assert.equal((await b).ok, true);
    assert.equal((await c).ok, true);
    assert.equal(limiter.running, 0);
    assert.equal(limiter.queued, 0);
  });

  it("shares the cap across separate schedule calls (preflights, nested calls, retries)", async () => {
    const limiter = new AnalysisLimiter(1);
    const releases: (() => void)[] = [];
    const started: string[] = [];
    const request = (name: string) => () => {
      started.push(name);
      return new Promise<VerdictResult>((resolve) => releases.push(() => resolve(verdict())));
    };

    const first = limiter.schedule(request("preflight"));
    const second = limiter.schedule(request("nested"));
    const third = limiter.schedule(request("retry"));

    assert.deepEqual(started, ["preflight"]);
    releases[0]();
    await Promise.resolve();
    assert.deepEqual(started, ["preflight", "nested"]);
    releases[1]();
    await Promise.resolve();
    assert.deepEqual(started, ["preflight", "nested", "retry"]);
    releases[2]();
    await Promise.all([first, second, third]);
  });

  it("drops queued work whose signal aborted before it starts", async () => {
    const limiter = new AnalysisLimiter(1);
    let release!: () => void;
    let nestedCalls = 0;
    const first = limiter.schedule(() => new Promise<VerdictResult>((resolve) => {
      release = () => resolve(verdict());
    }));
    const controller = new AbortController();
    const queued = limiter.schedule(() => {
      nestedCalls++;
      return Promise.resolve(verdict());
    }, controller.signal);

    assert.equal(limiter.queued, 1);
    controller.abort();
    assert.deepEqual(await queued, abortedVerdict());
    assert.equal(nestedCalls, 0, "aborted queued work never calls the analyzer");

    release();
    await first;
    assert.equal(limiter.running, 0);
    assert.equal(limiter.queued, 0);
  });

  it("resolves a pre-aborted request without starting it", async () => {
    const limiter = new AnalysisLimiter(1);
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const result = await limiter.schedule(() => {
      calls++;
      return Promise.resolve(verdict());
    }, controller.signal);
    assert.deepEqual(result, abortedVerdict());
    assert.equal(calls, 0);
  });

  it("releases the slot when the analyzer throws or rejects", async () => {
    const limiter = new AnalysisLimiter(1);
    const thrown = await limiter.schedule(() => {
      throw new Error("boom");
    });
    assert.equal(thrown.ok, false);
    assert.equal(thrown.ok === false && thrown.kind, "spawn");

    let calls = 0;
    const rejected = await limiter.schedule(() => {
      calls++;
      return Promise.reject(new Error("nope"));
    });
    assert.equal(calls, 1);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.ok === false && rejected.kind, "spawn");

    assert.equal(limiter.running, 0);
    assert.equal(limiter.queued, 0);
    assert.equal((await limiter.schedule(() => Promise.resolve(verdict()))).ok, true, "the slot is usable again");
  });

  it("raising maxParallel starts queued work immediately", async () => {
    const limiter = new AnalysisLimiter(1);
    const releases: (() => void)[] = [];
    const started: string[] = [];
    const request = (name: string) => () => {
      started.push(name);
      return new Promise<VerdictResult>((resolve) => releases.push(() => resolve(verdict())));
    };
    limiter.schedule(request("a"));
    limiter.schedule(request("b"));
    assert.deepEqual(started, ["a"]);
    limiter.setMaxParallel(2);
    assert.deepEqual(started, ["a", "b"]);
    for (const release of releases) release();
  });
});

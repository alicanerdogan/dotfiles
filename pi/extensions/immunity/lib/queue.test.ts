import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ApprovalQueue } from "./queue.ts";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("ApprovalQueue — serialized approval flows", () => {
  it("runs one flow at a time and marks the waiting flow", async () => {
    const queue = new ApprovalQueue();
    const first = deferred();
    const started: string[] = [];
    const waited: boolean[] = [];

    const a = queue.run(async (w) => {
      started.push("a");
      waited.push(w);
      await first.promise;
      return "a";
    });
    const b = queue.run(async (w) => {
      started.push("b");
      waited.push(w);
      return "b";
    });

    while (started.length === 0) await new Promise((r) => setImmediate(r));
    assert.deepEqual(started, ["a"], "the second flow waits");
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(started, ["a"], "the second flow is still waiting");
    assert.equal(queue.pendingCount, 2);
    first.resolve();
    const [ra, rb] = await Promise.all([a, b]);
    assert.deepEqual(ra, { started: true, result: "a" });
    assert.deepEqual(rb, { started: true, result: "b" });
    assert.deepEqual(waited, [false, true]);
    assert.equal(queue.pendingCount, 0);
  });

  it("never starts an aborted queued flow and preserves ordering", async () => {
    const queue = new ApprovalQueue();
    const first = deferred();
    const started: string[] = [];
    const controller = new AbortController();

    const a = queue.run(async () => {
      started.push("a");
      await first.promise;
      return "a";
    });
    const aborted = queue.run(async () => {
      started.push("aborted");
      return "aborted";
    }, controller.signal);
    const c = queue.run(async (w) => {
      started.push("c");
      return `c:${w}`;
    });

    controller.abort();
    assert.deepEqual(await aborted, { started: false });
    assert.deepEqual(started, ["a"], "the aborted flow never ran");

    first.resolve();
    const [ra, rc] = await Promise.all([a, c]);
    assert.deepEqual(ra, { started: true, result: "a" });
    assert.deepEqual(rc, { started: true, result: "c:true" }, "the next flow waited behind the drained slot");
    assert.deepEqual(started, ["a", "c"]);
    assert.equal(queue.pendingCount, 0);
  });

  it("returns immediately for a pre-aborted flow", async () => {
    const queue = new ApprovalQueue();
    const controller = new AbortController();
    controller.abort();
    let ran = false;
    const result = await queue.run(async () => {
      ran = true;
      return "x";
    }, controller.signal);
    assert.deepEqual(result, { started: false });
    assert.equal(ran, false);
    assert.equal(queue.pendingCount, 0);
  });

  it("releases the slot when a flow throws", async () => {
    const queue = new ApprovalQueue();
    const a = queue.run(async () => {
      throw new Error("boom");
    });
    const b = queue.run(async () => "after");
    await assert.rejects(a, /boom/);
    assert.deepEqual(await b, { started: true, result: "after" });
    assert.equal(queue.pendingCount, 0);
  });
});

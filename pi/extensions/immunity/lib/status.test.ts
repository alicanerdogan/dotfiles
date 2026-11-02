import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { StatusCounter } from "./status.ts";

describe("StatusCounter — concurrent handler status", () => {
  it("keeps the indicator visible until the last handler finishes", () => {
    const writes: (string | null)[] = [];
    const status = new StatusCounter((label) => writes.push(label));

    status.begin("immunity: analyzing…");
    status.begin("immunity: analyzing…");
    assert.equal(status.count, 2);
    assert.deepEqual(writes, ["immunity: analyzing…"], "only the first handler writes the label");

    status.end();
    assert.deepEqual(writes, ["immunity: analyzing…"], "the early finisher does not clear it");
    assert.equal(status.count, 1);

    status.end();
    assert.deepEqual(writes, ["immunity: analyzing…", null], "the last finisher clears it");
    assert.equal(status.count, 0);
  });

  it("ignores unmatched ends and supports the HandlerEnv adapter", () => {
    const writes: (string | null)[] = [];
    const status = new StatusCounter((label) => writes.push(label));

    status.end();
    assert.deepEqual(writes, [], "no underflow");
    status.set("immunity: analyzing…");
    status.set(null);
    status.set(null);
    assert.deepEqual(writes, ["immunity: analyzing…", null]);
    assert.equal(status.count, 0);
  });

  it("reset clears the indicator and drops held references", () => {
    const writes: (string | null)[] = [];
    const status = new StatusCounter((label) => writes.push(label));
    status.begin("a");
    status.begin("b");
    status.reset();
    assert.equal(status.count, 0);
    assert.deepEqual(writes, ["a", null]);
    status.end();
    assert.deepEqual(writes, ["a", null], "a late handler cannot write after reset");
  });
});

/**
 * Interactive-only gating tests.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldEnforce } from "./gate.ts";

describe("shouldEnforce", () => {
  it("enforces only when the session has a UI", () => {
    assert.equal(shouldEnforce(true), true);
    assert.equal(shouldEnforce(false), false);
  });
});

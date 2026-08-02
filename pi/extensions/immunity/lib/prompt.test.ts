/**
 * Prompt flow tests: menu construction, allow once/session, deny paths,
 * reason capture, rule follow-up gating, dismissal and UI-failure safety.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runPromptFlow, type PromptFlowOptions } from "./prompt.ts";
import { MemoryGrantStore } from "./grants.ts";
import { FakeUi } from "./testing.ts";

function opts(partial: Partial<PromptFlowOptions> = {}): { ui: FakeUi } & PromptFlowOptions {  const ui = new FakeUi();
  return {
    ui,
    reason: "rm -rf (recursive force delete)",
    grantKey: "bash:rm -rf /x",
    grants: new MemoryGrantStore(),
    prompting: { askReasonOnDeny: true, sessionGrants: true },
    command: "rm -rf /x",
    saveRule: async () => true,
    ...partial,
  };
}

describe("runPromptFlow menu", () => {
  it("offers Allow for session only when sessionGrants is on", async () => {
    const o = opts();
    o.ui.selects.push("Deny");
    await runPromptFlow(o);
    assert.deepEqual(o.ui.selectCalls[0].options, ["Allow once", "Allow for session", "Deny", "Deny with reason"]);

    const o2 = opts({ prompting: { askReasonOnDeny: true, sessionGrants: false } });
    o2.ui.selects.push("Deny");
    await runPromptFlow(o2);
    assert.deepEqual(o2.ui.selectCalls[0].options, ["Allow once", "Deny", "Deny with reason"]);
  });

  it("shows the reason in the prompt title", async () => {
    const o = opts({ reason: "disk formatting" });
    o.ui.selects.push("Deny");
    await runPromptFlow(o);
    assert.equal(o.ui.selectCalls[0].title, "Immunity: disk formatting");
  });
});

describe("allow paths", () => {
  it("Allow once proceeds without recording a grant", async () => {
    const o = opts();
    o.ui.selects.push("Allow once");
    const r = await runPromptFlow(o);
    assert.deepEqual(r, { action: "allow", grant: "once" });
    assert.equal(o.grants.check(o.grantKey), null, "once is literally one call");
  });

  it("Allow for session records a session grant", async () => {
    const o = opts();
    o.ui.selects.push("Allow for session");
    const r = await runPromptFlow(o);
    assert.deepEqual(r, { action: "allow", grant: "session" });
    assert.equal(o.grants.check(o.grantKey), "session");
  });

  it("Always allow persists a command grant and allows the call", async () => {
    const persisted: [string, string][] = [];
    const o = opts({ persistGrant: async (k, v) => (persisted.push([k, v]), true) });
    o.ui.selects.push("Always allow");
    const r = await runPromptFlow(o);
    assert.deepEqual(r, { action: "allow", grant: "always", persisted: true });
    assert.deepEqual(persisted, [["command", "rm -rf /x"]]);
  });

  it("Always allow for a file request persists the resolved path", async () => {
    const persisted: [string, string][] = [];
    const o = opts({ command: undefined, protectPath: "/repo/.env", persistGrant: async (k, v) => (persisted.push([k, v]), true) });
    o.ui.selects.push("Always allow");
    const r = await runPromptFlow(o);
    assert.deepEqual(r, { action: "allow", grant: "always", persisted: true });
    assert.deepEqual(persisted, [["path", "/repo/.env"]]);
  });

  it("Always allow still allows when persistence fails", async () => {
    const o = opts({ persistGrant: async () => false });
    o.ui.selects.push("Always allow");
    const r = await runPromptFlow(o);
    assert.deepEqual(r, { action: "allow", grant: "always", persisted: false });
  });

  it("hides Always allow when no persistGrant hook is wired", async () => {
    const o = opts();
    o.ui.selects.push("Deny");
    await runPromptFlow(o);
    assert.ok(!o.ui.selectCalls[0].options.includes("Always allow"));
  });
});

describe("deny paths", () => {
  it("Deny blocks with no reason", async () => {
    const o = opts();
    o.ui.selects.push("Deny");
    assert.deepEqual(await runPromptFlow(o), { action: "deny" });
  });

  it("dismissing the menu denies (safety-first)", async () => {
    const o = opts();
    o.ui.selects.push(undefined);
    assert.deepEqual(await runPromptFlow(o), { action: "deny" });
  });

  it("a UI failure denies", async () => {
    const o = opts();
    o.ui.failNext("select");
    assert.deepEqual(await runPromptFlow(o), { action: "deny" });
  });

  it("Deny with reason captures the reason", async () => {
    const o = opts();
    o.ui.selects.push("Deny with reason");
    o.ui.inputs.push("I'll fix it manually");
    const r = await runPromptFlow(o);
    assert.equal(r.action, "deny");
    assert.equal(r.userReason, "I'll fix it manually");
  });

  it("skips the reason follow-up when the input is dismissed", async () => {
    const o = opts();
    o.ui.selects.push("Deny with reason");
    o.ui.inputs.push(undefined);
    const r = await runPromptFlow(o);
    assert.deepEqual(r, { action: "deny", userReason: undefined });
    assert.equal(o.ui.selectCalls.length, 1, "no remember-as-rule menu without a reason");
  });

  it("an input failure still denies without a reason", async () => {
    const o = opts();
    o.ui.selects.push("Deny with reason");
    o.ui.failNext("input");
    const r = await runPromptFlow(o);
    assert.deepEqual(r, { action: "deny", userReason: undefined });
  });
});

describe("remember-as-rule follow-up", () => {
  it("runs only when a reason was given and askReasonOnDeny is on", async () => {
    const o = opts({ prompting: { askReasonOnDeny: false, sessionGrants: true } });
    o.ui.selects.push("Deny with reason");
    o.ui.inputs.push("no");
    const r = await runPromptFlow(o);
    assert.equal(r.action, "deny");
    assert.equal(o.ui.selectCalls.length, 1, "follow-up menu skipped");
  });

  it("offers the pattern rule for bash and saves the raw command", async () => {
    const saved: [string, string][] = [];
    const o = opts({ saveRule: async (k, v) => (saved.push([k, v]), true) });
    o.ui.selects.push("Deny with reason", "Block this command pattern");
    o.ui.inputs.push("stop doing that");
    const r = await runPromptFlow(o);
    assert.deepEqual(r, { action: "deny", userReason: "stop doing that", savedRule: "autoDeny" });
    assert.deepEqual(saved, [["autoDeny", "rm -rf /x"]]);
  });

  it("offers the path rule for file requests and saves the resolved target", async () => {
    const saved: [string, string][] = [];
    const o = opts({
      command: undefined,
      protectPath: "/repo/.env",
      saveRule: async (k, v) => (saved.push([k, v]), true),
    });
    o.ui.selects.push("Deny with reason", "Protect this path");
    o.ui.inputs.push("secret file");
    const r = await runPromptFlow(o);
    assert.deepEqual(r, { action: "deny", userReason: "secret file", savedRule: "path" });
    assert.deepEqual(saved, [["path", "/repo/.env"]]);
  });

  it("gates options on the request kind", async () => {
    const o = opts({ command: undefined, protectPath: "/repo/.env" });
    o.ui.selects.push("Deny with reason", "No");
    o.ui.inputs.push("x");
    await runPromptFlow(o);
    assert.deepEqual(o.ui.selectCalls[1].options, ["No", "Protect this path"]);

    const o2 = opts();
    o2.ui.selects.push("Deny with reason", "No");
    o2.ui.inputs.push("x");
    await runPromptFlow(o2);
    assert.deepEqual(o2.ui.selectCalls[1].options, ["No", "Block this command pattern"]);
  });

  it("does not report savedRule when the save failed", async () => {
    const o = opts({ saveRule: async () => false });
    o.ui.selects.push("Deny with reason", "Block this command pattern");
    o.ui.inputs.push("x");
    const r = await runPromptFlow(o);
    assert.equal(r.action, "deny");
    assert.equal(r.savedRule, undefined);
  });

  it("'No' records nothing", async () => {
    const o = opts();
    o.ui.selects.push("Deny with reason", "No");
    o.ui.inputs.push("x");
    const r = await runPromptFlow(o);
    assert.deepEqual(r, { action: "deny", userReason: "x" });
  });
});

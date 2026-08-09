import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MENU_OPTIONS, oneLine, runPromptFlow, runSuggestionStep, type PromptFlowOptions, type SuggestionStepOptions } from "./prompt.ts";
import { SessionState } from "./session.ts";
import { FakeUi } from "./testing.ts";
import type { RuleKind } from "./rules.ts";

function flow(over: Partial<PromptFlowOptions> = {}): { opts: PromptFlowOptions; ui: FakeUi; session: SessionState; saved: { kind: RuleKind; value: string; scope: "project" | "global"; pathKind?: string }[] } {
  const ui = new FakeUi();
  const session = new SessionState();
  const saved: { kind: RuleKind; value: string; scope: "project" | "global"; pathKind?: string }[] = [];
  const base: PromptFlowOptions = {
    ui,
    reason: "test reason",
    sessionKey: "bash:ls -la",
    session,
    saveRule: async (kind, value, scope, o) => {
      saved.push({ kind, value, scope, ...(o?.pathKind ? { pathKind: o.pathKind } : {}) });
      return true;
    },
  };
  return { opts: { ...base, ...over }, ui, session, saved };
}

describe("oneLine", () => {
  it("collapses multi-line commands to a single line", () => {
    assert.equal(oneLine("blocked:\n  git push\n  --force"), "blocked: git push --force");
  });

  it("truncates overly long reasons with an ellipsis", () => {
    const long = "x".repeat(500);
    const out = oneLine(long);
    assert.equal(out.length, 200);
    assert.ok(out.endsWith("…"));
  });

  it("leaves short reasons untouched", () => {
    assert.equal(oneLine("path denied by rule: ~/.ssh (global)"), "path denied by rule: ~/.ssh (global)");
  });
});

describe("runSuggestionStep", () => {
  const sug = (paths: string[]) => ({ paths, commands: [] as { raw: string; general?: string }[] });

  function flow(over: Partial<SuggestionStepOptions> = {}): { opts: SuggestionStepOptions; ui: FakeUi; session: SessionState; saved: { kind: RuleKind; value: string; scope: "project" | "global"; pathKind?: string }[] } {
    const ui = new FakeUi();
    const session = new SessionState();
    const saved: { kind: RuleKind; value: string; scope: "project" | "global"; pathKind?: string }[] = [];
    const opts: SuggestionStepOptions = {
      ui,
      reason: "test reason",
      suggestions: sug([]),
      session,
      saveRule: async (kind, value, scope, o) => {
        saved.push({ kind, value, scope, ...(o?.pathKind ? { pathKind: o.pathKind } : {}) });
        return true;
      },
      ...over,
    };
    return { opts, ui, session, saved };
  }

  it("offers the suggestion options per flagged path", async () => {
    const { opts, ui } = flow({ suggestions: sug(["/a"]) });
    ui.selects.push("Skip");
    const r = await runSuggestionStep(opts);
    assert.deepEqual(r, { choices: [{ action: "skip" }], protected: false, failed: false });
    assert.equal(ui.selectCalls[0].title, "Immunity (1/1): analyzer flagged /a");
    assert.deepEqual(ui.selectCalls[0].options, [
      "Allow for session",
      "Allow for project",
      "Allow globally",
      "Protect for project",
      "Protect for global",
      "Skip",
    ]);
  });

  it("Skip moves to the next path; all skipped → not protected", async () => {
    const { opts, ui } = flow({ suggestions: sug(["/a", "/b"]) });
    ui.selects.push("Skip", "Skip");
    const r = await runSuggestionStep(opts);
    assert.equal(r.protected, false);
    assert.deepEqual(r.choices, [{ action: "skip" }, { action: "skip" }]);
  });

  it("Allow for session registers a session statement", async () => {
    const { opts, ui, session } = flow({ suggestions: sug(["/home/u/repos"]) });
    ui.selects.push("Allow for session");
    const r = await runSuggestionStep(opts);
    assert.equal(r.protected, false);
    assert.ok(session.isAllowed("file:/home/u/repos"));
    assert.deepEqual(r.choices, [{ action: "allow", scope: "session", value: "/home/u/repos", pathKind: "file" }]);
  });

  it("Allow for project writes a pathAllow rule; glob suggestions are filtered and deduped", async () => {
    const { opts, ui, saved } = flow({ suggestions: sug(["/a", "/a", "~/x/*"]) });
    ui.selects.push("Allow for project");
    const r = await runSuggestionStep(opts);
    assert.equal(r.protected, false);
    assert.equal(ui.selectCalls.length, 1, "one dialog per concrete unique path");
    assert.deepEqual(saved, [{ kind: "pathAllow", value: "/a", scope: "project", pathKind: "file" }]);
  });

  it("Protect writes a pathDeny rule, blocks the command, and stops the loop", async () => {
    const { opts, ui, saved } = flow({ suggestions: sug(["/a", "/b"]) });
    ui.selects.push("Protect for global");
    const r = await runSuggestionStep(opts);
    assert.deepEqual(r, { choices: [{ action: "protect", scope: "global", value: "/a", pathKind: "file", persisted: true }], protected: true, protectedPath: "/a", failed: false });
    assert.deepEqual(saved, [{ kind: "pathDeny", value: "/a", scope: "global", pathKind: "file" }]);
    assert.equal(ui.selectCalls.length, 1, "no dialog for /b — the command is already resolved");
  });

  it("kind comes from pathKindFor", async () => {
    const { opts, ui, saved } = flow({ suggestions: sug(["/a"]), pathKindFor: () => "directory" });
    ui.selects.push("Allow globally");
    await runSuggestionStep(opts);
    assert.deepEqual(saved, [{ kind: "pathAllow", value: "/a", scope: "global", pathKind: "directory" }]);
  });

  it("dismissed and broken prompts fail safe (block the command)", async () => {
    const { opts, ui } = flow({ suggestions: sug(["/a"]) });
    ui.selects.push(undefined);
    const r = await runSuggestionStep(opts);
    assert.equal(r.failed, true);
    assert.equal(r.protected, true);

    const { opts: opts2, ui: ui2 } = flow({ suggestions: sug(["/a"]) });
    ui2.failNext("select");
    const r2 = await runSuggestionStep(opts2);
    assert.equal(r2.failed, true);
  });
});

describe("runPromptFlow — six options", () => {
  it("offers exactly the six menu options", async () => {
    const { opts, ui } = flow();
    ui.selects.push(undefined);
    await runPromptFlow(opts);
    assert.deepEqual(ui.selectCalls[0].options, [...MENU_OPTIONS]);
    assert.equal(ui.selectCalls[0].title, "Immunity: test reason");
  });

  it("menu title is one line even for multi-line reasons", async () => {
    const { opts, ui } = flow({ reason: "blocked: find ~/repos\n  -maxdepth 1\n  -type d" });
    ui.selects.push(undefined);
    await runPromptFlow(opts);
    assert.equal(ui.selectCalls[0].title, "Immunity: blocked: find ~/repos -maxdepth 1 -type d");
    assert.ok(!ui.selectCalls[0].title.includes("\n"));
  });

  it("Allow for session → session statement, no rule write", async () => {
    const { opts, ui, session, saved } = flow();
    ui.selects.push("Allow for session");
    const r = await runPromptFlow(opts);
    assert.deepEqual(r, { action: "allow", scope: "session", pathKind: undefined, pathValue: undefined });
    assert.ok(session.isAllowed("bash:ls -la"));
    assert.deepEqual(saved, []);
  });

  it("Allow for project (command) → exact allow rule", async () => {
    const { opts, ui, saved } = flow({ command: "npm install lodash" });
    ui.selects.push("Allow for project");
    const r = await runPromptFlow(opts);
    assert.deepEqual(r, { action: "allow", scope: "project", persisted: true, pathKind: undefined, pathValue: undefined });
    assert.deepEqual(saved, [{ kind: "commandAllow", value: "npm install lodash", scope: "project" }]);
  });

  it("Allow globally (path) — directory target skips the follow-up", async () => {
    const { opts, ui, saved } = flow({ path: "~/repos", pathKind: "directory" });
    ui.selects.push("Allow globally");
    const r = await runPromptFlow(opts);
    assert.deepEqual(r, { action: "allow", scope: "global", persisted: true, pathKind: "directory", pathValue: "~/repos" });
    assert.deepEqual(saved, [{ kind: "pathAllow", value: "~/repos", scope: "global", pathKind: "directory" }]);
    assert.equal(ui.selectCalls.length, 1, "no follow-up for directory targets");
  });

  it("path rule on a file target: follow-up can widen to the containing directory", async () => {
    const { opts, ui, saved } = flow({ path: "~/.config/app.conf", pathKind: "file" });
    ui.selects.push("Allow for project", "The whole directory (recursive)");
    const r = await runPromptFlow(opts);
    assert.equal(r.pathKind, "directory");
    assert.equal(r.pathValue, "~/.config");
    assert.deepEqual(saved, [{ kind: "pathAllow", value: "~/.config", scope: "project", pathKind: "directory" }]);
  });

  it("path rule on a file target: dismissed follow-up stays a file rule", async () => {
    const { opts, ui, saved } = flow({ path: "~/.config/app.conf", pathKind: "file" });
    ui.selects.push("Allow for project", undefined);
    const r = await runPromptFlow(opts);
    assert.equal(r.pathKind, "file");
    assert.equal(r.pathValue, "~/.config/app.conf");
    assert.deepEqual(saved, [{ kind: "pathAllow", value: "~/.config/app.conf", scope: "project", pathKind: "file" }]);
  });

  it("Allow for session on a directory choice covers descendants", async () => {
    const { opts, ui, session } = flow({ path: "~/repos/alicancodes/lib/a.ts", pathKind: "file", sessionKey: "file:/home/u/repos/alicancodes/lib/a.ts" });
    ui.selects.push("Allow for session", "The whole directory (recursive)");
    const r = await runPromptFlow(opts);
    assert.deepEqual(r, { action: "allow", scope: "session", pathKind: "directory", pathValue: "~/repos/alicancodes/lib" });
    assert.ok(session.isAllowed("file:/home/u/repos/alicancodes/lib"), "directory statement registered");
    assert.ok(session.isAllowed("file:/home/u/repos/alicancodes/lib/other/b.ts"), "descendant covered");
    assert.ok(!session.isAllowed("file:/home/u/repos/alicancodes/src/x.ts"), "sibling not covered");
  });

  it("Block for project → deny rule + reason ask (No → no reason)", async () => {
    const { opts, ui, saved } = flow({ command: "git push --force" });
    ui.selects.push("Block for project", "No");
    const r = await runPromptFlow(opts);
    assert.deepEqual(r, { action: "block", scope: "project", persisted: true, userReason: undefined, pathKind: undefined, pathValue: undefined });
    assert.deepEqual(saved, [{ kind: "commandDeny", value: "git push --force", scope: "project" }]);
  });

  it("Block globally → deny rule + user reason overwrites (Yes → input)", async () => {
    const { opts, ui, saved } = flow({ command: "git push --force" });
    ui.selects.push("Block globally", "Yes");
    ui.inputs.push("never force-push to main");
    const r = await runPromptFlow(opts);
    assert.deepEqual(r, { action: "block", scope: "global", persisted: true, userReason: "never force-push to main", pathKind: undefined, pathValue: undefined });
    assert.deepEqual(saved, [{ kind: "commandDeny", value: "git push --force", scope: "global" }]);
  });

  it("Block for session → session deny + reason ask", async () => {
    const { opts, ui, session } = flow({ command: "rm -rf /", sessionKey: "bash:rm -rf /" });
    ui.selects.push("Block for session", "No");
    const r = await runPromptFlow(opts);
    assert.equal(r.action, "block");
    assert.equal(r.scope, "session");
    assert.ok(session.isDenied("bash:rm -rf /"));
  });

  it("persistence failure is reported (persisted: false) but never throws", async () => {
    const { opts, ui } = flow({ command: "x", saveRule: async () => false });
    ui.selects.push("Allow for project");
    const r = await runPromptFlow(opts);
    assert.deepEqual(r, { action: "allow", scope: "project", persisted: false, pathKind: undefined, pathValue: undefined });
  });
});

describe("runPromptFlow — safety on broken prompts", () => {
  it("dismissed prompt → block for session", async () => {
    const { opts, ui } = flow();
    ui.selects.push(undefined);
    const r = await runPromptFlow(opts);
    assert.deepEqual(r, { action: "block", scope: "session" });
  });

  it("UI failure → block for session, nothing leaks through", async () => {
    const { opts, ui } = flow();
    ui.failNext("select");
    const r = await runPromptFlow(opts);
    assert.deepEqual(r, { action: "block", scope: "session" });
  });

  it("reason-ask failure degrades to no reason", async () => {
    const { opts, ui } = flow({ command: "x" });
    ui.selects.push("Block for project");
    ui.failNext("select"); // the reason confirm fails
    const r = await runPromptFlow(opts);
    assert.equal(r.action, "block");
    assert.equal(r.userReason, undefined);
  });
});

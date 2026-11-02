/**
 * Integration test for the extension entry point.
 *
 * The unit suites call handleToolCall directly; they cannot catch a broken
 * buildEnv wiring (for example a handler referencing a factory-scoped
 * variable that is not in scope). This test loads index.ts with a stubbed
 * pi package and drives a UI-enabled tool call end to end.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const stub = `data:text/javascript,${encodeURIComponent(
  "export const CONFIG_DIR_NAME = '.pi';\nexport const getAgentDir = () => globalThis.__immunityAgentDir;",
)}`;
const loader = `
const stub = ${JSON.stringify(stub)};
export async function resolve(specifier, context, next) {
  if (specifier === "@earendil-works/pi-coding-agent") {
    return { url: stub, shortCircuit: true };
  }
  return next(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url);

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface SelectCall {
  title: string;
  options: string[];
}

describe("immunity extension entry — UI wiring", () => {
  it("builds a handler env for a hasUI tool call and allows it", async () => {
    const dir = mkdtempSync(join(import.meta.dirname, ".test-tmp-"));
    dirs.push(dir);
    const agentDir = join(dir, "agent");
    const projectDir = join(dir, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    const config = JSON.stringify({ strict: true, llm: { disabled: true }, audit: { enabled: false } });
    writeFileSync(join(agentDir, "immunity.json"), config);
    writeFileSync(join(projectDir, ".pi", "immunity.json"), config);
    (globalThis as { __immunityAgentDir?: string }).__immunityAgentDir = agentDir;

    const { default: immunity } = await import("./index.ts");

    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const selects: SelectCall[] = [];
    const statusWrites: (string | null)[] = [];
    const pi = {
      on(event: string, handler: (...args: unknown[]) => unknown) {
        handlers.set(event, handler);
      },
      events: { emit() {} },
    };
    const ctx = {
      hasUI: true,
      cwd: projectDir,
      signal: new AbortController().signal,
      isProjectTrusted: () => true,
      sessionManager: {
        getLeafEntry: () => null,
        getSessionId: () => "test-session",
      },
      ui: {
        setStatus: (_key: string, label: string | null) => statusWrites.push(label),
        notify() {},
        async select(title: string, options: string[]) {
          selects.push({ title, options });
          return "Allow";
        },
        async input() {
          return undefined;
        },
      },
    };

    immunity(pi as never);
    await handlers.get("session_start")!({}, ctx);
    const result = await handlers.get("tool_call")!(
      { toolName: "bash", toolCallId: "call-1", input: { command: "echo hi" } },
      ctx,
    );

    assert.equal(result, undefined, "Allow returns undefined (no block)");
    assert.equal(selects.length, 1, "the approval dialog opened");
    assert.deepEqual(selects[0].options, ["Allow", "Deny"]);
  });

  it("registers no handlers when DANGEROUSLY_SKIP_IMMUNITY=1", async () => {
    const previous = process.env.DANGEROUSLY_SKIP_IMMUNITY;
    process.env.DANGEROUSLY_SKIP_IMMUNITY = "1";
    try {
      const { default: immunity } = await import("./index.ts");
      const registered: string[] = [];
      const pi = {
        on(event: string) {
          registered.push(event);
        },
        events: { emit() {} },
      };
      immunity(pi as never);
      assert.deepEqual(registered, [], "no event handlers are registered");
    } finally {
      if (previous === undefined) delete process.env.DANGEROUSLY_SKIP_IMMUNITY;
      else process.env.DANGEROUSLY_SKIP_IMMUNITY = previous;
    }
  });
});

/**
 * pi-immunity: the analysis subprocess extension (promoted from spike 2).
 *
 * Loaded into a headless `pi --mode json` subprocess via `--extension`.
 * Registers exactly one tool (`immunity_verdict`) — the only tool the
 * analyzer may call. The schema-validated parameters are returned as the
 * tool result; the parent extension reads them from the `tool_execution_end`
 * event in the subprocess's JSON event stream.
 *
 * Lives in a subdirectory on purpose: pi's extension discovery loads only
 * flat files (extensions dot ts) and subdirectory index files, so this
 * file is inert in the main session (no stray `immunity_verdict` tool
 * registered there). It is only ever loaded explicitly via `--extension`
 * in the analysis subprocess, which also passes `--no-extensions`, so
 * there is no recursion and no approval flow inside the subprocess.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "immunity_verdict",
    label: "Immunity Verdict",
    description:
      "Deliver your security verdict for the command under analysis. " +
      "You MUST call this tool to respond — it is the only way to answer. " +
      "outcome ALLOWED = safe to run, DENY = must never run, ASK_USER = " +
      "needs a human decision. risk describes the blast radius: none, low, high.",
    parameters: Type.Object({
      risk: Type.Enum({ none: "none", low: "low", high: "high" }),
      outcome: Type.Enum({ ALLOWED: "ALLOWED", DENY: "DENY", ASK_USER: "ASK_USER" }),
      reason: Type.Optional(Type.String({ description: "short justification" })),
      paths: Type.Optional(
        Type.Object({
          blocked: Type.Array(Type.String({ description: "concrete path the command touches that should be protected or allowed by the user" })),
        }),
      ),
      commands: Type.Optional(
        Type.Object({
          blocked: Type.Array(
            Type.Object({
              raw: Type.String({ description: "the exact command to block" }),
              general: Type.Optional(Type.String({ description: "a broader pattern the same rule could cover (audit-only, never applied automatically)" })),
            }),
          ),
        }),
      ),
    }),
    async execute(toolCallId, params) {
      return {
        content: [{ type: "text", text: JSON.stringify(params) }],
        details: {},
      };
    },
  });
}

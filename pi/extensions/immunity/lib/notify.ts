/**
 * onPromptCommand (design §5): a user-configured bash command runs right
 * before an approval prompt opens. Pure module — spawn is injectable for
 * tests; the real call passes node:child_process.spawn.
 *
 * Contract:
 *   - context via env vars IMMUNITY_PROMPT_ID / FEATURE / REASON / ACTION
 *   - exit code ignored (pure notification)
 *   - fire-and-forget: returns immediately; failures are logged via the
 *     log callback, never thrown
 *   - hard kill after 30 s (the notification shell must not linger)
 */
import { spawn, type ChildProcess } from "node:child_process";

export const PROMPT_ENV_KEYS = ["IMMUNITY_PROMPT_ID", "IMMUNITY_FEATURE", "IMMUNITY_REASON", "IMMUNITY_ACTION"] as const;

/** Build the context env block for the notification command. */
export function promptEnv(
  promptId: string,
  feature: string,
  reason: string,
  action: string,
): Record<(typeof PROMPT_ENV_KEYS)[number], string> {
  return {
    IMMUNITY_PROMPT_ID: promptId,
    IMMUNITY_FEATURE: feature,
    IMMUNITY_REASON: reason,
    IMMUNITY_ACTION: action,
  };
}

export interface PromptCommandOptions {
  timeoutMs?: number;
  log?: (msg: string) => void;
  /** injectable for tests; defaults to node:child_process.spawn */
  spawn?: (cmd: string, args: string[], options: Record<string, unknown>) => ChildProcess;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Fire-and-forget notification; never throws. */
export function runPromptCommand(
  command: string,
  env: Record<string, string>,
  opts: PromptCommandOptions = {},
): void {
  if (!command) return;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawnFn = opts.spawn ?? spawn;

  let child: ChildProcess | null = null;
  try {
    child = spawnFn(command, [], {
      shell: true,
      env: { ...process.env, ...env },
      stdio: "ignore",
    });
  } catch (err) {
    opts.log?.(`immunity: onPromptCommand spawn failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  child!.on("error", (err) => {
    opts.log?.(`immunity: onPromptCommand failed: ${err.message}`);
  });
  const timer = setTimeout(() => {
    try {
      child?.kill();
    } catch {
      // already gone
    }
  }, timeoutMs);
  timer.unref();
  child!.on("close", () => clearTimeout(timer));
}

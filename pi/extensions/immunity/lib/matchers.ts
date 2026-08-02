/**
 * Built-in structural matchers (pi-immunity).
 *
 * Ported from the guardrails catalog (see pi-guardrails.md), rewritten by
 * hand. Matching logic runs on a normalized CommandModel (§4.1), so the same
 * matchers serve the AST path and the word-based fallback path.
 *
 * Severity is safety-first for v1 (tunable later via config):
 *   - "deny"  — irreversible damage: disk formatting/writes, credential overwrite
 *   - "prompt" — destructive but recoverable, or privileged: rm -rf, sudo,
 *     chmod -R, curl | sh
 */
import type { CommandModel } from "./tree-sitter.ts";

export type Severity = "prompt" | "deny";

export interface BuiltinMatch {
  id: string;
  severity: Severity;
  label: string;
}

const RECURSIVE = /^--recursive$|^-[a-z]*r[a-z]*$/;
const FORCE = /^--force$|^-[a-z]*f[a-z]*$/;
const CHMOD_R = /^-[a-z]*R[a-z]*$/;
const DISK_DEVICE = /^\/dev\/(r?disk|sd[a-z]\d*|nvme\d+n\d*|hd[a-z]\d*)/;
const DD_DISK = /^of=\/dev\/(r?disk|sd[a-z]\d*|nvme\d+n\d*|hd[a-z]\d*)/;
const SSH_AUTHORIZED_KEYS = /\.ssh\/authorized_keys$/;

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

/** Run the built-in catalog; returns unique matches in catalog order. */
export function matchBuiltins(model: CommandModel): BuiltinMatch[] {
  const found: BuiltinMatch[] = [];
  const add = (m: BuiltinMatch) => {
    if (!found.some((f) => f.id === m.id)) found.push(m);
  };

  for (const s of model.stages) {
    if (s.name === "rm" && s.args.some((a) => RECURSIVE.test(a)) && s.args.some((a) => FORCE.test(a))) {
      add({ id: "rm-force", severity: "prompt", label: "rm -rf (recursive force delete)" });
    }
    if (s.name === "sudo") {
      add({ id: "sudo", severity: "prompt", label: "sudo (privileged command)" });
    }
    if (/^(mkfs|newfs)/.test(s.name)) {
      add({ id: "disk-format", severity: "deny", label: "disk formatting (mkfs/newfs)" });
    }
    if (s.name === "dd" && s.args.some((a) => DD_DISK.test(a))) {
      add({ id: "dd-disk", severity: "deny", label: "dd to a disk device" });
    }
    if (s.name === "chmod" && s.args.some((a) => CHMOD_R.test(a))) {
      add({ id: "chmod-recursive", severity: "prompt", label: "chmod -R (recursive permissions)" });
    }
  }

  for (let i = 0; i + 1 < model.stages.length; i++) {
    const s = model.stages[i];
    const next = model.stages[i + 1];
    if (s.name === "curl" && next.sep === "|" && SHELLS.has(next.name)) {
      add({ id: "curl-pipe-shell", severity: "prompt", label: "curl | sh (remote code execution)" });
      break;
    }
  }

  for (const r of model.redirects) {
    if (DISK_DEVICE.test(r)) {
      add({ id: "redirect-disk", severity: "deny", label: "redirect to a disk device" });
    }
    if (SSH_AUTHORIZED_KEYS.test(r)) {
      add({ id: "redirect-ssh-keys", severity: "deny", label: "overwrite ~/.ssh/authorized_keys" });
    }
  }

  return found;
}

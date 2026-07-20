import { basename, dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Run a poltergeist (geist) workflow from inside pi.
//
// Usage: /geist <workflow> [key=value]...
//
//   /geist fork name=refactor-auth
//   /geist review branch=feat/login
//
// The first token is the poltergeist workflow name (passed verbatim to
// `geist up <workflow>`); the rest are `key=value` params forwarded as
// `--param key=value`. User params override the auto-injected ones below.
//
// Every workflow receives these params (declare them in the workflow, with
// `default: ""` if optional — geist errors on undeclared params):
//   repo        - git repository name (when in a git repo)
//   worktree    - current worktree's dir basename (equals `repo` in the main
//                 checkout; distinct in a linked worktree)
//
// The `fork` workflow additionally receives:
//   pi_session  - absolute path of the current pi session file to fork
//   name        - the fork name (user-provided)
//
// The `fork` workflow contract:
//
//   workflows:
//     fork:
//       name: "pi:${repo}:${worktree}:${name}"
//       params:
//         pi_session: { required: true }
//         name:       { required: true }
//         repo:       { default: "" }
//         worktree:   { default: "" }
//       layout:
//         panels:
//           - run: pi --fork "${pi_session}" --name "${name}"
//
// When the `fork` workflow is absent, /geist falls back to a single-pane tab
// running `pi --fork <session> --name <name>` (requires a `name=` param).
// Other workflows have no fallback: geist errors surface as notifications. In
// both fork paths the new pi process forks the *current* session into a fresh
// one, leaving this session untouched.
const FORK_WORKFLOW = "fork";
const SESSION_PARAM = "pi_session";
const REPO_PARAM = "repo";
const WORKTREE_PARAM = "worktree";
const NAME_PARAM = "name";

async function resolveGeistBinary(pi: ExtensionAPI): Promise<string | null> {
  for (const bin of ["geist", "poltergeist"]) {
    const r = await pi.exec(bin, ["--version"], { timeout: 5_000 });
    if (r.code === 0) return bin;
  }
  return null;
}

// Repository name and the current worktree's dir basename. In the main checkout
// the worktree basename equals the repo name; in a linked worktree it's the
// worktree's own dir name. Empty when not in a git repo.
async function gitInfo(
  pi: ExtensionAPI,
  ctx: { cwd: string },
): Promise<{ repo: string; worktree: string }> {
  async function git(args: string[]): Promise<string> {
    const r = await pi.exec("git", args, { timeout: 5_000, cwd: ctx.cwd });
    return r.code === 0 ? r.stdout.trim() : "";
  }

  // `--git-common-dir`/`--show-toplevel` may be relative; resolve against cwd so basename/dirname are stable.
  const resolve = (p: string) => (p && p.startsWith("/") ? p : p ? `${ctx.cwd}/${p}` : "");
  const commonAbs = resolve(await git(["rev-parse", "--git-common-dir"]));
  let repo = "";
  if (commonAbs) {
    const base = basename(commonAbs);
    repo = base === ".git" ? basename(dirname(commonAbs)) : base.replace(/\.git$/, "");
  }
  const toplevel = resolve(await git(["rev-parse", "--show-toplevel"]));
  const worktree = toplevel ? basename(toplevel) : "";

  return { repo, worktree };
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("geist", {
    description: "Run a poltergeist workflow: /geist <workflow> [key=value]...",
    handler: async (args, ctx) => {
      const bin = await resolveGeistBinary(pi);
      if (!bin) {
        ctx.ui.notify("geist/poltergeist not found on PATH", "error");
        return;
      }

      const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
      if (tokens.length === 0) {
        ctx.ui.notify("Usage: /geist <workflow> [key=value]...", "error");
        return;
      }
      const workflow = tokens[0];

      // Parse trailing key=value tokens (first `=` splits; later `=` stays in the value).
      const userPairs: Array<[string, string]> = [];
      for (const t of tokens.slice(1)) {
        const eq = t.indexOf("=");
        if (eq <= 0) {
          ctx.ui.notify(`Bad param "${t}": expected key=value`, "error");
          return;
        }
        userPairs.push([t.slice(0, eq), t.slice(eq + 1)]);
      }

      ctx.ui.setStatus("geist", `Running geist ${workflow}…`);

      const { repo, worktree } = await gitInfo(pi, ctx);
      // Auto context for every workflow; geist errors on undeclared params, so
      // workflows must declare repo/worktree (with default: "") if they don't
      // interpolate them.
      const merged = new Map<string, string>();
      if (repo) merged.set(REPO_PARAM, repo);
      if (worktree) merged.set(WORKTREE_PARAM, worktree);

      const isFork = workflow === FORK_WORKFLOW;

      // geist treats each argv element after `--` as a separate panel's command
      // and shell-splits it internally, so a multi-token command must be passed
      // as a single, properly shell-quoted string (else one panel per token).
      const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
      let sourceSession: string | undefined;
      if (isFork) {
        sourceSession = ctx.sessionManager.getSessionFile() ?? undefined;
        if (!sourceSession) {
          ctx.ui.setStatus("geist", undefined);
          ctx.ui.notify("No persistent session to fork", "error");
          return;
        }
        merged.set(SESSION_PARAM, sourceSession);
      }

      // User params override auto context.
      for (const [k, v] of userPairs) merged.set(k, v);

      const upArgs = [
        "up",
        workflow,
        ...[...merged].flatMap(([k, v]) => ["--param", `${k}=${v}`]),
      ];
      const result = await pi.exec(bin, upArgs, { timeout: 30_000, cwd: ctx.cwd });

      if (result.code === 0) {
        ctx.ui.setStatus("geist", undefined);
        ctx.ui.notify(`geist ${workflow} OK`, "info");
        return;
      }

      // fork workflow fallback: single-pane tab if the workflow isn't defined.
      // geist writes `error:` lines to stdout, so inspect both streams.
      const combinedOut = `${result.stdout}\n${result.stderr}`;
      if (isFork && combinedOut.includes(`workflow '${FORK_WORKFLOW}' not found`)) {
        const name = merged.get(NAME_PARAM);
        if (!name) {
          ctx.ui.setStatus("geist", undefined);
          ctx.ui.notify(
            `No 'fork' workflow defined; pass ${NAME_PARAM}=... for the single-pane fallback`,
            "error",
          );
          return;
        }
        const fallbackArgs = [
          "up",
          "--name",
          name,
          "--",
          `pi --fork ${shellQuote(sourceSession!)} --name ${shellQuote(name)}`,
        ];
        const fr = await pi.exec(bin, fallbackArgs, { timeout: 30_000, cwd: ctx.cwd });
        ctx.ui.setStatus("geist", undefined);
        if (fr.code === 0) {
          ctx.ui.notify(`Forked "${name}" into a new tab (single pane)`, "info");
          return;
        }
        ctx.ui.notify(`geist up failed: ${fr.stdout.trim() || fr.stderr.trim()}`, "error");
        return;
      }

      ctx.ui.setStatus("geist", undefined);
      ctx.ui.notify(`geist ${workflow} failed: ${result.stdout.trim() || result.stderr.trim()}`, "error");
    },
  });
}
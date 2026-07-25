// skill-policy: a project-level allow/deny policy for Pi skills.
//
// Controls which discovered skills are visible to the model and which
// `/skill:name` commands a user may invoke. It does not alter skill discovery
// or inspect skill contents.
//
// Policy files live at `<project-root>/.pi/skill-allowlist` and
// `<project-root>/.pi/skill-denylist` (using Pi's CONFIG_DIR_NAME). The
// project root is the nearest ancestor containing `.git`, falling back to
// the cwd. Each non-empty, non-comment line is one skill identifier (a skill
// name or a path: absolute, `~/`-prefixed, or project-relative). A deny match
// wins over an allow match. When neither file has any entry every skill is
// allowed (initial Pi behavior); once either file lists anything, skills not
// matched by it are "unclassified" and blocked.
//
// Commands:
//   /skill-policy          review unclassified skills (or all loaded skills
//                          when no policy exists yet) and classify each
//   /skill-policy status   report allowed / denied / unclassified counts

import {
  CONFIG_DIR_NAME,
  formatSkillsForPrompt,
  type ExtensionAPI,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const ALLOWLIST = "skill-allowlist";
const DENYLIST = "skill-denylist";
const SKILL_PREFIX = "skill:";
// Matches the exact block `formatSkillsForPrompt` emits so we can strip it
// before reinserting a policy-filtered version.
const SKILLS_BLOCK_RE = /\n\nThe following skills provide specialized instructions[\s\S]*?<\/available_skills>/;
const CWD_TAIL_RE = /\nCurrent working directory: [^\n]*$/;

// Idempotency marker for the private-API startup-resource patch.
const PATCHED = Symbol.for("skill-policy.showLoadedResources.patched");

type ClassState = "allow" | "deny" | "unclassified";

interface SkillLite {
  name: string;
  description?: string;
  filePath: string;
  baseDir: string;
}

interface Policy {
  allow: Set<string>;
  deny: Set<string>;
  // True once either file contains at least one identifier; before that all
  // skills are permitted to preserve default Pi behavior.
  explicit: boolean;
}

// ---------------------------------------------------------------------------
// Project root + path helpers
// ---------------------------------------------------------------------------

function findProjectRoot(cwd: string): string {
  let dir = cwd;
  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return cwd;
}

// Normalize a single identifier: forward-slash separators, no leading `./`,
// no trailing `/`. Expands `~/` to the home directory so path identifiers
// canonicalize to absolute form for matching.
function normalizeIdent(raw: string, home: string): string {
  let id = raw.trim().replace(/\\/g, "/");
  if (id.startsWith("~/")) id = path.join(home, id.slice(2)).replace(/\\/g, "/");
  return id.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
}

function policyPath(projectRoot: string, file: string): string {
  return path.join(projectRoot, CONFIG_DIR_NAME, file);
}

// ---------------------------------------------------------------------------
// Policy file IO
// ---------------------------------------------------------------------------

function parsePolicyFile(content: string, home: string): Set<string> {
  const set = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const id = normalizeIdent(trimmed, home);
    if (id) set.add(id);
  }
  return set;
}

function createPolicy(allow: Set<string>, deny: Set<string>): Policy {
  return { allow, deny, explicit: allow.size > 0 || deny.size > 0 };
}

function readPolicySync(projectRoot: string, home: string): Policy {
  function read(file: string): Set<string> {
    try {
      return parsePolicyFile(fs.readFileSync(policyPath(projectRoot, file), "utf8"), home);
    } catch {
      return new Set<string>(); // missing policy file = empty set
    }
  }
  return createPolicy(read(ALLOWLIST), read(DENYLIST));
}

async function readPolicy(projectRoot: string, home: string): Promise<Policy> {
  async function read(file: string): Promise<Set<string>> {
    try {
      return parsePolicyFile(await fsp.readFile(policyPath(projectRoot, file), "utf8"), home);
    } catch {
      return new Set<string>(); // missing policy file = empty set
    }
  }
  const [allow, deny] = await Promise.all([read(ALLOWLIST), read(DENYLIST)]);
  return createPolicy(allow, deny);
}

// The full set of identifiers under which a skill is recognized in the policy
// files (its name plus several path representations).
function skillIdentifiers(skill: SkillLite, projectRoot: string, home: string): Set<string> {
  const ids = new Set<string>([skill.name]);
  const homePrefix = home + "/";
  const rootPrefix = projectRoot.replace(/\\/g, "/") + "/";

  for (const rawPath of [skill.filePath, skill.baseDir]) {
    const p = rawPath.replace(/\\/g, "/");
    ids.add(p);
    if (p.startsWith(homePrefix)) ids.add("~/" + p.slice(homePrefix.length));
    if (p.startsWith(rootPrefix)) ids.add(p.slice(rootPrefix.length));
  }
  return ids;
}

function classify(skill: SkillLite, policy: Policy, projectRoot: string, home: string): ClassState {
  const ids = skillIdentifiers(skill, projectRoot, home);
  for (const id of ids) if (policy.deny.has(id)) return "deny";
  for (const id of ids) if (policy.allow.has(id)) return "allow";
  return "unclassified";
}

function isAllowed(skill: SkillLite, policy: Policy, projectRoot: string, home: string): boolean {
  return classify(skill, policy, projectRoot, home) === "allow";
}

// ---------------------------------------------------------------------------
// Skill catalog: reconstruct skill list from pi.getCommands() when the
// structured system-prompt skills are not available.
// ---------------------------------------------------------------------------

function reconstructSkills(pi: ExtensionAPI): SkillLite[] {
  const skills: SkillLite[] = [];
  for (const cmd of pi.getCommands()) {
    if (cmd.source !== "skill") continue;
    const filePath = cmd.sourceInfo?.path ?? "";
    if (!filePath) continue;
    const name = cmd.name.startsWith(SKILL_PREFIX) ? cmd.name.slice(SKILL_PREFIX.length) : cmd.name;
    const baseDir = cmd.sourceInfo?.baseDir ?? path.dirname(filePath);
    skills.push({ name, description: cmd.description, filePath, baseDir });
  }
  return skills;
}

function acquireSkills(pi: ExtensionAPI, getOptsSkills?: () => Skill[] | undefined): SkillLite[] {
  const opts = getOptsSkills?.();
  if (opts && opts.length > 0) {
    return opts.map((s) => ({ name: s.name, description: s.description, filePath: s.filePath, baseDir: s.baseDir }));
  }
  return reconstructSkills(pi);
}

// ---------------------------------------------------------------------------
// Policy write: move a skill to a list (mutual exclusion).
// ---------------------------------------------------------------------------

async function moveSkill(skill: SkillLite, list: "allow" | "deny", projectRoot: string, home: string): Promise<void> {
  const ids = skillIdentifiers(skill, projectRoot, home);

  const keepLine = (raw: string): boolean => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) return true;
    return !ids.has(normalizeIdent(trimmed, home));
  };

  const dir = path.join(projectRoot, CONFIG_DIR_NAME);
  await fsp.mkdir(dir, { recursive: true });

  async function rewrite(file: string, appendCanonical: boolean): Promise<void> {
    const filePath = policyPath(projectRoot, file);
    let content = "";
    try { content = await fsp.readFile(filePath, "utf8"); } catch { /* nonexistent */ }
    const kept = content.split(/\r?\n/).filter(keepLine);
    if (appendCanonical) {
      if (kept.length > 0 && kept[kept.length - 1].trim() !== "") kept.push("");
      kept.push(skill.name);
    }
    const body = kept.join("\n").replace(/\s+$/, "") + "\n"; // single trailing newline
    await fsp.writeFile(filePath, body, "utf8");
  }

  await Promise.all([
    rewrite(ALLOWLIST, list === "allow"),
    rewrite(DENYLIST, list === "deny"),
  ]);
}

// ---------------------------------------------------------------------------
// Startup resource filtering (private API: InteractiveMode.showLoadedResources)
// ---------------------------------------------------------------------------

async function patchStartupResourceFilter(): Promise<void> {
  const mod: any = await import("@earendil-works/pi-coding-agent");
  const InteractiveMode = mod.InteractiveMode as { prototype: any } | undefined;
  if (!InteractiveMode) return;
  const proto = InteractiveMode.prototype;
  if (!proto || proto[PATCHED]) return;

  const original = proto.showLoadedResources;
  if (typeof original !== "function") return;

  proto.showLoadedResources = function (this: any, options: any) {
    const session = this.session;
    const loader = session?.resourceLoader;
    const cwd = this.sessionManager?.getCwd?.() ?? session?.cwd;
    if (!loader || typeof loader.getSkills !== "function" || !cwd) {
      return original.call(this, options);
    }
    const home = os.homedir();
    const projectRoot = findProjectRoot(cwd);
    const policy = readPolicySync(projectRoot, home);
    const all = loader.getSkills();
    const skills = policy.explicit
      ? all.skills.filter((s: SkillLite) => isAllowed(s, policy, projectRoot, home))
      : all.skills;
    loader.getSkills = () => ({ skills, diagnostics: all.diagnostics });
    try {
      return original.call(this, options);
    } finally {
      delete loader.getSkills;
    }
  };
  proto.showLoadedResources[PATCHED] = true;
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerCommand("skill-policy", {
    description: "Manage the project skill allow/deny policy: /skill-policy [status]",
    handler: async (args, ctx) => {
      const home = os.homedir();
      const projectRoot = findProjectRoot(ctx.cwd);
      const sub = (args ?? "").trim();

      const skills = acquireSkills(pi, () => ctx.getSystemPromptOptions?.().skills as Skill[] | undefined);
      const policy = await readPolicy(projectRoot, home);
      const classified = skills.map((s) => ({
        skill: s,
        state: classify(s, policy, projectRoot, home),
      }));

      const unclassified = classified.filter((c) => c.state === "unclassified");
      const deniedCount = classified.filter((c) => c.state === "deny").length;
      // Without an explicit policy every loaded skill counts as allowed.
      const allowedCount = policy.explicit
        ? classified.filter((c) => c.state === "allow").length
        : classified.length;

      if (sub === "status") {
        const msg = policy.explicit
          ? `Skills: ${allowedCount} allowed, ${deniedCount} denied, ${unclassified.length} unclassified`
          : `Skills: ${skills.length} loaded (no policy configured — all allowed). Run /skill-policy to review and classify them.`;
        ctx.ui.notify(msg, "info");
        return;
      }

      // Default action: review skills sequentially via the UI.
      //
      //   - No policy configured yet: review every loaded skill so the user
      //     can bootstrap the allow/deny lists from inside pi. The first
      //     allow/deny decision makes the policy explicit; any skill the
      //     user skips or postpones becomes unclassified (blocked) and will
      //     surface again on the next /skill-policy run.
      //   - Policy already configured: review only unclassified skills.
      if (!ctx.hasUI) {
        ctx.ui.notify("skill-policy review requires an interactive UI", "warning");
        return;
      }
      const reviewSet = policy.explicit ? unclassified.map((c) => c.skill) : skills;
      if (reviewSet.length === 0) {
        ctx.ui.notify(`Nothing to review. ${allowedCount} allowed, ${deniedCount} denied.`, "info");
        return;
      }
      if (!policy.explicit) {
        ctx.ui.notify(
          `No policy configured — reviewing all ${skills.length} skill(s). The first decision enables the policy; skipped skills become unclassified.`,
          "info",
        );
      }

      for (const skill of reviewSet) {
        const choice = await ctx.ui.select(
          `Skill "${skill.name}": ${skill.description ?? "(no description)"}`,
          ["deny", "allow", "skip", "stop"],
        );
        if (!choice || choice === "stop") {
          ctx.ui.notify("Skill policy review stopped.", "info");
          return;
        }
        if (choice === "skip") continue;
        try {
          await moveSkill(skill, choice as "allow" | "deny", projectRoot, home);
          ctx.ui.notify(`"${skill.name}" ${choice === "allow" ? "allowed" : "denied"}.`, "info");
        } catch (err) {
          ctx.ui.notify(
            `Failed to persist policy: ${err instanceof Error ? err.message : String(err)}`,
            "error",
          );
          return;
        }
      }
      ctx.ui.notify("Skill policy review complete.", "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    // Layer an autocomplete provider that hides non-allowed skill commands.
    const home = os.homedir();
    const projectRoot = findProjectRoot(ctx.cwd);

    ctx.ui.addAutocompleteProvider((current) => ({
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const res = await current.getSuggestions(lines, cursorLine, cursorCol, options);
        if (!res) return res;
        // Rebuild the catalog on every query so skills contributed later
        // (e.g. via resources_discover) are not silently hidden.
        const catalog = new Map<string, SkillLite>();
        for (const s of reconstructSkills(pi)) catalog.set(s.name, s);
        const policy = await readPolicy(projectRoot, home);
        const items = res.items.filter((item) => {
          if (!item.value.startsWith(SKILL_PREFIX)) return true;
          const name = item.value.slice(SKILL_PREFIX.length);
          const skill = catalog.get(name);
          if (!skill) return false; // unknown / not a recognized skill
          return !policy.explicit || isAllowed(skill, policy, projectRoot, home);
        });
        return { ...res, items };
      },
      applyCompletion(...a: Parameters<typeof current.applyCompletion>) {
        return current.applyCompletion(...a);
      },
      shouldTriggerFileCompletion(...a: Parameters<NonNullable<typeof current.shouldTriggerFileCompletion>>) {
        return current.shouldTriggerFileCompletion?.(...a) ?? true;
      },
    }));

    // Patch the interactive mode's startup resource list (private API).
    await patchStartupResourceFilter();
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };
    const text = event.text.trim();
    if (!text.startsWith("/" + SKILL_PREFIX)) return { action: "continue" };

    const [command] = text.slice(1).split(/\s+/); // first token after the "/"
    if (command.length <= SKILL_PREFIX.length) return { action: "continue" };
    const skillName = command.slice(SKILL_PREFIX.length);

    const home = os.homedir();
    const projectRoot = findProjectRoot(ctx.cwd);
    const skills = reconstructSkills(pi);
    const skill = skills.find((s) => s.name === skillName);

    if (!skill) {
      if (ctx.hasUI) ctx.ui.notify(`/skill:${skillName} not found; invocation blocked.`, "warning");
      return { action: "handled" };
    }

    const policy = await readPolicy(projectRoot, home);
    const state = classify(skill, policy, projectRoot, home);
    if (!policy.explicit || state === "allow") return { action: "continue" };

    const reason = state === "deny" ? "denied" : "unclassified (blocked until allowed)";
    if (ctx.hasUI) ctx.ui.notify(`/skill:${skillName} is ${reason} by skill-policy.`, "warning");
    return { action: "handled" };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const home = os.homedir();
    const projectRoot = findProjectRoot(ctx.cwd);
    const policy = await readPolicy(projectRoot, home);
    if (!policy.explicit) return; // preserve default Pi behavior

    const allSkills: Skill[] = event.systemPromptOptions.skills ?? [];
    if (allSkills.length === 0) return;

    const allowed = allSkills.filter((s) => isAllowed(s, policy, projectRoot, home));

    const selectedTools = event.systemPromptOptions.selectedTools;
    const readActive = !selectedTools || selectedTools.includes("read");

    const prompt = event.systemPrompt.replace(SKILLS_BLOCK_RE, "");
    if (!readActive || allowed.length === 0) return { systemPrompt: prompt };
    return { systemPrompt: prompt.replace(CWD_TAIL_RE, `${formatSkillsForPrompt(allowed)}$&`) };
  });
}
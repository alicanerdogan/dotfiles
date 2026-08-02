import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluatePath, expandPath, gitCheckIgnore, isOutsideScope, isSkillPath, matchesRule, realResolve, scopeDecision } from "./paths.ts";
import type { PathRule } from "./config.ts";

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(import.meta.dirname, ".test-tmp-"));
  tmpDirs.push(dir);
  return dir;
}
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const R = (action: PathRule["action"], path: string, kind: PathRule["kind"] = "file"): PathRule => ({ action, kind, path });

describe("expandPath", () => {
  it("expands ~ and resolves relatives against cwd", () => {
    const opts = { cwd: "/repo", home: "/home/u" };
    assert.equal(expandPath("~/keys", opts), "/home/u/keys");
    assert.equal(expandPath("~", opts), "/home/u");
    assert.equal(expandPath("./x", opts), "/repo/x");
    assert.equal(expandPath("/etc/hosts", opts), "/etc/hosts");
  });
});

describe("matchesRule", () => {
  const opts = { cwd: "/repo", home: "/home/u" };
  it("file kind is exact", () => {
    assert.ok(matchesRule(R("allow", "./x"), "/repo/x", opts));
    assert.ok(!matchesRule(R("allow", "./x"), "/repo/x/y", opts));
  });
  it("directory kind is recursive (dir + descendants)", () => {
    assert.ok(matchesRule(R("allow", "~/repos", "directory"), "/home/u/repos", opts));
    assert.ok(matchesRule(R("allow", "~/repos", "directory"), "/home/u/repos/alicancodes/lib/a.ts", opts));
    assert.ok(!matchesRule(R("allow", "~/repos", "directory"), "/home/u/repositorio", opts));
  });
  it("~ matches the home root itself", () => {
    assert.ok(matchesRule(R("deny", "~", "directory"), "/home/u", opts));
  });
});

describe("scopeDecision — safest matching action wins", () => {
  it("deny > ask > allow; null when nothing matches", () => {
    assert.equal(scopeDecision([R("allow", "./a"), R("ask", "./a"), R("deny", "./a")])?.decision, "deny");
    assert.equal(scopeDecision([R("allow", "./a"), R("ask", "./a")])?.decision, "ask");
    assert.equal(scopeDecision([R("allow", "./a")])?.decision, "allow");
    assert.equal(scopeDecision([]), null);
  });
});

describe("isOutsideScope / realResolve", () => {
  it("detects .. traversal and siblings", () => {
    assert.ok(!isOutsideScope("/repo/lib", "/repo"));
    assert.ok(isOutsideScope("/other", "/repo"));
    assert.ok(isOutsideScope("/repo2", "/repo"));
    assert.ok(isOutsideScope("/", "/repo"));
  });

  it("realResolve follows symlinks (escape detection)", () => {
    const dir = tmp();
    mkdirSync(join(dir, "inside"));
    mkdirSync(join(dir, "outside"));
    symlinkSync(join(dir, "outside"), join(dir, "inside", "link"));
    writeFileSync(join(dir, "outside", "f.txt"), "x");
    assert.equal(realResolve(join(dir, "inside", "link", "f.txt")), join(dir, "outside", "f.txt"));
    // missing tail is re-appended
    assert.equal(realResolve(join(dir, "inside", "link", "new.txt")), join(dir, "outside", "new.txt"));
  });
});

describe("isSkillPath", () => {
  const opts = { cwd: "/repo", home: "/home/u" };

  it("true under any directory literally named skills (all discovery roots)", () => {
    assert.ok(isSkillPath("~/.pi/agent/skills/frontend-design/SKILL.md", opts));
    assert.ok(isSkillPath("~/.agents/skills/x/SKILL.md", opts));
    assert.ok(isSkillPath("./.pi/skills/learn-codebase/README.md", opts));
    assert.ok(isSkillPath("/repo/node_modules/pkg/skills/x/SKILL.md", opts));
    assert.ok(isSkillPath("/repo/local/skills", opts));
    assert.ok(isSkillPath("skills/add-mcp-server/SKILL.md", opts)); // relative, resolved against cwd
  });

  it("false outside skills directories", () => {
    assert.ok(!isSkillPath("~/.pi/agent/AGENTS.md", opts));
    assert.ok(!isSkillPath("./src/index.ts", opts));
    assert.ok(!isSkillPath("/usr/bin/skillset", opts), "segment must be exactly 'skills'");
    assert.ok(!isSkillPath("/etc/hosts", opts));
  });
});

describe("evaluatePath — scope precedence and hard defaults", () => {
  const cwd = "/repo";
  const home = "/home/u";
  const notIgnored = async () => false;

  it("project rules overrule global rules", async () => {
    const project = [R("allow", "./x")];
    const global = [R("deny", "./x")];
    const e = await evaluatePath("./x", { cwd, home, project, global, gitIgnoreCheck: notIgnored });
    assert.equal(e.decision, "allow");
    assert.equal(e.scope, "project");
  });

  it("falls back to global rules when no project rule matches", async () => {
    const e = await evaluatePath("./x", { cwd, home, project: [], global: [R("deny", "./x")], gitIgnoreCheck: notIgnored });
    assert.equal(e.decision, "deny");
    assert.equal(e.scope, "global");
  });

  it("ask rule prompts (decision ask)", async () => {
    const e = await evaluatePath("./x", { cwd, home, project: [R("ask", "./x")], global: [], gitIgnoreCheck: notIgnored });
    assert.equal(e.decision, "ask");
  });

  it("hard default: inside cwd + not ignored + no rule → allow", async () => {
    const e = await evaluatePath("./x", { cwd, home, project: [], global: [], gitIgnoreCheck: notIgnored });
    assert.equal(e.decision, "allow");
    assert.equal(e.scope, "default");
  });

  it("hard default: outside cwd → deny, no gitignore consult", async () => {
    let consulted = false;
    const e = await evaluatePath("/etc/hosts", {
      cwd,
      home,
      project: [],
      global: [],
      gitIgnoreCheck: async () => {
        consulted = true;
        return true;
      },
    });
    assert.equal(e.decision, "deny");
    assert.equal(e.scope, "default");
    assert.equal(e.outside, true);
    assert.equal(consulted, false, "outside paths skip the gitignore check");
  });

  it("hard default: gitignored file → deny; allow rule overrides", async () => {
    const e = await evaluatePath("./dist/x.js", { cwd, home, project: [], global: [], gitIgnoreCheck: async () => true });
    assert.equal(e.decision, "deny");
    assert.equal(e.gitIgnored, true);
    const a = await evaluatePath("./dist/x.js", { cwd, home, project: [R("allow", "./dist", "directory")], global: [], gitIgnoreCheck: async () => true });
    assert.equal(a.decision, "allow");
  });

  it("realResolve-based boundary catches symlink escapes inside cwd", async () => {
    const dir = tmp();
    mkdirSync(join(dir, "repo"));
    mkdirSync(join(dir, "elsewhere"));
    symlinkSync(join(dir, "elsewhere"), join(dir, "repo", "link"));
    const e = await evaluatePath("./link/f.txt", { cwd: join(dir, "repo"), home, project: [], global: [], gitIgnoreCheck: notIgnored });
    assert.equal(e.decision, "deny");
    assert.equal(e.outside, true);
  });
});

describe("gitCheckIgnore", () => {
  it("returns false outside a git repo (never throws)", async () => {
    const dir = tmp();
    assert.equal(await gitCheckIgnore(join(dir, "x"), dir), false);
  });
});

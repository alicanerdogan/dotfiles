/**
 * tree-sitter-bash parse contract spike (pi-immunity, todo P0-1).
 *
 * Spawns the real `tree-sitter` CLI over the fixture set in ./fixtures and
 * asserts the S-expression AST shapes that the immunity matchers will rely on.
 *
 * The fixtures are inert text — parse-only, never executed.
 *
 * Run from repo root: node --test "pi/extensions/immunity/spikes/tree-sitter-bash/*.test.ts"
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BIN = process.env.IMMUNITY_TS_BIN ?? "tree-sitter";
const HOME = homedir();
const LIB_CANDIDATES = [
  process.env.IMMUNITY_TS_LIB,
  join(HOME, ".config/tree-sitter/lib/bash.dylib"),
  join(HOME, ".cache/tree-sitter/lib/bash.dylib"),
].filter(Boolean) as string[];
const GRAMMAR_DIR = join(HOME, ".config/tree-sitter/tree-sitter-bash");
const FIXTURES = join(import.meta.dirname, "fixtures");

/* ------------------------------------------------------------------ */
/* Minimal S-expression parser for `tree-sitter parse` output         */
/* ------------------------------------------------------------------ */

interface Position { row: number; col: number }
interface SNode {
  type: string;
  field: string | null;
  start: Position;
  end: Position;
  children: SNode[];
}

type Token =
  | { kind: "lparen" } | { kind: "rparen" } | { kind: "dash" }
  | { kind: "pos"; row: number; col: number }
  | { kind: "ident"; value: string; isField: boolean };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  const re = /(\()|(\))|\[(\d+),\s*(\d+)\]|(-)|([A-Za-z_][A-Za-z0-9_.-]*)(:)?/g;
  for (const m of src.matchAll(re)) {
    if (m[1]) tokens.push({ kind: "lparen" });
    else if (m[2]) tokens.push({ kind: "rparen" });
    else if (m[3]) tokens.push({ kind: "pos", row: +m[3], col: +m[4] });
    else if (m[5]) tokens.push({ kind: "dash" });
    else tokens.push({ kind: "ident", value: m[6], isField: !!m[7] });
  }
  return tokens;
}

function parseSexpr(src: string): SNode {
  const tokens = tokenize(src);
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];

  // node ::= '(' type pos '-' pos children* ')'   (field prefix handled by caller)
  function parseNode(field: string | null): SNode {
    const open = next();
    if (open.kind !== "lparen") throw new Error(`expected '(' at token ${i - 1}`);
    const typeTok = next();
    if (typeTok.kind !== "ident" || typeTok.isField) {
      throw new Error(`expected node type at token ${i - 1}`);
    }
    const startTok = next();
    if (startTok.kind !== "pos") throw new Error(`expected start position at token ${i - 1}`);
    const dash = next();
    if (dash.kind !== "dash") throw new Error(`expected '-' at token ${i - 1}`);
    const endTok = next();
    if (endTok.kind !== "pos") throw new Error(`expected end position at token ${i - 1}`);

    const node: SNode = {
      type: typeTok.value,
      field,
      start: { row: startTok.row, col: startTok.col },
      end: { row: endTok.row, col: endTok.col },
      children: [],
    };

    for (;;) {
      const t = peek();
      if (t.kind === "rparen") {
        next();
        return node;
      }
      if (t.kind === "ident" && t.isField) {
        const childField = (next() as { value: string }).value;
        if (peek().kind !== "lparen") {
          throw new Error(`expected '(' after field '${childField}' at token ${i}`);
        }
        node.children.push(parseNode(childField));
      } else if (t.kind === "lparen") {
        node.children.push(parseNode(null));
      } else {
        throw new Error(`unexpected token at ${i}: ${JSON.stringify(t)}`);
      }
    }
  }

  const root = parseNode(null);
  if (i !== tokens.length) throw new Error(`trailing tokens after root (${tokens.length - i})`);
  return root;
}

/* ------------------------------------------------------------------ */
/* Tree helpers                                                        */
/* ------------------------------------------------------------------ */

function nodeText(node: SNode, source: string): string {
  const lines = source.split("\n");
  if (node.start.row === node.end.row) {
    return lines[node.start.row].slice(node.start.col, node.end.col);
  }
  const parts = [lines[node.start.row].slice(node.start.col)];
  for (let r = node.start.row + 1; r < node.end.row; r++) parts.push(lines[r]);
  parts.push(lines[node.end.row].slice(0, node.end.col));
  return parts.join("\n");
}

function findNodes(node: SNode, type: string): SNode[] {
  const out: SNode[] = [];
  for (const child of node.children) {
    if (child.type === type) out.push(child);
    out.push(...findNodes(child, type));
  }
  return out;
}

function commandNameText(command: SNode, source: string): string {
  const name = command.children.find((c) => c.type === "command_name");
  assert.ok(name, "command has command_name");
  return nodeText(name.children[0], source);
}

function commandArgs(command: SNode, source: string): string[] {
  return command.children
    .filter((c) => ["word", "string", "raw_string", "number"].includes(c.type))
    .map((c) => nodeText(c, source));
}

/** Strip the stats line the CLI appends to stdout on parse errors. */
function cleanStdout(raw: string): string {
  return raw.split("\n").filter((l) => !/\tParse:/.test(l)).join("\n");
}

/* ------------------------------------------------------------------ */
/* Test setup                                                          */
/* ------------------------------------------------------------------ */

interface ParseResult {
  root: SNode;
  source: string;
  status: number | null;
  stderr: string;
}

function parseFile(file: string, args: string[]): ParseResult {
  const res = spawnSync(BIN, [...args, join(FIXTURES, file)], { encoding: "utf8" });
  if (res.error) throw res.error;
  const source = readFileSync(join(FIXTURES, file), "utf8");
  return { root: parseSexpr(cleanStdout(res.stdout)), source, status: res.status, stderr: res.stderr };
}

function resolveMode(): { args: string[]; note: string } | null {
  const lib = LIB_CANDIDATES.find((p) => existsSync(p));
  if (lib) return { args: ["parse", "-l", lib], note: `dylib ${lib}` };
  if (existsSync(GRAMMAR_DIR)) return { args: ["parse", "-p", GRAMMAR_DIR], note: `grammar ${GRAMMAR_DIR}` };
  return null;
}

interface Fixture {
  file: string;
  title: string;
  check: (p: ParseResult) => void;
}

const FIXTURE_TESTS: Fixture[] = [
  {
    file: "01-rm-rf.sh",
    title: "rm -rf: command with name + short flag + path args",
    check(p) {
      const [cmd] = findNodes(p.root, "command");
      assert.equal(commandNameText(cmd, p.source), "rm");
      assert.deepEqual(commandArgs(cmd, p.source), ["-rf", "/var/tmp/foo"]);
      assert.equal(findNodes(p.root, "ERROR").length, 0);
    },
  },
  {
    file: "02-rm-grouped-flags.sh",
    title: "grouped short flags (-rfv) stay a single word arg",
    check(p) {
      const [cmd] = findNodes(p.root, "command");
      assert.equal(commandNameText(cmd, p.source), "rm");
      // Matcher implication: flag clusters need prefix matching (-rf*), not exact word match.
      assert.deepEqual(commandArgs(cmd, p.source), ["-rfv", "/tmp/x"]);
    },
  },
  {
    file: "03-rm-long-flags.sh",
    title: "long flags are separate exact-match word args",
    check(p) {
      const [cmd] = findNodes(p.root, "command");
      assert.deepEqual(commandArgs(cmd, p.source), ["--recursive", "--force", "/tmp/x"]);
    },
  },
  {
    file: "04-curl-pipe-sh.sh",
    title: "curl | sh is a pipeline of two commands",
    check(p) {
      const [pipe] = findNodes(p.root, "pipeline");
      const cmds = pipe.children.filter((c) => c.type === "command");
      assert.equal(cmds.length, 2);
      assert.equal(commandNameText(cmds[0], p.source), "curl");
      assert.equal(commandNameText(cmds[1], p.source), "sh");
    },
  },
  {
    file: "05-curl-pipe-bash.sh",
    title: "curl | bash is a pipeline of two commands",
    check(p) {
      const [pipe] = findNodes(p.root, "pipeline");
      const cmds = pipe.children.filter((c) => c.type === "command");
      assert.equal(commandNameText(cmds[1], p.source), "bash");
    },
  },
  {
    file: "06-redirect-ssh.sh",
    title: "redirect to ~/.ssh/authorized_keys exposes destination word",
    check(p) {
      const [rs] = findNodes(p.root, "redirected_statement");
      const redirect = rs.children.find((c) => c.field === "redirect");
      assert.equal(redirect?.type, "file_redirect");
      const dest = redirect?.children.find((c) => c.field === "destination");
      assert.equal(nodeText(dest!, p.source), "~/.ssh/authorized_keys");
    },
  },
  {
    file: "07-sudo-mkfs.sh",
    title: "sudo command exposes the elevated command as first arg",
    check(p) {
      const [cmd] = findNodes(p.root, "command");
      assert.equal(commandNameText(cmd, p.source), "sudo");
      assert.deepEqual(commandArgs(cmd, p.source), ["mkfs.ext4", "/dev/sdb1"]);
    },
  },
  {
    file: "08-dd-disk.sh",
    title: "dd to a device: of= operand is a plain word",
    check(p) {
      const [cmd] = findNodes(p.root, "command");
      assert.equal(commandNameText(cmd, p.source), "dd");
      assert.deepEqual(commandArgs(cmd, p.source), ["if=/dev/zero", "of=/dev/disk2", "bs=1m"]);
    },
  },
  {
    file: "09-chmod-R.sh",
    title: "chmod -R: flag and mode are separate args",
    check(p) {
      const [cmd] = findNodes(p.root, "command");
      assert.equal(commandNameText(cmd, p.source), "chmod");
      assert.deepEqual(commandArgs(cmd, p.source), ["-R", "777", "/var/www"]);
    },
  },
  {
    file: "10-quote-double.sh",
    title: "double-quoted path with space is one string arg",
    check(p) {
      const [cmd] = findNodes(p.root, "command");
      const args = cmd.children.filter((c) => ["word", "string"].includes(c.type));
      assert.equal(args[1]?.type, "string");
      assert.equal(nodeText(args[1], p.source), '"/tmp/my dir"');
    },
  },
  {
    file: "11-quote-single.sh",
    title: "single-quoted path with space is one raw_string arg",
    check(p) {
      const [cmd] = findNodes(p.root, "command");
      const args = cmd.children.filter((c) => ["word", "raw_string"].includes(c.type));
      assert.equal(args[1]?.type, "raw_string");
      assert.equal(nodeText(args[1], p.source), "'/tmp/x y'");
    },
  },
  {
    file: "12-quote-escaped.sh",
    title: "escaped space stays one word arg (escape preserved in text)",
    check(p) {
      const [cmd] = findNodes(p.root, "command");
      assert.equal(commandNameText(cmd, p.source), "rm");
      const args = cmd.children.filter((c) => c.type === "word");
      assert.deepEqual(args.map((a) => nodeText(a, p.source)), ["-rf", "/tmp/a\\ b"]);
    },
  },
  {
    file: "13-git-force-with-lease.sh",
    title: "git push --force-with-lease: subcommand + flag as args",
    check(p) {
      const [cmd] = findNodes(p.root, "command");
      assert.equal(commandNameText(cmd, p.source), "git");
      assert.deepEqual(commandArgs(cmd, p.source), ["push", "--force-with-lease"]);
    },
  },
  {
    file: "14-benign-cat.sh",
    title: "benign command parses cleanly with no ERROR nodes",
    check(p) {
      const [cmd] = findNodes(p.root, "command");
      assert.equal(commandNameText(cmd, p.source), "cat");
      assert.deepEqual(commandArgs(cmd, p.source), ["/etc/passwd"]);
      assert.equal(findNodes(p.root, "ERROR").length, 0);
    },
  },
  {
    file: "15-unterminated-string.sh",
    title: "unterminated string: ERROR node + exit 1, tree still walkable",
    check(p) {
      assert.equal(p.status, 1);
      assert.ok(findNodes(p.root, "ERROR").length > 0);
      // The `echo` command before the error is still parsed.
      assert.equal(findNodes(p.root, "command").length, 1);
    },
  },
  {
    file: "16-invalid-if.sh",
    title: "invalid syntax: ERROR node + exit 1",
    check(p) {
      assert.equal(p.status, 1);
      assert.ok(findNodes(p.root, "ERROR").length > 0);
    },
  },
];

/* ------------------------------------------------------------------ */
/* The spike test                                                      */
/* ------------------------------------------------------------------ */

describe("tree-sitter-bash parse contract (pi-immunity spike)", () => {
  const mode = resolveMode();
  const skipReason = !mode
    ? "no tree-sitter bash grammar found — run: tree-sitter build -o ~/.config/tree-sitter/lib/bash.dylib <grammar-dir>"
    : undefined;

  for (const fx of FIXTURE_TESTS) {
    it(`${fx.file} — ${fx.title}`, { skip: skipReason }, () => {
      const result = parseFile(fx.file, mode!.args);
      fx.check(result);
    });
  }
});

/**
 * tree-sitter parse bridge (pi-immunity).
 *
 * Spawns the `tree-sitter` CLI out-of-process, parses a temp file containing
 * the command with the tree-sitter-bash grammar, and walks the S-expression
 * output. Verified invocation (spike 1, CLI 0.26.11):
 *
 *   tree-sitter parse -l <compiled-grammar.dylib> <file>   (fast, ~6 ms)
 *   tree-sitter parse -p <grammar-dir> <file>              (fallback, ~1 s, implies rebuild)
 *
 * Degradation chain: lib → grammar dir → word-based extraction (caller is
 * notified on every degraded event via the notify callback). The word-based
 * path is a best-effort net: it splits on | only (quote-blind) and does NOT
 * see && / || / ; chains or compound statements — structural analysis is
 * the AST path's job. Degraded mode is weaker and the user is warned.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export interface TsConfig {
  /** tree-sitter binary (default: "tree-sitter" on PATH). */
  binPath?: string;
  /** Compiled grammar dylib (fast path). Default: ~/.config/tree-sitter/lib, then ~/.cache/tree-sitter/lib. */
  libPath?: string;
  /** Grammar repository directory (-p fallback). Default: ~/.config/tree-sitter/tree-sitter-bash. */
  grammarDir?: string | null;
  /** Temp dir for parse files (default: os.tmpdir(); tests pass a repo-local dir). */
  tempDir?: string;
}

export interface Position { row: number; col: number }

export interface TsNode {
  type: string;
  field: string | null;
  start: Position;
  end: Position;
  children: TsNode[];
}

export interface CommandStage { name: string; args: string[]; sep: Sep | null }

/** Separator preceding a stage: "|" (pipeline), "&&" / "||" / ";" (list). */
export type Sep = "|" | "&&" | "||" | ";";

export interface CommandModel {
  /** Pipeline stages (1 stage for a plain command). */
  stages: CommandStage[];
  /** Redirect destinations (raw source text, e.g. "~/.ssh/authorized_keys"). */
  redirects: string[];
  isPipeline: boolean;
  /** True when the parse contained ERROR nodes (lower confidence, tree still walkable). */
  hasError: boolean;
  raw: string;
}

export interface AnalyzeResult {
  model: CommandModel;
  source: "ast" | "words";
  /** Non-null when tree-sitter was unavailable; describes the failure. */
  degraded: string | null;
}

/* ------------------------------------------------------------------ */
/* S-expression parser (`tree-sitter parse` stdout)                    */
/* ------------------------------------------------------------------ */

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

function parseSexpr(src: string): TsNode {
  const tokens = tokenize(src);
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];

  // node ::= '(' type pos '-' pos children* ')'   (field prefix handled by caller)
  function parseNode(field: string | null): TsNode {
    const open = next();
    if (open.kind !== "lparen") throw new Error(`expected '(' at token ${i - 1}`);
    const typeTok = next();
    if (typeTok.kind !== "ident" || typeTok.isField) throw new Error(`expected node type at token ${i - 1}`);
    const startTok = next();
    if (startTok.kind !== "pos") throw new Error(`expected start position at token ${i - 1}`);
    const dash = next();
    if (dash.kind !== "dash") throw new Error(`expected '-' at token ${i - 1}`);
    const endTok = next();
    if (endTok.kind !== "pos") throw new Error(`expected end position at token ${i - 1}`);

    const node: TsNode = {
      type: typeTok.value,
      field,
      start: { row: startTok.row, col: startTok.col },
      end: { row: endTok.row, col: endTok.col },
      children: [],
    };

    for (;;) {
      const t = peek();
      if (t.kind === "rparen") { next(); return node; }
      if (t.kind === "ident" && t.isField) {
        const childField = (next() as { value: string }).value;
        if (peek().kind !== "lparen") throw new Error(`expected '(' after field '${childField}' at token ${i}`);
        node.children.push(parseNode(childField));
      } else if (t.kind === "lparen") {
        node.children.push(parseNode(null));
      } else {
        throw new Error(`unexpected token at ${i}`);
      }
    }
  }

  const root = parseNode(null);
  if (i !== tokens.length) throw new Error(`trailing tokens after root (${tokens.length - i})`);
  return root;
}

/* ------------------------------------------------------------------ */
/* CLI bridge                                                          */
/* ------------------------------------------------------------------ */

interface RunResult { ran: boolean; status: number | null; stdout: string; stderr: string }

function run(bin: string, args: string[], timeoutMs: number): RunResult {
  const res = spawnSync(bin, args, { encoding: "utf8", timeout: timeoutMs });
  return { ran: !res.error, status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

const DEFAULT_LIB_CANDIDATES = (): string[] => [
  join(homedir(), ".config/tree-sitter/lib/bash.dylib"),
  join(homedir(), ".cache/tree-sitter/lib/bash.dylib"),
];
const DEFAULT_GRAMMAR_DIR = join(homedir(), ".config/tree-sitter/tree-sitter-bash");

let tempDir: string | null = null;
let fileCounter = 0;

function ensureTempDir(configDir?: string): string {
  if (configDir) return configDir;
  if (!tempDir) tempDir = mkdtempSync(join(tmpdir(), "immunity-ts-"));
  return tempDir;
}

/**
 * Parse a command string with the tree-sitter CLI. Result carries the AST
 * root (or a failure reason). Parse errors in the command itself (ERROR
 * nodes, exit 1) are NOT failures — the tree is still returned.
 */
export function parseBash(raw: string, config: TsConfig = {}): { ok: true; root: TsNode } | { ok: false; error: string } {
  const bin = config.binPath ?? "tree-sitter";
  const dir = ensureTempDir(config.tempDir);
  const file = join(dir, `${process.pid}-${fileCounter++}.sh`);
  writeFileSync(file, raw);
  try {
    const lib = config.libPath ?? DEFAULT_LIB_CANDIDATES().find(existsSync);
    if (lib) {
      const r = run(bin, ["parse", "-l", lib, file], 15_000);
      const parsed = sexpOf(r);
      if (parsed) return { ok: true, root: parsed };
      if (!r.ran) return { ok: false, error: `tree-sitter binary not found: ${bin}` };
    }
    const grammar = config.grammarDir ?? DEFAULT_GRAMMAR_DIR;
    if (existsSync(grammar)) {
      const r = run(bin, ["parse", "-p", grammar, file], 30_000);
      const parsed = sexpOf(r);
      if (parsed) return { ok: true, root: parsed };
    }
    return { ok: false, error: "tree-sitter parse failed (no usable lib or grammar)" };
  } finally {
    rmSync(file, { force: true });
  }
}

function sexpOf(r: RunResult): TsNode | null {
  if (!r.ran) return null;
  if (/Failed to load language|Error opening dynamic library/.test(r.stderr)) return null;
  const clean = r.stdout.split("\n").filter((l) => !/\tParse:/.test(l)).join("\n");
  try {
    return parseSexpr(clean);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* AST → command model                                                 */
/* ------------------------------------------------------------------ */

const ARG_NODE_TYPES = new Set(["word", "string", "raw_string", "number"]);

/** Node types whose children are visited generically (compound statements etc.). */
const CONTAINER_NODES = new Set([
  "program", "list", "pipeline", "compound_statement", "if_statement",
  "while_statement", "for_statement", "case_statement", "subshell",
  "do_group", "function_definition",
]);

function offsetOf(source: string, pos: Position): number {
  const lines = source.split("\n");
  let offset = 0;
  for (let r = 0; r < pos.row; r++) offset += lines[r].length + 1;
  return offset + pos.col;
}

/** Separator between two stage-producing nodes, read from the raw source gap. */
function sepOf(raw: string, from: Position, to: Position): Sep | null {
  const slice = raw.slice(offsetOf(raw, from), offsetOf(raw, to));
  const m = /(\|\||&&|;|\|)/.exec(slice);
  return (m?.[1] as Sep) ?? null;
}

function textOf(node: TsNode, source: string): string {
  const lines = source.split("\n");
  if (node.start.row === node.end.row) {
    return lines[node.start.row].slice(node.start.col, node.end.col);
  }
  const parts = [lines[node.start.row].slice(node.start.col)];
  for (let r = node.start.row + 1; r < node.end.row; r++) parts.push(lines[r]);
  parts.push(lines[node.end.row].slice(0, node.end.col));
  return parts.join("\n");
}

/** Extract the command model (stages, redirects) from a parsed AST. */
export function modelFromAst(root: TsNode, raw: string): CommandModel {
  const model: CommandModel = { stages: [], redirects: [], isPipeline: false, hasError: false, raw };
  model.hasError = containsError(root);
  let lastEnd: Position | null = null;
  visit(root);
  return model;

  function visit(n: TsNode) {
    if (CONTAINER_NODES.has(n.type)) {
      if (n.type === "pipeline") model.isPipeline = true;
      for (const c of n.children) visit(c);
      return;
    }
    if (n.type === "redirected_statement") {
      for (const c of n.children) {
        if (c.type === "command" || c.type === "pipeline") visit(c);
        else collectRedirect(c);
      }
      return;
    }
    if (n.type === "command") {
      const s = stage(n);
      s.sep = lastEnd ? sepOf(raw, lastEnd, n.start) : null;
      model.stages.push(s);
      lastEnd = n.end;
      return;
    }
  }

  function collectRedirect(r: TsNode) {
    for (const c of r.children) if (c.field === "destination") model.redirects.push(textOf(c, raw));
  }

  function stage(cmd: TsNode): CommandStage {
    let name = "";
    const args: string[] = [];
    for (const c of cmd.children) {
      if (c.type === "command_name") {
        name = c.children[0] ? textOf(c.children[0], raw) : "";
      } else if (c.field === "redirect" || c.type === "file_redirect") {
        collectRedirect(c);
      } else if (ARG_NODE_TYPES.has(c.type)) {
        args.push(textOf(c, raw));
      }
    }
    return { name, args };
  }
}

function containsError(n: TsNode): boolean {
  return n.type === "ERROR" || n.children.some(containsError);
}

/* ------------------------------------------------------------------ */
/* Word-based fallback extraction                                      */
/* ------------------------------------------------------------------ */

const REDIRECT_TOKEN = /^(>>?|\d*>>?)$/;
const REDIRECT_ATTACHED = /^(>>?|\d*>>?)(.+)$/;

const PIPE_SEP = /(\|\|?)/;

/**
 * Best-effort model from raw words (fallback when tree-sitter is unavailable).
 * Splits on | only — quote-blind by design; && / || / ; chains and compound
 * statements are AST-only (see module docstring).
 */
export function modelFromWords(raw: string): CommandModel {
  const stages: CommandStage[] = [];
  const redirects: string[] = [];
  let pendingSep: Sep | null = null;

  for (const piece of raw.split(PIPE_SEP)) {
    if (piece === "|" || piece === "||") {
      pendingSep = piece;
      continue;
    }
    if (!piece.trim()) continue;
    const tokens = piece.trim().split(/\s+/);
    const args: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const attached = REDIRECT_ATTACHED.exec(t);
      if (REDIRECT_TOKEN.test(t)) {
        if (tokens[i + 1]) redirects.push(tokens[++i]);
      } else if (attached) {
        redirects.push(attached[2]);
      } else {
        args.push(t);
      }
    }
    if (args.length) {
      stages.push({ name: args[0], args: args.slice(1), sep: pendingSep });
      pendingSep = null;
    }
  }
  return { stages, redirects, isPipeline: stages.some((s) => s.sep === "|"), hasError: false, raw };
}

/* ------------------------------------------------------------------ */
/* High-level entry point                                              */
/* ------------------------------------------------------------------ */

/**
 * Analyze a command: AST when tree-sitter is available, word-based
 * extraction otherwise. `notify` is called on EVERY degraded event so the
 * caller can warn the user (design §4.2: warn every time, not once per
 * session).
 */
export function analyzeCommand(raw: string, config: TsConfig = {}, notify?: (msg: string) => void): AnalyzeResult {
  const parsed = parseBash(raw, config);
  if (parsed.ok) return { model: modelFromAst(parsed.root, raw), source: "ast", degraded: null };
  notify?.(`tree-sitter unavailable (${parsed.error}); using word-based analysis`);
  return { model: modelFromWords(raw), source: "words", degraded: parsed.error };
}

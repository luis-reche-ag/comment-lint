#!/usr/bin/env bun
/**
 * comment-lint.ts — deterministic gate on new comments in the staged diff.
 * Called by scripts/committer before every commit. Standalone: comment-lint [-- <files>]
 * (lints the staged diff); --from-stdin lints a diff piped in (calibration/replay).
 *
 * Rules (hard-block, exit 1):
 *   1. No run of consecutive added comment-only lines longer than MAX_BLOCK (default 2).
 *   2. Added comment lines must not exceed MAX_DENSITY of added non-blank lines,
 *      once the diff adds at least MIN_LINES non-blank lines.
 *   3. Same cap per file (at MIN_FILE_LINES added), so a dense file can't hide
 *      behind a large diff that dilutes the aggregate.
 */

import { execFileSync } from "child_process";
import { readFileSync } from "fs";

const REAL_GIT = "/usr/bin/git";

const MAX_BLOCK = Number(process.env["COMMENT_LINT_MAX_BLOCK"] ?? 2);
const MAX_DENSITY = Number(process.env["COMMENT_LINT_MAX_DENSITY"] ?? 0.25);
const MIN_LINES = Number(process.env["COMMENT_LINT_MIN_LINES"] ?? 40);
const MIN_FILE_LINES = Number(process.env["COMMENT_LINT_MIN_FILE_LINES"] ?? 20);

type Syntax = "slash" | "hash" | "dashdash";

// slash covers scss too: sass line comments are //, css block comments parse the same way.
const SLASH_EXT = new Set(["go", "ts", "tsx", "js", "jsx", "mjs", "cjs", "proto",
  "java", "c", "h", "cc", "cpp", "hpp", "swift", "kt", "css", "scss"]);
const HASH_EXT = new Set(["sh", "bash", "zsh", "py", "rb", "yaml", "yml",
  "tf", "tfvars", "star", "bzl"]);
const HASH_BASENAMES = new Set(["Makefile", "Dockerfile", "BUILD.bazel", "BUILD", "WORKSPACE"]);
const DASH_EXT = new Set(["sql"]);

const SKIP_PATTERNS = [
  /(^|\/)gen\//, /(^|\/)vendor\//, /(^|\/)node_modules\//, /(^|\/)mocks\//,
  /\.yo\.go$/, /_pb\.go$/, /_pb\.ts$/, /\.pb\.go$/,
];

// Blocks whose first line matches these may exceed MAX_BLOCK: Go package docs are
// idiomatic, and license headers are mandated text, not narration.
const EXEMPT_BLOCKS = [
  /^\/\/ Package [A-Za-z0-9_]/,
  /^(\/\/+|\/\*+|#+|--+|\*+) ?(Copyright\b|SPDX-License-Identifier)/i,
];

// Tool directives are not prose: they neither extend a block nor count toward density.
const DIRECTIVES = [
  /^#!/,
  /^\/\/go:/, /^\/\/ ?nolint/, /^\/\/ ?#nosec/, /^\/\/ ?gosec/,
  /^\/\/ ?eslint-/, /^\/\* ?eslint/, /^\/\/ ?@ts-/, /^\/\/ ?prettier-ignore/,
  /^\/\/ ?biome-ignore/, /^\/\/ ?tslint:/, /^\/\/ ?keep-sorted/,
  /^# ?keep-sorted/, /^# ?gazelle:/, /^# ?noqa/, /^# ?type:/, /^# ?ruff:/, /^# ?pylint:/,
];

function syntaxFor(path: string): Syntax | null {
  const base = path.split("/").pop() ?? "";
  if (HASH_BASENAMES.has(base)) return "hash";
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  if (SLASH_EXT.has(ext)) return "slash";
  if (HASH_EXT.has(ext)) return "hash";
  if (DASH_EXT.has(ext)) return "dashdash";
  return null;
}

type Kind = "comment" | "code" | "blank" | "directive";

function classify(content: string, syntax: Syntax, state: { inBlock: boolean }): Kind {
  const t = content.trim();
  if (state.inBlock) {
    const end = t.indexOf("*/");
    if (end === -1) return "comment";
    state.inBlock = false;
    const rest = t.slice(end + 2).trim();
    return rest === "" || rest === "}" ? "comment" : "code";
  }
  if (t === "") return "blank";
  if (DIRECTIVES.some((re) => re.test(t))) return "directive";
  if (syntax === "hash") return t.startsWith("#") ? "comment" : "code";
  if (syntax === "dashdash") return t.startsWith("--") ? "comment" : "code";
  if (t.startsWith("//")) return "comment";
  const s = t.startsWith("{/*") ? t.slice(1) : t; // JSX comment
  if (s.startsWith("/*")) {
    const end = s.indexOf("*/", 2);
    if (end === -1) {
      state.inBlock = true;
      return "comment";
    }
    const rest = s.slice(end + 2).trim();
    return rest === "" || rest === "}" ? "comment" : "code";
  }
  return "code";
}

interface Run { file: string; line: number; count: number; first: string }
interface FileStats { comments: number; added: number }

function lintDiff(diff: string): { blocks: Run[]; comments: number; added: number; perFile: Map<string, FileStats> } {
  let file: string | null = null;
  let syntax: Syntax | null = null;
  let newLine = 0;
  const state = { inBlock: false };
  let run: Run | null = null;
  const blocks: Run[] = [];
  let comments = 0;
  let added = 0;
  const perFile = new Map<string, FileStats>();

  const bump = (f: string, comment: boolean) => {
    const s = perFile.get(f) ?? { comments: 0, added: 0 };
    s.added++;
    if (comment) s.comments++;
    perFile.set(f, s);
  };

  const flush = () => {
    if (run && run.count > MAX_BLOCK && !EXEMPT_BLOCKS.some((re) => re.test(run!.first))) {
      blocks.push(run);
    }
    run = null;
  };

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      flush();
      const p = raw.slice(4).trim();
      file = p === "/dev/null" ? null : p.replace(/^b\//, "");
      syntax = file && !SKIP_PATTERNS.some((re) => re.test(file!)) ? syntaxFor(file) : null;
      state.inBlock = false;
      continue;
    }
    if (raw.startsWith("@@")) {
      flush();
      state.inBlock = false; // don't carry block-comment state across hunks
      const m = /\+(\d+)/.exec(raw);
      newLine = m ? parseInt(m[1], 10) : 0;
      continue;
    }
    if (raw.startsWith("+")) {
      const line = newLine++;
      if (!file || !syntax) continue;
      const kind = classify(raw.slice(1), syntax, state);
      if (kind === "comment") {
        comments++;
        added++;
        bump(file, true);
        if (run) {
          run.count++;
          // A bare /* opener says nothing; represent the block by its first text line.
          if (/^\{?\/\*+$/.test(run.first)) run.first = raw.slice(1).trim();
        } else {
          run = { file, line, count: 1, first: raw.slice(1).trim() };
        }
      } else {
        if (kind !== "blank") {
          added++;
          bump(file, false);
        }
        flush();
      }
      continue;
    }
    if (raw.startsWith("-")) continue; // removed lines don't affect new-file numbering
    if (raw.startsWith(" ")) newLine++;
    flush();
  }
  flush();
  return { blocks, comments, added, perFile };
}

// --- CLI ---

const argv = process.argv.slice(2);
const fromStdin = argv.includes("--from-stdin");
const files = argv.filter((a) => a !== "--" && a !== "--from-stdin");

let diff: string;
if (fromStdin) {
  diff = readFileSync(0, "utf8");
} else {
  const gitArgs = ["diff", "--staged", "--unified=0", "--no-color"];
  if (files.length > 0) gitArgs.push("--", ...files);
  try {
    diff = execFileSync(REAL_GIT, gitArgs, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    console.error(`comment-lint: git diff failed: ${(e as Error).message}`);
    process.exit(2);
  }
}

const { blocks, comments, added, perFile } = lintDiff(diff);
const densityFail = added >= MIN_LINES && comments / added > MAX_DENSITY;
// Per-file cap only past MIN_LINES: small diffs keep the aggregate-only contract.
const fileFails = added < MIN_LINES ? [] : [...perFile.entries()]
  .map(([file, s]) => ({ file, ...s, ratio: s.comments / s.added }))
  .filter((v) => v.added >= MIN_FILE_LINES && v.ratio > MAX_DENSITY)
  .sort((a, b) => b.ratio - a.ratio);

const preview = (s: string) => (s.length > 60 ? s.slice(0, 57) + "…" : s);

if (blocks.length > 0) {
  console.error(`\n🚫 comment-lint: new comment blocks exceed ${MAX_BLOCK} lines\n`);
  for (const b of blocks) {
    console.error(`  ${b.file}:${b.line}  ${b.count}-line comment block: "${preview(b.first)}"`);
  }
  console.error(`\nReduce each comment to at most ${MAX_BLOCK} lines: keep the why, delete the narration.`);
}

if (densityFail) {
  const pct = Math.round((comments / added) * 100);
  console.error(`\n🚫 comment-lint: too many comment lines in this diff`);
  console.error(`  added comment lines: ${comments} of ${added} added lines (${pct}% > ${Math.round(MAX_DENSITY * 100)}%)`);
  for (const [f, s] of [...perFile.entries()].sort((a, b) => b[1].comments - a[1].comments)) {
    console.error(`    ${String(s.comments).padStart(3)}  ${f}`);
  }
  console.error(`\nDelete comments that narrate what the code already says.`);
}

if (!densityFail && fileFails.length > 0) {
  console.error(`\n🚫 comment-lint: comment-dense files in this diff`);
  for (const v of fileFails) {
    const pct = Math.round(v.ratio * 100);
    console.error(`  ${v.file}: ${v.comments} of ${v.added} added lines (${pct}% > ${Math.round(MAX_DENSITY * 100)}%)`);
  }
  console.error(`\nDelete comments that narrate what the code already says.`);
}

if (blocks.length > 0 || densityFail || fileFails.length > 0) {
  console.error(`Then re-run committer. (--verbose-comments skips this gate; reserve it for mandated headers.)\n`);
  process.exit(1);
}

# comment-lint

A pre-commit gate that blocks diffs with too many comments.

It reads the **staged git diff** (only the lines you are adding — never the whole file)
and fails the commit when the new comments cross a threshold. Existing comments in the
codebase are irrelevant to it; it only judges what this commit adds.

## Why

Comments that narrate what the code already says are noise: they add reading cost,
they rot the moment the code changes, and reviewers have to check them against the
code anyway. This got much worse with AI coding assistants, which love to leave a
trail of `// Loop over the items` and 10-line explanations of their own change.

The useful comment is the short one that says something the code *can't* say: a why,
a non-obvious constraint, a warning. This tool enforces that discipline mechanically,
before the diff ever reaches a reviewer:

- **Deterministic** — no LLM, no judgment calls, same result every run.
- **Diff-scoped** — you can adopt it in a legacy codebase today; it never complains
  about code you didn't touch.
- **Fast** — a single script, runs in milliseconds.

## The rules

Three checks, all hard failures (exit 1):

1. **Block length** — no run of consecutive added comment-only lines longer than
   `MAX_BLOCK` (default **2**). If you need more than 2 lines to explain something,
   the explanation usually belongs in the code, a doc, or the commit message.
2. **Diff density** — added comment lines must not exceed `MAX_DENSITY` (default
   **25%**) of the diff's added non-blank lines. Only enforced once the diff adds at
   least `MIN_LINES` (default 40) lines, so tiny diffs are never flagged.
3. **Per-file density** — the same 25% cap applied per file (for files adding at
   least `MIN_FILE_LINES`, default 20). This catches a comment-dense file hiding
   inside a large diff that dilutes the aggregate ratio.

### What it deliberately ignores

Some comment-shaped lines are not prose, so they neither count toward density nor
extend a block:

- **Tool directives**: shebangs, `//go:generate`, `//nolint`, `// #nosec`,
  `// eslint-disable`, `// @ts-ignore`, `# noqa`, `# type:`, `# gazelle:`, ...
- **Exempt blocks** (may exceed `MAX_BLOCK`): Go package docs (`// Package foo ...`)
  because they are idiomatic, and copyright / SPDX license headers because they are
  mandated text, not narration.
- **Generated and vendored paths**, skipped entirely: `gen/`, `vendor/`,
  `node_modules/`, `mocks/`, `*.pb.go`, `*_pb.ts`, `*.yo.go`.

### Supported languages

Comment syntax is inferred from the file extension:

| Syntax | Languages |
|---|---|
| `//` and `/* */` | Go, TypeScript/JavaScript (+JSX), C/C++, Java, Swift, Kotlin, proto, CSS/SCSS |
| `#` | shell, Python, Ruby, YAML, Terraform, Starlark/Bazel, Makefile, Dockerfile |
| `--` | SQL |

Files with any other extension are ignored (treated as not lintable), so Markdown,
JSON, plain text, etc. never trip the gate.

## Usage

```sh
comment-lint                          # lint the staged diff of the current repo
comment-lint -- src/foo.ts src/bar.ts # lint only these files' staged changes
git diff origin/main | comment-lint --from-stdin   # lint any diff you pipe in
```

Exit codes: `0` clean, `1` blocked (with a report), `2` git error.

The `--from-stdin` mode makes it composable: point it at a branch diff in CI, replay
an old diff to calibrate thresholds, or lint unstaged work in progress.

### What a failure looks like

```
🚫 comment-lint: new comment blocks exceed 2 lines

  svc/quote/rating.go:142  6-line comment block: "This function calculates the rate by first..."

Reduce each comment to at most 2 lines: keep the why, delete the narration.
```

```
🚫 comment-lint: too many comment lines in this diff
  added comment lines: 31 of 98 added lines (32% > 25%)
     18  svc/quote/rating.go
     13  svc/quote/rating_test.go

Delete comments that narrate what the code already says.
```

The fix is always deleting or tightening comments — not restructuring code to game
the ratio.

## Install

Requires [Bun](https://bun.sh) (the script is directly executable via
`#!/usr/bin/env bun`, no dependencies to install).

```sh
git clone git@github.com:luis-reche-ag/comment-lint.git
chmod +x comment-lint/comment-lint.ts
ln -s "$PWD/comment-lint/comment-lint.ts" ~/.local/bin/comment-lint
```

### As a pre-commit hook

Drop this in `.git/hooks/pre-commit` (or call it from the hook you already have):

```sh
#!/bin/sh
exec comment-lint
```

It lints exactly what `git diff --staged` shows, so it slots into any commit
wrapper or hook manager the same way.

### Escape hatch

Sometimes long comment text is legitimately mandated (a license header the exempt
list doesn't cover, a vendored snippet imported verbatim). Wire a bypass flag into
your commit wrapper for those cases, or override a threshold for one commit:

```sh
COMMENT_LINT_MAX_BLOCK=10 comment-lint
```

The bypass is for mandated text — never for keeping narration.

## Tuning

All thresholds are env vars, so you can tune per repo or per invocation without
touching the script:

| Variable | Default | Meaning |
|---|---|---|
| `COMMENT_LINT_MAX_BLOCK` | 2 | Max consecutive added comment-only lines |
| `COMMENT_LINT_MAX_DENSITY` | 0.25 | Max added-comment / added-non-blank ratio |
| `COMMENT_LINT_MIN_LINES` | 40 | Added lines before density rules apply |
| `COMMENT_LINT_MIN_FILE_LINES` | 20 | Added lines in a file before the per-file cap applies |

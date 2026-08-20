# comment-lint

Deterministic gate on new comments in a staged git diff. Blocks commits that add
comment blocks longer than 2 lines or whose added lines are more than 25% comments.
The goal: keep the why, delete the narration.

## Usage

```sh
comment-lint                 # lint the staged diff of the current repo
comment-lint -- <files>      # lint only the staged diff of these files
git diff | comment-lint --from-stdin   # lint any diff piped in
```

Exit 0 when clean, 1 with a report when it blocks, 2 on git errors.
Runs on [Bun](https://bun.sh) — the script is directly executable (`#!/usr/bin/env bun`).

## Rules

1. No run of consecutive added comment-only lines longer than `MAX_BLOCK` (default 2).
2. Added comment lines must not exceed `MAX_DENSITY` (default 25%) of added non-blank
   lines, once the diff adds at least `MIN_LINES` (default 40) non-blank lines.
3. The same density cap applies per file (at `MIN_FILE_LINES` added, default 20), so a
   dense file can't hide behind a large diff that dilutes the aggregate.

Exempt: Go package docs, copyright/SPDX headers, and tool directives (`//go:`,
`nolint`, `eslint-`, `# noqa`, shebangs, ...). Generated paths (`gen/`, `vendor/`,
`*.pb.go`, ...) are skipped entirely.

## Tuning

Thresholds are overridable per invocation via env vars:

```sh
COMMENT_LINT_MAX_BLOCK=3 COMMENT_LINT_MAX_DENSITY=0.3 comment-lint
```

| Variable | Default |
|---|---|
| `COMMENT_LINT_MAX_BLOCK` | 2 |
| `COMMENT_LINT_MAX_DENSITY` | 0.25 |
| `COMMENT_LINT_MIN_LINES` | 40 |
| `COMMENT_LINT_MIN_FILE_LINES` | 20 |

## Install

```sh
ln -s "$PWD/comment-lint.ts" ~/.local/bin/comment-lint
chmod +x comment-lint.ts
```

Supported languages: `//` (Go, TS/JS, C-family, Java, Swift, Kotlin, proto, CSS/SCSS),
`#` (shell, Python, Ruby, YAML, Terraform, Starlark, Makefile, Dockerfile), `--` (SQL).

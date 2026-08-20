# agent-git-toolkit: committer + comment-lint + git shim

Guardrails for working with AI coding agents in a git repo. Three layers that
together make the agent's git usage safe, its commits well-formed, and its
comments quiet:

| Layer | File | What it does |
|---|---|---|
| **git shim** | `bin/git` + `scripts/git-policy.ts` | Intercepts every `git` call; blocks direct `add`/`commit`, gates destructive and outward operations behind explicit consent |
| **committer** | `scripts/committer` | The only authorized way to commit: explicit file paths, Conventional Commits validation, scope↔path check, runs comment-lint |
| **comment-lint** | `scripts/comment-lint.ts` | Deterministic gate on new comments in the staged diff |

Each layer works standalone; together they form a pipeline: the shim forces the
agent through `committer`, and `committer` won't commit until `comment-lint` passes.

Everything runs on [Bun](https://bun.sh) with zero dependencies.

---

## The git shim

A drop-in `git` that classifies every subcommand before letting it through to the
real binary (`/usr/bin/git`):

- **Safe** (`status`, `diff`, `log`, `fetch`, `switch`, ...) — passes through.
- **Blocked** (`add`, `commit`) — always refused with a pointer to `committer`.
  This is the core mechanic: an agent cannot `git add .` or commit unreviewed
  file sets, ever.
- **Destructive** (`reset --hard`, `clean`, `checkout -- <path>`, `commit --amend`,
  `rebase --autosquash`, ...) — refused unless consent is granted.
- **Guarded** (`push`, `pull`, `rebase`, `merge`, `cherry-pick`, `revert`) —
  refused unless consent is granted.

Consent is an environment variable the agent must set deliberately, per command:

```sh
RUNNER_THE_USER_GAVE_ME_CONSENT=1 git push
```

The name is intentional: an agent that sets it is asserting, in its own transcript,
that the user asked for this operation. That makes the decision auditable — you can
grep the session for the exact moment consent was claimed.

Two escape hatches are built in:

- **VSCode's Git UI bypasses everything.** Clicks on Source Control buttons are
  human gestures by definition, so when git runs from the VSCode extension
  (detected via its env vars) no gate applies.
- **`committer` bypasses the add/commit block** via a per-invocation random token
  (`_COMMITTER_TOKEN`), so it remains the single authorized path.

## committer

Usage:

```sh
committer "type(scope): message" file1 [file2 ...]
committer --cross-cutting "chore: bump deps everywhere" go.mod package.json
committer --verbose-comments "docs: import mandated license header" LICENSE.go
committer --force "fix(api): retry on stale lock" api/client.go   # clears a stale index.lock
```

What it enforces, in order:

1. **Explicit paths only.** `.` is rejected, every path must exist (or be a tracked
   deletion). The staging area is reset first, so exactly the listed files are
   committed — nothing an earlier command left staged can ride along.
2. **Conventional Commits format** (warning, not a block): `type(scope): description`
   with type in `feat|fix|chore|docs|test`. `chore` covers refactor, perf, build,
   ci and style.
3. **Scope must match the paths** (hard block). A path→scopes map (ours is derived
   from agentero/mono history; edit `scopes_for_path` for your repo) rejects e.g.
   `feat(mktplace)` on a commit that only touches `infra/`. Paths with no mapping
   accept any scope — which also makes this a no-op in unmapped repos. Genuinely
   cross-area commits use `--cross-cutting`.
4. **comment-lint** on the staged diff (see below). `--verbose-comments` skips it —
   reserved for mandated text like license headers, never for keeping narration.

## comment-lint

A pre-commit gate that blocks diffs with too many comments. It reads the **staged
git diff** (only the lines being added — never the whole file), so it can be adopted
in any legacy codebase today: it never complains about code you didn't touch.

### Why

Comments that narrate what the code already says are noise: they add reading cost,
they rot the moment the code changes, and reviewers have to check them against the
code anyway. AI assistants made this much worse — they love `// Loop over the items`
and 10-line explanations of their own change. The useful comment is the short one
that says something the code *can't* say: a why, a non-obvious constraint, a warning.
This enforces that mechanically, before the diff reaches a reviewer. No LLM, no
judgment calls — same result every run, in milliseconds.

### The rules

Three checks, all hard failures (exit 1):

1. **Block length** — no run of consecutive added comment-only lines longer than
   `MAX_BLOCK` (default **2**). Longer explanations belong in the code, a doc, or
   the commit message.
2. **Diff density** — added comment lines must not exceed `MAX_DENSITY` (default
   **25%**) of the diff's added non-blank lines. Only enforced once the diff adds
   at least `MIN_LINES` (default 40) lines, so tiny diffs are never flagged.
3. **Per-file density** — the same 25% cap per file (for files adding at least
   `MIN_FILE_LINES`, default 20), catching a comment-dense file hiding inside a
   large diff that dilutes the aggregate.

### What it deliberately ignores

- **Tool directives** (neither count toward density nor extend a block): shebangs,
  `//go:generate`, `//nolint`, `// #nosec`, `// eslint-disable`, `// @ts-ignore`,
  `# noqa`, `# type:`, `# gazelle:`, ...
- **Exempt blocks** (may exceed `MAX_BLOCK`): Go package docs (`// Package foo ...`)
  because they are idiomatic, and copyright / SPDX headers because they are mandated.
- **Generated and vendored paths**, skipped entirely: `gen/`, `vendor/`,
  `node_modules/`, `mocks/`, `*.pb.go`, `*_pb.ts`, `*.yo.go`.

### Supported languages

| Syntax | Languages |
|---|---|
| `//` and `/* */` | Go, TypeScript/JavaScript (+JSX), C/C++, Java, Swift, Kotlin, proto, CSS/SCSS |
| `#` | shell, Python, Ruby, YAML, Terraform, Starlark/Bazel, Makefile, Dockerfile |
| `--` | SQL |

Other extensions are ignored, so Markdown, JSON, plain text, etc. never trip the gate.

### Standalone usage

```sh
comment-lint                          # lint the staged diff of the current repo
comment-lint -- src/foo.ts src/bar.ts # lint only these files' staged changes
git diff origin/main | comment-lint --from-stdin   # lint any diff you pipe in
```

Exit codes: `0` clean, `1` blocked (with a report), `2` git error. The
`--from-stdin` mode makes it composable: point it at a branch diff in CI, or replay
old diffs to calibrate thresholds.

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

### Tuning

All thresholds are env vars, tunable per repo or per invocation:

| Variable | Default | Meaning |
|---|---|---|
| `COMMENT_LINT_MAX_BLOCK` | 2 | Max consecutive added comment-only lines |
| `COMMENT_LINT_MAX_DENSITY` | 0.25 | Max added-comment / added-non-blank ratio |
| `COMMENT_LINT_MIN_LINES` | 40 | Added lines before density rules apply |
| `COMMENT_LINT_MIN_FILE_LINES` | 20 | Added lines in a file before the per-file cap applies |

---

## Install

Requires [Bun](https://bun.sh). Clone, then symlink into a directory that precedes
`/usr/bin` in your `PATH` (e.g. `~/.local/bin`):

```sh
git clone git@github.com:luis-reche-ag/agent-git-toolkit.git
cd agent-git-toolkit
ln -s "$PWD/scripts/committer"       ~/.local/bin/committer
ln -s "$PWD/scripts/comment-lint.ts" ~/.local/bin/comment-lint
ln -s "$PWD/bin/git"                 ~/.local/bin/git        # optional: the full shim
```

The shim assumes the real git lives at `/usr/bin/git` (macOS default); adjust
`REAL_GIT` in `scripts/git-policy.ts` and `GIT_BIN` in `scripts/committer` otherwise.

**Adoption path**: `comment-lint` alone is useful as a plain pre-commit hook
(`exec comment-lint` in `.git/hooks/pre-commit`). Add `committer` when you want
commit hygiene, and the shim last — it changes how every git command behaves, so
it only makes sense on a machine where an agent runs unattended.

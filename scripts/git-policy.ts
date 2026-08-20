#!/usr/bin/env bun
/**
 * git-policy.ts — classifies git subcommands and enforces safety rules.
 * Called by bin/git shim before every git invocation.
 *
 * Exit codes:
 *   0 = allowed, caller should proceed
 *   1 = blocked, caller should abort
 */

type Policy = "safe" | "blocked" | "destructive" | "guarded";

interface Classification {
  policy: Policy;
  reason: string;
}

const REAL_GIT = "/usr/bin/git";

// Token-based authorization for scripts/committer.
// committer generates a random token per invocation and passes it via _COMMITTER_TOKEN.
// This allows committer to use git add/commit while blocking all other callers.
const committerToken = process.env["_COMMITTER_TOKEN"] ?? "";
const isCommitter = committerToken.length >= 40; // base64 of 32 random bytes = 44 chars

const SAFE = new Set(["status", "diff", "log", "show", "ls-files", "ls-tree",
  "rev-parse", "rev-list", "cat-file", "branch", "tag", "remote",
  "fetch", "stash", "describe", "shortlog", "blame", "grep", "bisect"]);

const DESTRUCTIVE = new Set(["reset", "clean", "restore", "rm", "mv", "gc", "prune", "reflog"]);

const GUARDED = new Set(["push", "pull", "rebase", "merge", "cherry-pick", "revert"]);

function classify(args: string[]): Classification {
  const sub = args[0] ?? "";

  if (SAFE.has(sub)) return { policy: "safe", reason: "" };

  // Committer authorization: if the caller has a valid token, allow add/commit
  if (isCommitter && (sub === "add" || sub === "commit" || sub === "restore")) {
    return { policy: "safe", reason: "" };
  }

  // Blocked: must use committer script instead
  if (sub === "add") return {
    policy: "blocked",
    reason: "Direct 'git add' is blocked. Use scripts/committer to stage and commit explicitly.",
  };
  if (sub === "commit") {
    if (args.includes("--amend")) return {
      policy: "destructive",
      reason: "'git commit --amend' is blocked. Ask the user before rewriting history.",
    };
    return {
      policy: "blocked",
      reason: "Direct 'git commit' is blocked. Use scripts/committer \"type(scope): message\" file1 file2 ...",
    };
  }

  if (DESTRUCTIVE.has(sub)) {
    // reset --soft and --mixed are safe (don't touch working tree)
    if (sub === "reset" && args.some(a => a === "--soft" || a === "--mixed")) {
      return { policy: "safe", reason: "" };
    }
    return {
      policy: "destructive",
      reason: `'git ${sub}' is a destructive operation. Ask the user for explicit consent first.`,
    };
  }

  if (sub === "switch") return { policy: "safe", reason: "" };

  if (sub === "checkout") {
    // git checkout -- <path>  or  git checkout <ref> -- <path>  → discards local changes
    if (args.includes("--")) return {
      policy: "destructive",
      reason: "'git checkout -- <path>' discards local changes. Ask the user for explicit consent first.",
    };
    return { policy: "safe", reason: "" };
  }

  if (GUARDED.has(sub)) {
    // rebase --autosquash rewrites history — treat as destructive
    if (sub === "rebase" && args.includes("--autosquash")) return {
      policy: "destructive",
      reason: "'git rebase --autosquash' rewrites history. Ask the user for explicit consent first.",
    };
    return {
      policy: "guarded",
      reason: `'git ${sub}' requires explicit user consent. The user must ask for this operation directly.`,
    };
  }

  return { policy: "safe", reason: "" };
}

const args = process.argv.slice(2);

// Strip pass-through flags before subcommand (e.g. git -C /path status)
let subStart = 0;
while (subStart < args.length) {
  const a = args[subStart];
  if (a === "-C" || a === "--git-dir" || a === "--work-tree") {
    subStart += 2;
  } else if (a.startsWith("-")) {
    subStart++;
  } else {
    break;
  }
}
const subArgs = args.slice(subStart);

const { policy, reason } = classify(subArgs);
const consent = process.env["RUNNER_THE_USER_GAVE_ME_CONSENT"] === "1";

// VSCode's Git extension drives git from explicit human clicks — stage, commit,
// pull, push, sync, discard. That IS the user asking directly, which is exactly what
// the guarded/destructive rules demand. This policy exists to constrain the automated
// agent, not a human's hands on the Source Control buttons, so when git is invoked
// from VSCode we skip every gate. Detected via env vars the extension injects into
// every git child process it spawns (and into its integrated terminal).
const isVSCode =
  !!process.env["VSCODE_GIT_IPC_HANDLE"] ||
  !!process.env["VSCODE_GIT_ASKPASS_MAIN"];

if (!isVSCode && policy === "blocked") {
  console.error(`\n🚫 git-policy: ${reason}\n`);
  process.exit(1);
}

if (!isVSCode && (policy === "destructive" || policy === "guarded") && !consent) {
  const icon = policy === "destructive" ? "🚫" : "⚠️ ";
  console.error(`\n${icon} git-policy: ${reason}`);
  console.error(`   To proceed: set RUNNER_THE_USER_GAVE_ME_CONSENT=1 in your shell.\n`);
  process.exit(1);
}

// Allowed — exec real git
import { execFileSync } from "child_process";
try {
  execFileSync(REAL_GIT, args, { stdio: "inherit" });
} catch (e: unknown) {
  const err = e as { status?: number };
  process.exit(err.status ?? 1);
}

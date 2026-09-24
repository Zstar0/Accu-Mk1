---
name: accumark-feature-workflow
description: Use when developing on any Accumark repo (Accu-Mk1, integration-service, coabuilder, accumarklabs) as a team member: picking up a feature or bug fix, being asked to "get it ready for review", testing against a devbox stack, opening a PR, or answering "how do we do X here". Applies to tiny changes too. Covers the team process, not the code.
---

# Accumark feature workflow

One loop, always in this order. The Handler (Forrest) reviews and merges PRs
and does every deploy. You never deploy, never touch production, never push
to master. A review-ready PR is the standing request: commits on your own
feature branch are expected (AGENTS.md's "no unsolicited commits" is about
the main checkout and master, not your branch).

**Violating the letter of a step is violating the spirit of it.** "Tiny"
changes follow the same loop; the ceremony shrinks, the steps do not.

Preflight, once per machine: `ssh devbox 'accumark-stack list'` prints stacks.
If not, do `references/onboarding.md` first.

## The loop

1. **Memory first.** `hindsight_search_knowledge_pages(<area>)`, then
   `hindsight_reflect(<why question>)`, then the repo's `AGENTS.md` and
   `CLAUDE.md`. Credit what you use (`🧠 From Hindsight memory ...`). If
   memory has nothing on the area, say so in one line. Only then read code cold.
2. **Design gate.** REQUIRED SUB-SKILL: superpowers:brainstorming. Say what you
   will change, where, how you will prove it, and what you will not do, then
   STOP for a yes. For a one-file change that is one paragraph. No code before
   the yes.
3. **Own worktree per task.** After `git fetch`:
   `git worktree add <path> -b feat/<slug> origin/master`. Never edit the main
   checkout, never `git switch` inside a worktree that belongs to another PR,
   never a bare `git stash` (shared across worktrees; use a WIP commit).
   Commit by pathspec, never `git add -A`.
4. **Build.** REQUIRED SUB-SKILL: superpowers:test-driven-development. Ponytail
   ladder for the code: reuse what exists, smallest diff, root cause in the
   shared path. Additive only. A change with a branch or failure path gets a
   test; a change with neither may skip one, and says so under "Not done".
5. **Gates as a failure-set diff.** Run the suite on the base commit and on
   your branch, compare the sets of failing test names; zero net-new is green.
   Accu-Mk1: `npm run check:all`, or without a Rust toolchain the frontend
   subset (`typecheck`, `lint`, `ast:lint`, `format:check`, `test:run`) plus
   backend pytest inside your stack, and say which you ran. Lint and format
   only the files you touched; never repo-wide prettier.
6. **Verify on YOUR devbox stack.** `accumark-stack create <you>-<slug>`, then
   `.claude/skills/accumark-feature-workflow/scripts/devbox-mount-branch.sh <stack>`
   after every push (first run mounts, later runs sync). Prove it with curl
   output or a screenshot from that stack and name the stack. A port-forward
   to your own stack is fine. Never the `host` stack, production, another
   person's stack, or a backend you did not create that happens to answer.
7. **PR.** Shape in `references/pr-contract.md`: What / Verified / Known
   limits / Not done. No version bumps, no release commits. Hand back the URL,
   the gate numbers, the stack name, and the "Not done" list verbatim.
8. **Write back.** Durable findings and traps: `hindsight_ingest_document`.
   Wrong memory: ingest a `Correction: <topic>` document.

## Never

Deploy or touch production (SSH, DB, env files). Push to master, force-push a
reviewed branch, merge your own PR. `destroy`, `unmount`, `restore` or
`snapshot` a stack you did not create. Commit secrets or `creds` output.
Change production behaviour without the Handler's sign-off in the PR.

## Rationalizations seen in the wild

| Excuse | Reality |
|--------|---------|
| "Tiny change, no design gate" | The gate is one paragraph. Tiny changes in the wrong place get reverted. |
| "Memory search wastes time" | Memory holds the trap you are about to step on. |
| "I will reuse this worktree and switch branches" | That worktree is another PR's. Yours costs one command. |
| "A backend is already running on localhost" | That is the Handler's host stack. Your stack or nothing. |
| "No CI, so gates are optional" | No CI is why the failure-set diff is mandatory. |
| "I will stash to compare with base" | Shared stash. WIP commit or a second worktree at base. |
| "Stateless UI, skip the stack" | The stack is where nginx, CSP, clipboard and Elementor bite. |

## Red flags, stop and go back a step

Code exists and nobody said yes. You are editing under
`Accumark-Workspace/<repo>` or `~/accumark-repos/<repo>`. A test count fell
and you cannot name the tests. Evidence is "worked locally" with no stack
name. The PR bumps a version.

## References

`references/devbox-stacks.md` (connect, lifecycle, ports, traps, the loop),
`references/pitfalls.md` (rules memory cannot derive from code),
`references/pr-contract.md`, `references/onboarding.md` (new machine and the
Handler's side). Script: `scripts/devbox-mount-branch.sh` in this folder.

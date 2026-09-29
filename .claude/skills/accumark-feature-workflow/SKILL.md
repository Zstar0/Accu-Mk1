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

1. **Memory first.** Team memory is Cognee, reached through the `memory-work`
   MCP server: call its `recall` tool twice, `dataset_name` `accumark_code`
   then `accumark_company`, with the question in plain words. Then the repo's
   `AGENTS.md` and `CLAUDE.md`. Credit what you use:
   `> **From memory (cognee: <dataset>)** - <facts used>`. If memory has
   nothing on the area, say so in one line. Only then read code cold. If the
   `memory-work` tools are missing, the MCP did not connect: fix that first
   (`references/onboarding.md`), do not skip the step.
2. **Design gate.** REQUIRED SUB-SKILL: superpowers:brainstorming. Say what you
   will change, where, how you will prove it, and what you will not do, then
   STOP for a yes. For a one-file change that is one paragraph. No code before
   the yes.
3. **Own worktree per task, and your stack.** After `git fetch`:
   `git worktree add <path> -b feat/<slug> origin/master` (`fix/<slug>` for
   bugs). Start `ssh devbox 'accumark-stack create <you>-<slug>'` now
   (lowercase, digits, hyphens, 16 chars max; 3 to 5 minutes). Never edit the
   main checkout, never `git switch` inside a worktree that belongs to another
   PR, never a bare `git stash` (shared across worktrees; use a WIP commit).
   Commit by pathspec, never `git add -A`.
4. **Baselines before the first edit.** Frontend: run the suite in the fresh
   worktree and keep the list of failing test names. Backend: run pytest
   inside your stack before you mount your branch (the image is the base).
   The documented counts in `references/pitfalls.md` are context, not a
   baseline.
5. **Build.** REQUIRED SUB-SKILL: superpowers:test-driven-development,
   whenever a test is warranted: any change with a branch or failure path. A
   change with neither may skip one and says so under "Not done". Ponytail
   ladder for the code: reuse what exists, smallest diff, root cause in the
   shared path. Additive only: a shared-path edit that changes behaviour for
   other callers is a production-behaviour change and needs the Handler's
   sign-off. Editing an existing assertion so it passes is a ruling, not a
   fix: ask first.
6. **Gates as a failure-set diff.** Same suites on your branch; compare the
   failing-name sets with step 4; zero net-new is green. Accu-Mk1:
   `npm run check:all`, or without a Rust toolchain the frontend subset
   (`typecheck`, `lint`, `ast:lint`, `format:check`, `test:run`) plus backend
   pytest in the stack after mounting; say which you ran. Repo-wide read-only
   checks are fine; never reformat or auto-fix files you did not touch.
7. **Verify on YOUR devbox stack.** After each commit run
   `.claude/skills/accumark-feature-workflow/scripts/devbox-mount-branch.sh <stack>`
   (it pushes; first run creates the devbox worktree and mounts it, later
   runs fast-forward). Then run the Playwright suite against that stack
   (`e2e/README.md`: source your `/c/tmp/<stack>-e2e.env`, then
   `npm run test:e2e`) and add a spec for the feature's main flow. Prove it
   with the e2e result line, curl output or a screenshot from that stack and
   name the stack in the PR. A port-forward to your own stack is
   fine. Not evidence: the `host` stack, production, another person's stack,
   a server you started on your laptop, or any backend that happens to
   answer.
8. **PR.** Shape in `references/pr-contract.md`: What / Verified / Known
   limits / Not done. The repos' PR template carries that shape and the
   `pr-evidence` check fails a PR whose Verified block lacks the stack name,
   pasted test result lines and a committed screenshot (or the ticked "No
   user-visible change" box). A PR without the Verified block is returned
   unreviewed. No version bumps, no release commits. Hand back the URL,
   the gate numbers, the stack name, and the "Not done" list verbatim.
9. **Write back.** Your memory key is read-only; the PR is your write path.
   Durable findings and traps go in the PR body and, when they are rules the
   next person needs, in `references/pitfalls.md` in the same PR. Wrong
   memory: say so in the PR under "Known limits" with what is true now and
   the evidence. The Handler's nightly ingest carries merged material into
   the shared datasets.

## Never

Deploy or touch production (SSH, DB, env files). Push to master, force-push a
reviewed branch, merge your own PR. `destroy`, `unmount`, `restore` or
`snapshot` a stack you did not create. Commit secrets or `creds` output.
Change production behaviour without the Handler's sign-off in the PR.

## Rationalizations seen in the wild

| Excuse | Reality |
|--------|---------|
| "Tiny change, no design gate" | The gate is one paragraph. Tiny changes in the wrong place get reverted. |
| "'Ready for review' pre-authorises the design" | It authorises the PR. The yes to a design is a message from the Handler. |
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

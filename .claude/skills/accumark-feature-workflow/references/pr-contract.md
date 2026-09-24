# Branches, commits and the PR contract

## Branches and worktrees

- One task, one branch, one worktree: `feat/<slug>` or `fix/<slug>` off a
  fresh `origin/master` (Accu-Mk1, integration-service, coabuilder,
  accumarklabs). Platform work targets `accumark-stack`'s
  `feat/devbox-hosting`.
- Worktrees live outside the main checkout (`C:/tmp/<repo>-<slug>` on
  Windows, `~/worktrees/<repo>-<slug>` on the devbox). The main checkout is
  never edited.
- Rebase onto `origin/master` before opening the PR if master moved; never
  force-push after the Handler started reviewing without saying so.

## Commits

```
type(scope): imperative summary under 72 chars

Why, not what: the constraint, the trap, the ruling that shaped it. Name the
stack you verified on when relevant.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

Types: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`. Commit by pathspec
(`git add -- path ...`), never `git add -A`; hook artefacts such as
`.impeccable/` and scratch files stay out.

No version bumps and no `chore: release` commits: the Handler cuts releases.
If the repo keeps an `## Unreleased` section in `CHANGELOG.md`, add your line
there.

## The PR body

```
## What
Two to five sentences: the change, where it lives, the one non-obvious
decision and why. Link the design or ruling if there was one.

## Verified
- Unit: <suite> <n> passed, <m> pre-existing failures unchanged from base <sha>
- Gates: typecheck / lint / format on touched files: clean
- Stack `<you>-<slug>`: <curl output or screenshot>, <what you clicked>

## Known limits
What still does not work, what was deliberately left out, what needs a
follow-up. Empty is a valid answer; missing is not.

## Not done
The explicit list: no test for X because Y, no i18n key, not run on desktop
build, etc.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

Open with `gh pr create --repo Zstar0/<repo> --base master --head <branch>`.
Accu-Mk1 master is squash-merged (title becomes the commit, `(#N)` appended);
`accumark-stack` uses merge commits. You do not merge; the Handler does.

## Hand-back message

Lead with the PR URL and one sentence on what it does. Then the gate numbers,
the stack it was proven on, and the "Not done" list verbatim. If anything
could not be verified, that is the first line, not a footnote.

## After merge

Destroy your stack, remove the devbox worktree (see the teardown trap in
`devbox-stacks.md`), delete the local worktree (unlink a `node_modules`
junction first on Windows), and ingest any durable finding into Hindsight.

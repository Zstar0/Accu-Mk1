#!/usr/bin/env bash
# devbox-mount-branch.sh -- the edit/test loop for a laptop developer:
# push the current feature branch, then create (first run) or fast-forward
# (every later run) the matching worktree on the devbox and mount it into
# YOUR stack. uvicorn --reload / vite HMR / PHP pick the new code up live.
#
#   scripts/devbox-mount-branch.sh <stack> [--host <ssh host>] [--no-push]
#
# Run from inside the repo worktree you are editing. The repo is detected from
# `origin` (Accu-Mk1, integration-service, coabuilder, accumarklabs). Devbox
# layout it expects (see the onboarding reference): ~/accumark-repos/<repo>
# clones, ~/worktrees/, ~/accumark-stack (the platform CLI).
#
# Host defaults to the ssh alias `devbox` (or $ACCUMARK_DEVBOX).
set -euo pipefail

STACK="${1:-}"; shift || true
[ -n "$STACK" ] || { echo "usage: $0 <stack> [--host <ssh host>] [--no-push]" >&2; exit 1; }
HOST="${ACCUMARK_DEVBOX:-devbox}"
PUSH=1
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="${2:?}"; shift 2 ;;
    --no-push) PUSH=0; shift ;;
    *) echo "ERROR: unknown arg: $1" >&2; exit 1 ;;
  esac
done

BRANCH=$(git rev-parse --abbrev-ref HEAD)
case "$BRANCH" in
  master|main|HEAD) echo "ERROR: on '$BRANCH'. Work on a feature branch in a worktree." >&2; exit 1 ;;
esac
REPO=$(basename -s .git "$(git remote get-url origin)")
case "$REPO" in
  Accu-Mk1)            FLAG=--mk1 ;;
  integration-service) FLAG=--is ;;
  coabuilder)          FLAG=--coabuilder ;;
  accumarklabs)        FLAG=--accumarklabs ;;
  *) echo "ERROR: origin is '$REPO'; expected one of the four Accumark repos." >&2; exit 1 ;;
esac

if [ "$PUSH" = 1 ]; then
  git push -q -u origin "$BRANCH"
  echo "pushed $REPO $BRANCH"
fi

# Runs ON the devbox. Shipped as a function body so nothing is piped over
# stdin: `accumark-stack mount` shells out to docker compose, which can eat
# the rest of a script arriving on stdin.
remote() {
  set -euo pipefail
  local repo="$1" branch="$2" stack="$3" flag="$4"
  local main="$HOME/accumark-repos/$repo" wt="$HOME/worktrees/$repo-$stack"
  [ -d "$main/.git" ] || { echo "ERROR: $main missing on the devbox. Clone it first (see ~/README-accumark.txt)." >&2; exit 2; }
  git -C "$main" fetch -q origin "$branch"
  if [ -d "$wt" ]; then
    if [ "$(git -C "$wt" rev-parse --abbrev-ref HEAD)" != "$branch" ]; then
      git -C "$wt" checkout -q "$branch" 2>/dev/null || git -C "$wt" checkout -q -b "$branch" "origin/$branch"
    fi
    if ! git -C "$wt" pull -q --ff-only 2>/dev/null; then
      echo "branch was rewritten; resetting the devbox worktree to origin/$branch"
      git -C "$wt" reset -q --hard "origin/$branch"
    fi
    echo "synced $wt @ $(git -C "$wt" log --oneline -1)"
    echo "(already mounted: live reload picks it up; if services look stale, run:  accumark-stack mount $stack $flag $wt)"
    return 0
  fi
  git -C "$main" worktree add -q "$wt" -b "$branch" "origin/$branch" 2>/dev/null \
    || git -C "$main" worktree add -q "$wt" "$branch"
  echo "worktree $wt @ $(git -C "$wt" log --oneline -1)"
  "$HOME/accumark-stack/bin/accumark-stack" mount "$stack" "$flag" "$wt" </dev/null
}

ssh "$HOST" "$(declare -f remote); remote '$REPO' '$BRANCH' '$STACK' '$FLAG'"

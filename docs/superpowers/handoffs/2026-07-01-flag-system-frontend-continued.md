# Handoff: Flag System — Activity / Mentions / Unread + polish (PR #28, cont.)

*Created 2026-07-01. Paste into a fresh session — or "Read docs/superpowers/handoffs/2026-07-01-flag-system-frontend-continued.md and continue" — to resume with full context.*

---

You're picking up the **Flag System** frontend for Accu-Mk1 (a lab-anchored task/thread system — the "anti-Slack"). Everything since the backend+SSE merges lives on **one open PR, #28** (`feat/flag-system-frontend`), **held for the user's visual sign-off**. Status: **in-flight, feature-rich, awaiting the user's OK to merge.** This session (2026-07-01) continued from the 2026-06-30 handoff and added the Activity tab, @mentions, per-flag unread state, and a batch of visual tweaks. Work happens in a **laptop edit-loop** (edit `C:/tmp/flag-ui` → commit → push → devbox worktree `git reset --hard` → vite HMR / backend restart). Full design history: memory `project_flag_system_design` + the specs/plans in `docs/superpowers/`.

## Working directories

| Repo / dir | Path | Branch | Latest commit |
|---|---|---|---|
| **Laptop edit-loop worktree** (source of truth) | `C:/tmp/flag-ui` | `feat/flag-system-frontend` | `23d7894` |
| **Devbox live worktree** (mounted in the flagsfe stack) | `forrestparker@100.73.137.3:~/worktrees/Accu-Mk1-flagsfe` | `feat/flag-system-frontend` | `23d7894` |
| Laptop Accu-Mk1 (OneDrive, master) | `C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1` | `master` | prior handoff lives here |
| Devbox Accu-Mk1 main checkout | `~/accumark-repos/Accu-Mk1` | `master` | read-only base + `gh` |

**PR #28**: `OPEN / MERGEABLE / CLEAN`, ~98 files. HEAD `23d7894`. Working tree clean (all pushed). Other devbox worktrees/stacks (`boxing`, `catalog`, `gfinal`, `host`) are **other work — leave alone.**

## What's on the branch

**Layer 0 — merged to master (don't touch):** Plan 1 flag backend (PR #24), vite `/api` proxy (#25), Plan 2 SSE (#27). The SSE bus broadcasts every event to all users; **the client decides relevance.**

**Layer 1 — prior PR #28 work (from the 2026-06-30 handoff):** Plans 3–8 — Flags button + slide-over flyout (4 triage tabs), thread view, RaiseFlagButton compose, entity integration + resolved context, managed `flag_types` catalog + Blocked status, overview `FlagIndicator` (Order Status/kanban/Customer), 880px wide flyout + `FlagsFilterBar`, list/table toggle.

**Layer 2 — this session's features (all committed, self-verified typecheck+lint+vitest+pytest+build):**
- **Persistent unseen pulse + row flash + auto-jump.** The Flags-bar "you have new pings" pulse is now persisted (`use-flag-unseen.ts`, localStorage `flags:unseen` + `flags:unseenTab`) so it survives reload; opening the flyout snapshots pinged ids (`justOpened`) to pulse those rows and auto-jumps to the tab holding the newest ping. Transient/per-session (distinct from the durable unread markers below).
- **Rich + clickable ping toast.** Toasts carry an `Entity · Type · Status` meta line (`flag-toast.tsx`); clicking the toast opens the flag. **Gotcha fixed:** sonner v2 has no whole-toast `onClick` — handlers live on the rendered heading/body nodes.
- **Activity tab** (`FlagActivityFeed`/`FlagActivityRow`, `flag-activity.ts`) — newest-first infinite-scroll feed of events relevant to you (assignee/creator/participant + own actions). Backend `GET /api/flags/activity` (keyset cursor, `service.list_activity`, index `ix_flag_events_created_at_id`).
- **@mentions** (`mention-parse.ts`, picker in `FlagThread`, `flag-relevance.ts`). `@`-autocomplete (Tab or Enter completes); a mention notifies the user **even if unassigned** ("You were mentioned") and adds them as a watcher; mentions render as chips; stored on `flag_comments.mentions` + tagged into the `commented` event's `details.mentions`. **Decision (locked): watchers do NOT get live toasts** — only explicit mentions do; relevance = assignee OR creator OR mentioned.
- **Per-flag unread state** (server-side, cross-device). `flag_reads(user_id, flag_id, last_read_at)`; unread = relevant flag changed since last read; cleared when you open its thread. Dedicated-color left-bar marker (`--flag-unread`, magenta `#ec4899`), per-tab unread dots, a new **Unread tab** (count badge), `mark-read` on thread-open. Backend `GET /api/flags/unread` + `POST /api/flags/{id}/read`, `service.list_unread`/`mark_read`, shared `_relevant_flag_ids` (reused by activity). FE: `useFlagUnread`, `unread-buckets.ts`.

**Layer 3 — visual tweaks this session:**
- **Type filter** added to `FlagsFilterBar` (managed catalog, colored dot per type, incl. inactive) + `flag-filter.ts` `type` field.
- **Gold header glow** — `flags-pulse` keyframes changed red → `rgba(234, 179, 8, …)`.
- **Sample column removed** from the flyout **table** view (`FlagTable` now 7 cols; the sample/analytes context still shows in the **list/card** view).
- **Un-flagged `FlagIndicator` → opens Raise-a-flag directly** (sample scope presets target; order scope offers a sample picker) instead of an empty scoped flyout; flagged still opens the flyout.

## Critical operational gotchas

| Gotcha | Why it matters | How to handle |
|---|---|---|
| **Docker Desktop stole the CLI context** | User installed Docker Desktop on the devbox → CLI default flipped to the empty `desktop-linux` daemon. Symptom: `docker ps` empty, "service not running", stacks show "running" in the registry, but `:5552` still serves (real containers run under the **native** daemon). | `docker context use default` restores it. **Durable fix (do this):** uninstall Docker Desktop or `systemctl --user disable --now docker-desktop`, else it re-grabs the context on reboot. Verify with `docker context show` (must be `default`). |
| `docker compose exec -T` eats heredoc stdin | In `ssh … bash -s <<'REMOTE'` scripts, the first `exec -T …` reads the rest of the heredoc as its stdin, silently dropping later commands. | Append `</dev/null` to each `exec`, **or** use single-quoted `ssh '… && … && …'` chains instead of a heredoc. |
| sonner v2 has no whole-toast `onClick` | `ExternalToast` only exposes the action-button onClick; a top-level `onClick` is silently ignored (why click-to-open "never worked"). | Wire handlers onto the content nodes you render (heading + body), not the toast options. |
| `create_all` ≠ column migrations | New **tables** (`flag_reads`) are created by `create_all` on startup; new **columns** on existing tables (`flag_comments.mentions`) are NOT — they need an idempotent `ALTER … IF NOT EXISTS` in `database.py` `_run_migrations()`. | Restart the backend after schema changes; verify the table/column via a quick `inspect(...)`/`pg_indexes` query. |
| Live backend doesn't hot-reload routes/models | The running uvicorn won't have new routes until restarted. A `TestClient` smoke uses a fresh import (works regardless), but the live `:5552` frontend needs `docker compose -p accumark-flagsfe restart accu-mk1-backend`. | Restart the backend after adding endpoints/migrations, then confirm healthy. |
| Windows CRLF → prettier drift | Laptop edits commit as CRLF; prettier flags several files (`--check` warns). | After gates pass, `prettier --write` the flagged files **in the container**, commit from the devbox (`git -c user.name=… -c user.email=… commit -aqm …`), push, then `git reset --hard origin` on the laptop. |
| `npm run check:all` is red at baseline | ~19 pre-existing vitest failures unrelated to flags. | Gate on typecheck + lint(changed) + **flag** vitest (`src/components/flags` → 71) + **flag** pytest (`tests/test_flags_*.py`) + build — NOT the aggregate. |
| Benign `migration_skipped` on startup | `lims_analyses`/`flag_flags` review_state CHECK migrations log a violation and are skipped (per-statement isolation). | Ignore — it's noise, not a failure; unrelated to flag work. |

## Infrastructure state

- **flagsfe stack UP** on devbox (`forrestparker@100.73.137.3`), **native `default` docker context**, block 2, ports 5540–5559. **Mk1: http://100.73.137.3:5552** — login **`admin@accumark.local` / `flagsdemo2026`**. Backend `:5550` (healthy). Mounted on `~/worktrees/Accu-Mk1-flagsfe`. Frontend = vite HMR; backend = restart for new routes/schema.
- **Docker context MUST be `default`.** If `docker ps` looks empty / "service not running": `docker context use default`.
- **Edit-loop:** edit `C:/tmp/flag-ui` → `git commit` → `git push` → on devbox `cd ~/worktrees/Accu-Mk1-flagsfe && git fetch && git reset --hard origin/feat/flag-system-frontend` → HMR (FE) or `docker compose -p accumark-flagsfe restart accu-mk1-backend` (BE).
- **After #28 merges:** `ssh … 'cd ~/accumark-stack && ./bin/accumark-stack destroy flagsfe --yes'` + `git worktree remove --force ~/worktrees/Accu-Mk1-flagsfe`.

## Verification commands (re-run, don't trust stale numbers)

| What | Command (from `~/worktrees/Accu-Mk1-flagsfe`, append `</dev/null` to each exec) |
|---|---|
| PR #28 | `ssh … 'cd ~/accumark-repos/Accu-Mk1 && gh pr view 28 --json state,mergeable,changedFiles'` |
| Frontend typecheck | `docker compose -p accumark-flagsfe exec -T accu-mk1-frontend sh -c "cd /app && npm run typecheck"` |
| Flag vitest (→ 71) | `… exec -T accu-mk1-frontend sh -c "cd /app && npx vitest run src/components/flags"` |
| Flag pytest | `… exec -T accu-mk1-backend sh -c "cd /app && python -m pytest tests/test_flags_activity.py tests/test_flags_mentions.py tests/test_flags_unread.py tests/test_flags_routes.py -q"` |
| Build | `… exec -T accu-mk1-frontend sh -c "cd /app && npm run build"` |
| Live API smoke | TestClient in-container: mint admin JWT via `auth.create_access_token(data={'sub': str(admin.id)})`, hit `/api/flags/unread` etc. (pattern in this session's smokes / `project_flag_system_design`). |

## Outstanding items the user may want next

1. **Visual sign-off** on the latest tweaks (Type filter, gold glow, Sample-column removal, un-flagged-indicator → Raise-a-flag). Awaiting feedback at `:5552`.
2. **Color tuning** — the dedicated `--flag-unread` (magenta `#ec4899`, in `App.css`) and the gold glow (`rgba(234, 179, 8, …)` in `flags-pulse`). User may want different shades; both are one-line changes.
3. **Merge PR #28** once the user signs off visually — then tear down flagsfe (commands above). **Do NOT merge without explicit OK.**
4. **Durable Docker fix** — uninstall/disable Docker Desktop on the devbox so it stops orphaning the CLI context.
5. **Deferred backlog (all noted in specs):** watcher live-toasts / per-flag mute (watchers deliberately get NO live toasts today); live-prepend into an open Activity feed; comment-edit re-mention reconciliation; "mark all read" / manual mark-unread; Activity day-grouping; resolved entity label (entity shows short "Vial 42", not "Vial P-1023-3").
6. **Next flaggable entity types** — the user flagged interest in sample preps / peptides / calibration curves; recipe in `docs/developer/flags-add-entity.md` (3 additive edits per type).

## User collaboration preferences

- **Iterative live-stack review is the rhythm:** build → user looks at `:5552` → asks for a tweak. **Keep the same URL** — edit in the live worktree, don't spin new stacks.
- **Drives forward decisively; short answers; course-corrects on the visual result.** Prefers **free-text over multiple-choice** (rejected `AskUserQuestion` modals earlier in the arc).
- **PR #28 is HELD for explicit visual sign-off — do NOT merge without the user saying so.**
- **Additive only; TDD; verify before asserting** (re-run gates + a live check; never trust worker/self-report for git/stack/test state).
- **npm only; Zustand selector syntax** (ast-grep enforced); **dedicated color tokens** (`--flag-unread`), type color stays in the pill.
- **Process:** brainstorm → spec → plan → execute for features; inline edit-loop for small tweaks. Specs/plans live in `docs/superpowers/{specs,plans}/` (dated `2026-07-01-*`).

## Recommended first action in the new session

Confirm live state, then ask the user for sign-off / next tweak:
```bash
ssh forrestparker@100.73.137.3 'docker context show && cd ~/accumark-repos/Accu-Mk1 && git log --oneline -3 origin/feat/flag-system-frontend && gh pr view 28 --json state,mergeable -q ".state, .mergeable" && cd ~/accumark-stack && ./bin/accumark-stack list | grep flagsfe'
```
Then ask: how do the latest tweaks (type filter, gold glow, sample-column removal, un-flagged → Raise-a-flag) look at `:5552` — sign off on #28, another tweak, or start one of the backlog items?

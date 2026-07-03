# Flag System — @mentions in comments

*Design spec. Created 2026-07-01. Part of the Flag System frontend work on PR #28
(`feat/flag-system-frontend`).*

## Summary

Let a commenter `@`-mention a specific lab user, who then gets a **live
notification even if they aren't assigned to the flag**. The mention also adds
them as a watcher, so the flag surfaces in their Watching tab + Activity feed —
but *only* the explicit mention pings live; watching does not raise toasts.
Additive only.

## Motivation

Comments today notify only the assignee/creator; you can't pull a specific person
into a flag they're not on. This adds a first-class "call someone out" path — the
mentioned user is notified live and looped in as a watcher.

## Decisions (locked with the user)

- **Compose = `@`-autocomplete picker** (not freehand text parsing): unambiguous
  resolution to a user id.
- **Mention adds the user as a watcher** (participant), not a one-time ping — they
  keep seeing updates via the Watching tab + Activity feed.
- **Watchers do NOT get live toasts.** Only an explicit mention notifies live
  (a toast per watched-flag event was judged too noisy). The mention is the single
  live ping; follow-ups reach the watcher quietly via Watching/Activity. Relevance
  stays **assignee OR creator OR mentioned** — no watcher clause, no payload change
  to carry watcher ids.

## Data model

- **`flag_comments.mentions`** — new nullable `JSON` column: the list of mentioned
  user ids captured at post time. Idempotent startup DDL:
  `ALTER TABLE flag_comments ADD COLUMN IF NOT EXISTS mentions JSON`.
- Watchers reuse the existing `flag_participants` table (role `watcher`).
- No new tables.

## Backend

### `add_comment` — accept + store mentions, add watchers, tag the event

```
def add_comment(db, *, user, flag_id, body, mention_ids=None):
    ...
    valid = _valid_user_ids(db, mention_ids or [])   # dedup, existing users only
    c = FlagComment(flag_id=flag.id, author_id=actor_id, body=body.strip(),
                    mentions=valid or None)
    db.add(c)
    for uid in valid:                                 # add as watcher (silent, dedup)
        exists = db.execute(select(FlagParticipant).where(
            FlagParticipant.flag_id == flag.id,
            FlagParticipant.user_id == uid)).scalar_one_or_none()
        if exists is None:
            db.add(FlagParticipant(flag_id=flag.id, user_id=uid,
                                   role="watcher", added_by=actor_id))
    flag.updated_at = datetime.utcnow()
    _audit(db, flag, actor_id, "commented",
           details={"mentions": valid} if valid else None)
    _commit_and_emit(db)
    ...
```

- `_valid_user_ids` filters to ids present in the user directory (via the user
  seam / `models.User`), deduped, self-mention allowed (harmless — glue suppresses
  self-notify). Adding watchers emits **no** `watcher_added` events (silent — avoids
  notification spam); the single `commented` event carries `details.mentions`.

### Schemas / route

- `CommentRequest` gains `mention_ids: list[int] | None = None`.
- `CommentResponse` gains `mentions: list[int]` (default `[]`) for rendering.
- `POST /api/flags/{id}/comments` passes `mention_ids` through to `add_comment`.

## Frontend

### API + types (`lib/flags-api.ts`)

- `CommentResponse` gains `mentions: number[]`.
- `addComment(id, body, mentionIds?)` sends `{ body, mention_ids }`.

### Notification glue (`use-flag-stream-glue.ts`)

Relevance widens to include **mention** only (no watcher clause):

```
const mentions = Array.isArray(e.details?.mentions) ? e.details.mentions as number[] : []
const iAmMentioned = me != null && mentions.includes(me)
const relevant = me != null && !isMyAction && (
  e.flag.assignee_id === me || e.flag.created_by === me || iAmMentioned
)
```

- Toast title: when `iAmMentioned` → **"You were mentioned"** (else the existing
  titles). The persisted unseen-pulse + fly all work unchanged (they key off
  relevance).
- The `markUnseen` tab pick stays `assigned`/`raised`; a mention lands under the
  `assigned` fallback (fine — the toast + bar are the signal; the row also appears
  in Watching/Activity for the now-watching user).

### Compose — `@`-autocomplete (`FlagThread.tsx` + a small `mention` helper)

- Detect the active `@token` at the caret in the comment `Input`. While a token is
  open, show a dropdown of directory users (`getWorksheetUsers`) filtered by
  name/email; ↑/↓ moves, Enter/click selects.
- Selecting inserts `@{displayName} ` at the caret and records `{id, name}` in a
  local `selectedMentions` set. On submit, `mention_ids` = the recorded ids whose
  `@name` substring is still present in the body (so deleting the text drops it).
- Pure helper `mention-parse.ts`: `activeMentionQuery(value, caret)` →
  `{ query, start } | null`; `mentionIdsInBody(body, selected)` → `number[]`.

### Render (`FlagThread.tsx` comment body)

- A mentioned `@Display Name` renders as a highlighted chip. Resolve from the
  comment's `mentions` + the user directory: for each mentioned id, highlight the
  `@{displayName(id)}` occurrence in the body. Pure `renderCommentBody(body,
  mentions, nameOf)` returning text/chip segments — unit tested.

## Testing

**Backend (`tests/test_flags_mentions.py`):**
- `add_comment` with `mention_ids` stores `mentions`, adds each as a `watcher`
  participant (deduped, idempotent on re-mention), and the `commented` event's
  `details.mentions` lists them.
- Invalid / unknown ids are dropped.

**Frontend (vitest):**
- `mention-parse.test.ts` — `activeMentionQuery` (open token at caret, closes on
  space; none when no `@`); `mentionIdsInBody` (keeps referenced, drops removed).
- `renderCommentSegments` — splits a body into text + mention chips.
- `flag-relevance.test.ts`: an event where `me ∈ details.mentions` is relevant;
  assignee/creator relevant; self-actor suppressed; unrelated user not relevant.

## ISO 17025 alignment

- **Attribution (7.5.1):** a mention is recorded on the comment (`mentions`) and in
  the `commented` audit event's `details` — who called out whom is traceable, not
  ephemeral.
- **Personnel involvement:** adding the mentioned user as a participant records
  their association with the work item (`flag_participants`), supporting a legible
  record of who was brought into a decision.
- Read/notification is presentation only; no result or amendment path is affected.

## Scope guard (out for v1 — deferrable)

- In-app only — no email/SMS/push.
- No `@here` / `@channel` / role mentions.
- No re-mention reconciliation when a comment is edited (comment edit isn't a
  current feature; mentions are captured at post time).
- **Watchers get no live toasts** (only explicit mentions do). Per-flag mute /
  opt-in watcher toasts are a possible later follow-up.
- Mentions notify via the comment event only; no separate "mention inbox".

## Files

**Backend:** `flags/service.py` (`add_comment` mentions + watchers,
`_valid_user_ids`), `flags/models.py` (`FlagComment.mentions`), `flags/schemas.py`
(`CommentRequest.mention_ids`, `CommentResponse.mentions`), `flags/routes.py`
(pass-through), `database.py` (idempotent `mentions` column),
`tests/test_flags_mentions.py`.
**Frontend:** `lib/flags-api.ts`, `components/flags/use-flag-stream-glue.ts`
(relevance + title), `components/flags/flag-relevance.ts` (+ test),
`components/flags/mention-parse.ts` (+ test), `components/flags/FlagThread.tsx`
(picker + render), `components/flags/__tests__/*`.

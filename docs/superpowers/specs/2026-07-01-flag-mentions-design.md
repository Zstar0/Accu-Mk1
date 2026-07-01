# Flag System — @mentions in comments (+ watcher live-toasts)

*Design spec. Created 2026-07-01. Part of the Flag System frontend work on PR #28
(`feat/flag-system-frontend`).*

## Summary

Let a commenter `@`-mention a specific lab user, who then gets notified **even if
they aren't assigned to the flag**. Mentioning adds the person as a watcher, so
they stay looped in. In the same stroke, close the pre-existing "watchers get no
live toasts" gap: the event payload starts carrying the flag's watcher ids, so
the notification glue can treat watching (and mentions) as relevance — all
decided client-side from the payload. Additive only.

## Motivation

Comments today notify only the assignee/creator (the glue can't see watchers, and
mentions don't exist). You can't pull a specific person into a flag they're not
on. This adds a first-class "call someone out" path and — because mentions make
the target a watcher — it forces us to make *watching* actually deliver live
notifications (currently a documented gap).

## Decisions (locked with the user)

- **Compose = `@`-autocomplete picker** (not freehand text parsing): unambiguous
  resolution to a user id.
- **Mention adds the user as a watcher** (participant), not a one-time ping — they
  keep getting updates (Watching tab, Activity feed, and — via the change below —
  live toasts).
- **Close the watch-set gap now:** emit watcher ids in the payload so *any*
  watcher gets live toasts, not just mentioned users.

## Data model

- **`flag_comments.mentions`** — new nullable `JSON` column: the list of mentioned
  user ids captured at post time. Idempotent startup DDL:
  `ALTER TABLE flag_comments ADD COLUMN IF NOT EXISTS mentions JSON`.
- Watchers reuse the existing `flag_participants` table (role `watcher`).
- No new tables.

## Backend

### `_flag_summary` — carry watchers (closes the gap for ALL events)

`service._flag_summary(flag)` gains `"watchers": [p.user_id for p in flag.participants]`.
Every emitted event's `flag` snapshot now lists the current participant ids. (Small
list; lazy-loaded from the already-attached flag. Applies to every event type, so
watchers become notifiable everywhere.)

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
- `FlagSnapshot` (in `lib/flag-stream.ts`) gains `watchers: number[]` (default `[]`).
- `addComment(id, body, mentionIds?)` sends `{ body, mention_ids }`.

### Notification glue (`use-flag-stream-glue.ts`)

Relevance widens to include watcher + mention, all from the payload:

```
const mentions = Array.isArray(e.details?.mentions) ? e.details.mentions as number[] : []
const watchers = e.flag.watchers ?? []
const iAmMentioned = me != null && mentions.includes(me)
const relevant = me != null && !isMyAction && (
  e.flag.assignee_id === me || e.flag.created_by === me ||
  watchers.includes(me) || iAmMentioned
)
```

- Toast title: when `iAmMentioned` on a `commented` event → **"{Actor} mentioned
  you"** (else the existing titles). The persisted unseen-pulse + fly all work
  unchanged (they key off relevance).
- The `markUnseen` tab pick stays `assigned`/`raised`; a watcher/mention lands under
  `assigned` fallback (fine — the toast + bar are the signal; the row also appears
  in Watching/Activity).

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
- `_flag_summary` includes `watchers` = current participant ids (asserted via any
  event payload).

**Frontend (vitest):**
- `mention-parse.test.ts` — `activeMentionQuery` (open token at caret, closes on
  space; none when no `@`); `mentionIdsInBody` (keeps referenced, drops removed).
- `renderCommentBody` — splits a body into text + mention chips.
- Glue relevance test (extend existing coverage): an event where `me ∈
  flag.watchers` or `me ∈ details.mentions` is relevant; self-actor still suppressed.

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
- No per-flag mute (a follow-up if watcher toasts prove noisy).
- Mentions notify via the comment event only; no separate "mention inbox".

## Files

**Backend:** `flags/service.py` (`_flag_summary` watchers, `add_comment` mentions +
watchers, `_valid_user_ids`), `flags/models.py` (`FlagComment.mentions`),
`flags/schemas.py` (`CommentRequest.mention_ids`, `CommentResponse.mentions`),
`flags/routes.py` (pass-through), `database.py` (idempotent `mentions` column),
`tests/test_flags_mentions.py`.
**Frontend:** `lib/flags-api.ts`, `lib/flag-stream.ts` (`FlagSnapshot.watchers`),
`components/flags/use-flag-stream-glue.ts` (relevance + title),
`components/flags/mention-parse.ts` (+ test), `components/flags/FlagThread.tsx`
(picker + render), `components/flags/__tests__/*`.

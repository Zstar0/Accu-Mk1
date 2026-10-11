# Mk1 document provenance: contract (2026-10-11)

Mk1 is the canonical document store. Every `documents` row is one revision and now
carries its own provenance. Consumers (Paperclip, MCP, publisher) read it from Mk1;
they do not keep an authoritative copy.

## Request (POST /api/documents, create or revise)

Optional, additive. Older clients that omit it are unchanged.

```json
"provenance": {
  "source_system": "paperclip",
  "source_record_type": "issue",
  "source_record_id": "6f1c2a9e-...",
  "source_record_label": "ACC-111",
  "source_run_id": "run-7d1f0c2e"
}
```

- `source_system` must be registered (`backend/documents/provenance.py` `SOURCE_SYSTEMS`:
  accumk1, paperclip, valence-hq, slack, claude-code). Adding one is a one-line change.
- Identifiers only: type `^[a-z][a-z0-9_-]{0,39}$`; id and run `^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$`;
  label also allows spaces and `#`. No `/`, so no URL fits. A record id or label needs a type.
- Any other key is a 422 (`extra="forbid"`): a caller cannot send `verified`, `creator`,
  `company` or a user id. Top-level identity fields in the body (`creator_kind`,
  `co_author`, `requested_by_user_id`, ...) are ignored.
- `author` stays the requester's display name (legacy field, not moved).
- Provenance lands only on a NEW row. Identical bytes on an existing code (200, no new row)
  keep the existing revision's provenance.

## Response (every DocumentOut: create, detail, revisions[], list, patch, ...)

```json
"provenance": {
  "version": 1,
  "creator": {"kind": "agent", "id": "jarvis", "label": "jarvis", "verified": true},
  "requested_by": {"label": "Forrest Parker", "user_id": null, "verified": false},
  "source": {"system": "paperclip", "system_label": "Paperclip", "verified": false,
             "record_type": "issue", "record_id": "6f1c...", "record_label": "ACC-111",
             "run_id": "run-7d1f0c2e"},
  "content_edited": null
}
```

| Field            | Set by                                                                                                                                                                         | Verified when                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `creator`        | the credential: admin login = `user` + id, agent token = `agent` + name, internal service token = `service` / `internal-token`, in-process AI review = `service` / `ai-review` | always, except `unknown` (pre-provenance rows)                                           |
| `requested_by`   | admin login with no author or its own name/email = verified user id; any other `author` = supplied                                                                             | only for that login; never for agent or service writers (no delegation path exists)      |
| `source`         | the caller's `provenance` object                                                                                                                                               | only in-process Mk1 writers (AI review). Every HTTP caller's source is `verified: false` |
| `content_edited` | admin in-place draft edit (`PUT /content`)                                                                                                                                     | always (admin login)                                                                     |

An agent token proves the agent, not the channel: a Jarvis write without a `provenance`
object has `source: null`, never Paperclip.

The duplicate-content 409 `existing` object gains the same `provenance` key, only for a
writer that can already see the row. Its legacy keys are unchanged.

## Paperclip reference

Unchanged. `paperclip_ref()` emits exactly the keys Paperclip's strict schema accepts
(pinned by `test_paperclip_reference_carries_no_provenance_keys`). Paperclip renders
provenance by framing `/embed.html`, which shows the pinned revision's Provenance block.
If Paperclip later wants provenance in its own reference metadata, that is a coordinated
change to its strict schema first.

## Publisher and MCP

- `publish_document.py`: `--source-system`, `--source-record-type`, `--source-record-id`,
  `--source-record-label`, `--source-run`. Lost-response reconciliation now also requires the
  stored source to equal this request's, and treats a `200` on the retry of a revise as an
  uncertain outcome (exit 5) unless every field matches.
- labmanager-mcp `documents_create` / `documents_revise`: same five optional params, sent only
  when given. `draft` still defaults to False and is always sent explicitly as `activate`;
  changing that default needs sign-off.

## Migration, backfill, rollback

- One idempotent `ALTER TABLE documents ADD COLUMN IF NOT EXISTS ...` statement in
  `database._run_migrations` (11 nullable columns; `source_verified BOOLEAN NOT NULL DEFAULT
FALSE`; two FKs to `users(id) ON DELETE SET NULL`). Fresh databases get the same DDL from
  `create_all` (proven identical on Postgres 16, both paths).
- No index: nothing looks documents up by source yet. Add one with the first real query.
- No backfill writes. Pre-provenance rows are derived at read time from columns the server
  always set: `created_by_user_id` = user, `co_author` = agent, otherwise `unknown`.
  `source_session` and other free text are never parsed.
- Rollback = redeploy the previous image. It ignores the new columns and keeps writing
  (proven on Postgres); rows it writes read as `unknown` creator after the next upgrade.
  Optional cleanup SQL, only after a decision not to roll forward:
  `ALTER TABLE documents DROP COLUMN creator_kind, DROP COLUMN creator_ref, DROP COLUMN
requested_by_user_id, DROP COLUMN content_edited_by_user_id, DROP COLUMN content_edited_at,
DROP COLUMN source_system, DROP COLUMN source_verified, DROP COLUMN source_record_type,
DROP COLUMN source_record_id, DROP COLUMN source_record_label, DROP COLUMN source_run_id;`

## Deliberately not built

- Source links: no registered origin exists for any source system. When one does, build the
  link from that origin plus the validated record id, never from caller text.
- Provenance correction events: provenance is immutable; no case has needed a correction.
- Verified delegation (an agent proving which human asked): needs an issuer, audience,
  binding, expiry and replay design reviewed first.
- Multi-tenancy: Mk1 is a single-organization deployment. Spaces and their grants remain
  the only read boundary.

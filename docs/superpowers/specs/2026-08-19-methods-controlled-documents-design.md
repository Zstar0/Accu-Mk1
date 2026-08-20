# Methods — controlled documents (slice 3)

*Designed 2026-08-19 with the Handler. Slice 3 of the methods/instruments
program — builds on slice 1 (foundation: generic fields, `method_services`,
`supersedes_id` seeded) and slice 2 (bench stamping). Turns method rows into
controlled documents: revisions, immutability, status lifecycle, attachments,
CRUD audit. This is the ISO 17025-alignment slice
([[project_iso17025_alignment]]). Mk1-only.*

## 1. Problem

After slices 1–2, methods are stamped onto results and printed on COAs — but a
method row is still freely editable and deletable-when-unused. For ISO 17025
alignment a method must behave like a controlled document: revisions are
issued, the content of an issued revision never changes, results pin the exact
revision they were run under, procedure documents attach to the method, and
every change is attributable.

The version-pinning mechanism was deliberately designed in slice 1 (R4):
**revision = new row**, so `lims_analyses.method_id` pins the exact revision
forever with no version-at-time reconstruction. This slice builds the
lifecycle around that ruling.

## 2. As-is facts (post slices 1–2; verify at plan time)

- `hplc_methods.active` boolean is the sole lifecycle switch; `supersedes_id`
  exists but nothing writes it. Slice 1's DELETE guard 409s once any
  `lims_analyses` row references the method.
- 🔴 **`hplc_methods.name` is globally UNIQUE** (`hplc_methods_name_key`,
  pre-existing) and `code` is partial-unique (slice 1). A same-name/same-code
  revision clone violates both — this slice owns the index migrations (§4.2).
- Slice 1's fail-open default rule: a `method_services.is_default` row whose
  method is inactive resolves to *no default* — deactivation/retirement never
  blocks the bench.
- Attachment precedent: `LimsParentAttachment` (`models.py:1198`) — S3-backed
  with a `storage` discriminator and frozen-bytes snapshot semantics. Reuse
  the S3 store and upload/serve idioms; confirm bucket/key conventions at
  plan time.
- Admin-CRUD audit precedent: `catalog/change_log.py::log_create/log_update`
  (used by profiles, vial roles, services). Method and instrument CRUD do not
  log today.
- COA prints the method **name** (`_method_label`); certificates and parent
  rows referencing a retired revision keep printing it (FK intact —
  retirement is a status, not a deletion).

## 3. Rulings

- **R0 (program-wide, inherited from slice 1) — zero new SENAITE coupling.**
  Revisions, attachments (`storage='s3'` only — never `'senaite'`), lifecycle
  verbs, and audit rows are all Mk1-native. Revision clones never copy
  `senaite_id` (it stays on the original legacy row only, preserving the
  clone's `(name, revision)` identity without inheriting dead provenance).
- **R9 — status over boolean, in lockstep.** New `status` column
  (`draft | active | retired`); `active` boolean is kept and maintained by
  the single write path (`active ⇔ status = 'active'`) so every existing
  reader (pickers, fail-open default rule, COA) keeps working unchanged.
  No reader migrates in this slice.
- **R10 — issued content is immutable.** Once a row leaves `draft` (or is
  referenced by any analysis, whichever first), its methodological fields
  lock: `name`, `code`, `revision`, `technique`, `reference`,
  `procedure_summary`, and the HPLC parameter columns. Corrections = new
  revision. Always-editable: `notes`, `department_id` (org routing isn't
  method content). `PUT` returns 409 naming the locked fields.
- **R11 — one active revision per code; defaults ride the activation.**
  Activating a draft atomically retires the currently active same-code
  revision and moves its `method_services.is_default` flags to the new
  revision's rows. The bench never sees two live revisions of one method.
- **R12 — drafts are invisible to the bench.** Pickers (slice 2) and
  `default_method_id` offer `active` only. Drafts are admin-side documents
  until activated. Drafts may be deleted (they are unreferenced by
  construction — R12 + slice 1's guard as backstop).

## 4. Design

### 4.1 Schema — lifecycle columns

| Column | Type | Notes |
|---|---|---|
| `status` | VARCHAR(10) NOT NULL CHECK IN ('draft','active','retired') | backfill: `active=true → 'active'`, else `'retired'`. |
| `revision` | INT NOT NULL DEFAULT 1 | backfill 1. |
| `activated_at`, `retired_at` | TIMESTAMP NULL | stamped by transitions. |

### 4.2 Index migrations (supersede slice 1's / the pre-existing)

- DROP `hplc_methods_name_key` → `UNIQUE (name, revision)`.
- DROP slice 1's partial unique on `code` → `UNIQUE (code, revision)` (both
  NULL-tolerant as today) + partial unique `(code) WHERE status = 'active'`
  (one live revision per code).
- Idempotent `database.py` migration; existing single-revision rows satisfy
  all three trivially.

### 4.3 Lifecycle verbs

- **`POST /hplc/methods/{id}/new-revision`** — allowed from `active` or
  `retired`. Clones the row (`status='draft'`, `revision = max(revision of
  code)+1`, `supersedes_id = source.id`), clones `method_services` rows
  **with `is_default = false`** (defaults transfer only at activation, R11),
  clones `instrument_methods` links. Returns the draft.
- **`POST /hplc/methods/{id}/activate`** — draft only. One transaction: for
  each service the **superseded revision** (`supersedes_id` source, regardless
  of its status — a retired predecessor's flags are inert under the fail-open
  rule but still record intent) holds a default on, move the flag to the new
  revision's row for that service (flag off first, then on — the partial
  unique makes any other order impossible); if the predecessor is still
  `active`, it → `retired` (`active=false`, `retired_at`); this row →
  `active` (`active=true`, `activated_at`). First-ever activation (no
  predecessor) just flips status.
- **`POST /hplc/methods/{id}/retire`** — active only. Status → retired;
  defaults resolve to none via the slice-1 fail-open rule; stamped history
  and COA labels unaffected.
- `DELETE` remains slice 1's guarded delete; drafts delete freely.
- No `un-retire`: reissue as a new revision (immutability stays simple).

### 4.4 Attachments — `method_attachments`

```
method_attachments(
  id PK, method_id FK hplc_methods ON DELETE CASCADE,
  filename, content_type, size_bytes,
  storage VARCHAR NOT NULL DEFAULT 's3', s3_key,
  uploaded_by_user_id FK users SET NULL, created_at
)
```

Routes: upload (POST multipart), download (GET, streamed via the existing S3
serve idiom), DELETE **while the method is `draft` only** — once issued,
attachments are part of the controlled document. Uploads stay allowed on
`active`/`retired` rows (supporting records accrue), deletes don't.
New-revision does **not** clone attachments (documents belong to the revision
they were filed under; the panel shows the predecessor's via the chain).

### 4.5 CRUD audit

`log_create`/`log_update` (change_log idiom) on method create/update/lifecycle
verbs and instrument create/update — covering slice 1's surfaces
retroactively. Lifecycle verbs log as updates with the status delta;
attachment upload/delete log too.

### 4.6 `coa_method_text` auto-suggest

In the profile editor's COA Section block: a "Suggest from methods" action
that derives text from the members' active default methods (e.g.
`"AM-ELEM-001 — ICP-MS per USP <232>/<233>"`, joined when several). Fills the
field for the admin to edit; never auto-writes, override always kept —
`coa_method_text` remains the authored display string (#106 contract
unchanged).

### 4.7 FE (MethodsPage / MethodPanel)

Status chip (draft amber / active green / retired zinc); Activate / Retire /
New revision verbs with confirm dialogs (Activate's confirm names the
revision being retired and the defaults moving); revision history block
(walks the `supersedes_id` chain, links across revisions); attachments block
(upload/list/download, delete on drafts); locked fields render read-only with
a lock affordance on non-draft rows. Pickers elsewhere: no change needed —
they already read `active`.

### 4.8 Explicit non-goals

No approval/e-signature workflow (two-person review is a possible slice 4 if
the ISO program demands it). No training records. No instrument
calibration/maintenance log (separate later program). No change to what the
COA prints (still the method *name*; whether certificates should print
`code Rev N` is a Handler ruling ledgered below). No SENAITE/IS/WP changes.
No reader migration off `active`.

## 5. Failure modes addressed

| Mode | Control |
|---|---|
| Issued procedure silently edited | R10 field locks, 409 with field list |
| Two live revisions of one method | partial unique `(code) WHERE status='active'` + R11 transaction |
| Defaults lost or doubled across a revision flip | flag-move inside the activation transaction; partial unique backstop |
| Name/code collisions on clone | §4.2 index migrations |
| Unattributable method changes | §4.5 CRUD audit |
| Historical COA/result loses its method | revision rows never deleted once referenced (slice 1 guard); retirement is status-only |

## 6. Acceptance (arcitest)

1. `AM-ELEM-001` rev 1 active with stamped analyses (slices 1–2 state): edit
   `procedure_summary` → 409 naming the locked field; edit `notes` → 200.
2. New revision → rev 2 draft, cloned links, `is_default=false`, supersedes
   chain set; drafts absent from every picker and from `default_method_id`.
3. Activate rev 2 → rev 1 retired, defaults now resolve to rev 2, one-active-
   per-code index holds; rev 1's stamped analyses and the P-0157 COA still
   show rev 1's identity.
4. Retire rev 2 with no successor → `default_method_id` NULL (fail-open),
   bench picker unfiltered, nothing 500s.
5. Upload an SOP PDF to the rev 2 draft; delete allowed; activate; delete →
   403/409; download streams.
6. change_log rows exist for every create/update/lifecycle/attachment act.

## 7. Follow-ups ledgered

- **Handler ruling:** should certificates print `code Rev N` instead of the
  bare method name? (Compendial practice says yes; touches COABuilder wire —
  its own small slice if ruled.)
- Approval workflow (draft → reviewed → active, two-person) as slice 4 if the
  ISO program requires it.
- Reader migration off the `active` boolean once all consumers are
  status-aware.
- Instrument calibration/maintenance event log.

# Parent-AR Read-Flip — Layer 2: Internal Remarks Native-Authoritative Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parent-AR internal remarks move fully into Mk1: new `lims_sample_remarks` table, the receive flow writes natively (SENAITE `Remarks` write deleted — no dual-write era), the lookup serves native remarks in BOTH read modes, and a one-time idempotent backfill sweeps SENAITE history.

**Architecture:** The total SENAITE footprint for parent-AR remarks is two sites — the receive endpoint's step-2 write (`main.py` `receive_senaite_sample`) and the lookup's `Remarks` parse (`main.py` `lookup_senaite_sample`). Both flip to a new native table. A shared helper `_native_sample_remarks(db, sample_id)` produces the `SenaiteRemark` list; the lookup calls it in place of the SENAITE parse (covers senaite mode and everything that wraps the lookup), and the registry details endpoint re-applies it (idempotent) so its test harness — which mocks the lookup — can prove the wiring. **Out of scope:** vial/sub-sample remarks (`sub_samples/senaite.py::update_remarks`, `LimsSubSample.remarks`) — already native-per-vial with legacy-vial SENAITE mirroring; that mirroring retires at SENAITE-disconnect, not here.

**Tech Stack:** FastAPI + SQLAlchemy + Postgres (raw idempotent DDL in `database.py` migrations — which run BEFORE `create_all`, so the migration must carry the full `CREATE TABLE IF NOT EXISTS`, the `lims_capture_tokens` precedent). Tests: pytest in the `readflip-test` container (bind-mounted to this worktree, live dev DB, TEST-prefixed rows): `docker exec readflip-test sh -c "cd /app && python -m pytest <files> -q"`.

**Spec:** `docs/superpowers/specs/2026-07-14-parent-ar-read-flip-design.md` §6.

## Global Constraints

- All schema additive, `lims_` prefix, idempotent DDL, monotonic CHECKs only.
- The receive endpoint's user-visible contract is unchanged: same request/response models, same `steps_done` step name (`remarks_added`), remark save remains a hard step (failure fails the receive with the same response shape).
- The deliberate irreversibility (spec §11): SENAITE's `Remarks` field goes stale from this layer's deploy — nothing reads it (verified: COABuilder ✗, IS ✗; the lookup is repointed in this same layer).
- Gate: backend full-suite failure-set diffs clean vs `C:\Users\forre\Downloads\Obsidian\TerraVex\TerraVex\Sessions\handoffs\gate-backend-failures-v140-master.txt` (60 names).
- Commit trailers on every commit:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01L7mtRqLeMEzMfN5oCSUxAA`

---

### Task 1: `lims_sample_remarks` schema + model

**Files:**
- Modify: `backend/models.py` (add `LimsSampleRemark` after the `LimsSample` class, which starts at ~line 721)
- Modify: `backend/database.py` (append three statements to the `migrations` list, directly after the `"ALTER TABLE lims_packaging_photos ADD COLUMN IF NOT EXISTS capture_token_id ..."` entry that currently ends the list)
- Test: `backend/tests/test_lims_sample_remarks_schema.py` (new)

**Interfaces:**
- Produces: `LimsSampleRemark` model — `id, lims_sample_pk (FK lims_samples CASCADE), content (Text, NOT NULL), author_user_id (FK users SET NULL, nullable), author_label (String(200), nullable), created_at (DateTime, NOT NULL, default utcnow)`. Tasks 2-4 import it from `models`.

- [ ] **Step 1: Write the failing schema test**

Create `backend/tests/test_lims_sample_remarks_schema.py`:

```python
"""Schema + model coverage for lims_sample_remarks (read-flip spec §6).

House pattern: live dev DB, TEST-prefixed rows, FK-safe cleanup.
"""
import hashlib

import pytest
from sqlalchemy import select, text

from database import SessionLocal, engine, init_db
from models import LimsSample, LimsSampleRemark


TEST_SAMPLE_ID = "TEST-RMK-SCHEMA-P1"


@pytest.fixture()
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        # FK-safe cleanup: remarks ride the CASCADE on lims_samples
        row = s.execute(select(LimsSample).where(
            LimsSample.sample_id == TEST_SAMPLE_ID)).scalar_one_or_none()
        if row is not None:
            s.delete(row)
            s.commit()
        s.close()


def test_model_round_trip_and_cascade(db):
    parent = LimsSample(sample_id=TEST_SAMPLE_ID, sample_type="x",
                        status="sample_received")
    db.add(parent)
    db.commit()
    db.refresh(parent)

    db.add(LimsSampleRemark(lims_sample_pk=parent.id,
                            content="<p>test remark</p>",
                            author_label="test.user"))
    db.commit()

    got = db.execute(select(LimsSampleRemark).where(
        LimsSampleRemark.lims_sample_pk == parent.id)).scalar_one()
    assert got.content == "<p>test remark</p>"
    assert got.author_user_id is None
    assert got.author_label == "test.user"
    assert got.created_at is not None

    # CASCADE: deleting the sample removes the remark
    remark_id = got.id
    db.delete(parent)
    db.commit()
    assert db.execute(select(LimsSampleRemark).where(
        LimsSampleRemark.id == remark_id)).scalar_one_or_none() is None


def test_dedup_index_blocks_exact_duplicate(db):
    """The backfill's idempotency key: (lims_sample_pk, created_at,
    md5(content)) unique. Same triple → second INSERT must not create a row
    (ON CONFLICT DO NOTHING path used by the backfill)."""
    parent = LimsSample(sample_id=TEST_SAMPLE_ID, sample_type="x",
                        status="sample_received")
    db.add(parent)
    db.commit()
    db.refresh(parent)

    params = {"pk": parent.id, "content": "<p>dup</p>",
              "created": "2026-01-02T03:04:05"}
    ins = text(
        "INSERT INTO lims_sample_remarks "
        "  (lims_sample_pk, content, author_label, created_at) "
        "VALUES (:pk, :content, 'seed', :created) "
        "ON CONFLICT DO NOTHING"
    )
    db.execute(ins, params)
    db.execute(ins, params)
    db.commit()

    n = db.execute(text(
        "SELECT COUNT(*) FROM lims_sample_remarks WHERE lims_sample_pk=:pk"
    ), {"pk": parent.id}).scalar()
    assert n == 1
```

- [ ] **Step 2: Run to verify it fails**

Run: `docker exec readflip-test sh -c "cd /app && python -m pytest tests/test_lims_sample_remarks_schema.py -q"`
Expected: FAIL — `ImportError: cannot import name 'LimsSampleRemark'`.

- [ ] **Step 3: Add the model**

In `backend/models.py`, directly after the `LimsSample` class body ends, add:

```python
class LimsSampleRemark(Base):
    """Parent-AR internal remark — Mk1 system of record (read-flip spec §6).

    Replaces SENAITE's AR `Remarks` field: the receive flow writes here
    natively (SENAITE write deleted 2026-07-14) and the lookup serves this
    table in BOTH read modes. Backfilled rows carry the SENAITE login string
    in author_label; Mk1-era rows carry a real users FK.
    """
    __tablename__ = "lims_sample_remarks"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    lims_sample_pk: Mapped[int] = mapped_column(
        ForeignKey("lims_samples.id", ondelete="CASCADE"), nullable=False
    )
    content: Mapped[str] = mapped_column(Text, nullable=False)
    author_user_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    author_label: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )

    def __repr__(self) -> str:
        return f"<LimsSampleRemark(id={self.id}, sample_pk={self.lims_sample_pk})>"
```

- [ ] **Step 4: Add the idempotent DDL**

In `backend/database.py`, append to the `migrations` list after the
`lims_packaging_photos ... capture_token_id` ALTER (the current final entry):

```python
        # ── parent-AR internal remarks (read-flip spec §6, 2026-07-14) ──
        # Full CREATE here (not just in create_all): migrations run BEFORE
        # create_all, and the dedup unique index below needs the table on
        # first boot (lims_capture_tokens precedent).
        """
        CREATE TABLE IF NOT EXISTS lims_sample_remarks (
            id             SERIAL PRIMARY KEY,
            lims_sample_pk INTEGER NOT NULL REFERENCES lims_samples(id) ON DELETE CASCADE,
            content        TEXT NOT NULL,
            author_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            author_label   VARCHAR(200),
            created_at     TIMESTAMP NOT NULL DEFAULT NOW()
        )
        """,
        "CREATE INDEX IF NOT EXISTS ix_lims_sample_remarks_sample "
        "ON lims_sample_remarks (lims_sample_pk, created_at)",
        # Backfill idempotency key: same sample + timestamp + content hash is
        # the same SENAITE remark; ON CONFLICT DO NOTHING rides this index.
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_lims_sample_remarks_dedup "
        "ON lims_sample_remarks (lims_sample_pk, created_at, md5(content))",
```

- [ ] **Step 5: Apply DDL to the dev DB and run the test**

The dev DB gets the table via the migration on next backend boot; for the test
container, apply directly:
Run: `docker exec readflip-test sh -c "cd /app && python -c \"from database import init_db; init_db()\""`
Then: `docker exec readflip-test sh -c "cd /app && python -m pytest tests/test_lims_sample_remarks_schema.py -q"`
Expected: 2 passed.

- [ ] **Step 6: Commit**

```bash
git add backend/models.py backend/database.py backend/tests/test_lims_sample_remarks_schema.py
git commit -m "feat(readflip-l2): lims_sample_remarks schema — native parent-AR remarks table"
```
(with the standard trailers)

---

### Task 2: Receive flow writes natively — SENAITE Remarks write deleted

**Files:**
- Modify: `backend/main.py` — the `# --- Step 2: Add remarks (optional) ---` block inside `receive_senaite_sample` (block starts ~line 13691: `if req.remarks and req.remarks.strip():` posting to `.../@@API/senaite/v1/update/{req.sample_uid}` with `{"Remarks": ...}`)
- Test: `backend/tests/test_receive_remarks_native.py` (new)

**Interfaces:**
- Consumes: `LimsSampleRemark` (Task 1); existing SENAITE-mock idiom for the receive endpoint in `backend/tests/test_sample_transition_log.py` (~line 434 — reuse its fixture/mock approach for POSTs to `/wizard/senaite/receive-sample`).
- Produces: receive-path native remark rows (actor = authenticated user). No new interfaces.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_receive_remarks_native.py`. Reuse the SENAITE-HTTP
mock idiom from `test_sample_transition_log.py`'s receive tests (same
endpoint, same mock surface — copy its fixture/mocking helpers rather than
inventing new ones; keep TEST-prefixed sample ids and FK-safe cleanup):

```python
"""Receive-flow remarks go native (read-flip spec §6).

Three behaviors:
1. remarks in the receive request → lims_sample_remarks row with the acting
   user's id; NO SENAITE update/{uid} call carrying "Remarks".
2. no remarks → no row, no SENAITE Remarks call (unchanged behavior).
3. no registry row for the sample id → receive fails with the same response
   shape the SENAITE-write failure used to produce (hard step preserved).
"""
```

Test 1 (`test_receive_writes_native_remark_row`): drive the mocked receive
happy path with `remarks="checked in, seal intact"`; assert (a) response
`success is True` and `"remarks_added" in steps_done`, (b) exactly one
`LimsSampleRemark` row exists for the sample's `lims_samples` pk with
`content == "checked in, seal intact"`, `author_user_id == <the test user's
id>`, `author_label is None`, (c) the recorded SENAITE HTTP calls contain NO
POST whose JSON body contains a `"Remarks"` key.

Test 2 (`test_receive_without_remarks_writes_nothing`): same drive with
`remarks=None`; assert no `LimsSampleRemark` rows for the sample and no
`"remarks_added"` in steps_done.

Test 3 (`test_receive_remarks_fails_closed_without_registry_row`): drive with
a sample id that has NO `lims_samples` row; assert response `success is False`
and the message mentions the missing registry row, and no remark row was
created.

Write real assertions against the live dev DB (query `LimsSampleRemark`
joined via the `lims_samples` row the test seeds). The exact fixture shape
follows `test_sample_transition_log.py` — that file already seeds a
`lims_samples` row, authenticates a test user, and mocks the SENAITE
receive-sample HTTP sequence; mirror it.

- [ ] **Step 2: Run to verify they fail**

Run: `docker exec readflip-test sh -c "cd /app && python -m pytest tests/test_receive_remarks_native.py -q"`
Expected: test 1 FAILS (no native row; SENAITE call DOES carry Remarks), test 3 FAILS (receive currently succeeds via SENAITE write). Test 2 may already pass (lock-in).

- [ ] **Step 3: Replace the SENAITE write with the native insert**

In `backend/main.py`, replace the whole `# --- Step 2: Add remarks
(optional) ---` block (the `if req.remarks and req.remarks.strip():` block
that POSTs `{"Remarks": ...}` to SENAITE and returns
`Remarks update failed: SENAITE returned {status}` on non-200) with:

```python
            # --- Step 2: Add remarks (optional) — NATIVE ---
            # lims_sample_remarks is the system of record (read-flip spec §6);
            # the SENAITE Remarks write was deleted 2026-07-14 (nothing read
            # it). Hard step preserved: failure fails the receive, same as
            # the SENAITE write did.
            if req.remarks and req.remarks.strip():
                def _insert_remark() -> bool:
                    rdb = SessionLocal()
                    try:
                        row = rdb.execute(
                            select(LimsSample).where(
                                LimsSample.sample_id
                                == req.sample_id.strip().upper())
                        ).scalar_one_or_none()
                        if row is None:
                            return False
                        rdb.add(LimsSampleRemark(
                            lims_sample_pk=row.id,
                            content=req.remarks.strip(),
                            author_user_id=getattr(current_user, "id", None),
                        ))
                        rdb.commit()
                        return True
                    finally:
                        rdb.close()

                from fastapi.concurrency import run_in_threadpool
                if await run_in_threadpool(_insert_remark):
                    steps_done.append("remarks_added")
                else:
                    return SenaiteReceiveSampleResponse(
                        success=False,
                        message=(f"Remarks save failed: no registry row for "
                                 f"{req.sample_id}"),
                        senaite_response={"steps_done": steps_done},
                    )
```

Add `LimsSampleRemark` to the existing `from models import ...` line in
`main.py` (alphabetical position within that import).

- [ ] **Step 4: Run the tests**

Run: `docker exec readflip-test sh -c "cd /app && python -m pytest tests/test_receive_remarks_native.py tests/test_sample_transition_log.py -q"`
Expected: all pass (the transition-log receive tests prove the rest of the receive sequence is undisturbed).

- [ ] **Step 5: Commit**

```bash
git add backend/main.py backend/tests/test_receive_remarks_native.py
git commit -m "feat(readflip-l2): receive-flow remarks write natively — SENAITE Remarks write deleted"
```
(with the standard trailers)

---

### Task 3: Lookup serves native remarks in both modes

**Files:**
- Modify: `backend/main.py` — (a) add helper `_native_sample_remarks` near `SenaiteRemark` (~line 12118); (b) in `lookup_senaite_sample`, replace the `# Parse remarks (list of {content, user_id, created, ...})` block (~lines 12525-12536) with a helper call; (c) in `get_sample_read_from_registry` (~line 17786), re-apply the helper after the overlay loop.
- Test: `backend/tests/test_native_remarks_read.py` (new)

**Interfaces:**
- Consumes: `LimsSampleRemark` (Task 1); `_mock_lookup`/`_senaite_result`/`client` idioms from `backend/tests/test_registry_read_endpoint.py`.
- Produces: `_native_sample_remarks(db: Session, sample_id: str) -> list[SenaiteRemark]` — Layer 4's builder calls this same helper.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_native_remarks_read.py`:

```python
"""Native remarks serve path (read-flip spec §6): the shared helper's shape
mapping, plus endpoint wiring proven through the registry details endpoint
(which mocks the lookup — so a native remark appearing in its response can
ONLY have come from the re-apply, not SENAITE)."""
```

Test 1 (`test_helper_maps_rows_to_senaite_remark_shape`): seed a
`lims_samples` row (TEST-prefixed) + two `LimsSampleRemark` rows — one with
`author_user_id` pointing at a seeded test user (email `test-rmk@example.com`,
`first_name="Rem"`, `last_name="Marker"`) and `author_label=None`; one with
`author_user_id=None`, `author_label="legacy.senaite.login"`, and an explicit
`created_at=datetime(2026, 1, 2, 3, 4, 5)`. Call
`main._native_sample_remarks(db, sample_id)` directly and assert: returns 2
`SenaiteRemark` in `created_at` order; first has `user_id == "Rem Marker"`;
second has `user_id == "legacy.senaite.login"` and
`created == "2026-01-02T03:04:05"`; `content` passes through verbatim.

Test 2 (`test_helper_user_fallback_to_email`): user with NULL first/last name
→ `user_id` falls back to the user's email.

Test 3 (`test_registry_endpoint_serves_native_remarks`): follow
`test_registry_read_endpoint.py`'s idiom — seed registry row + one native
remark, mock the lookup with `_senaite_result()`-style payload whose `remarks`
is `[{"content": "<p>stale senaite remark</p>", "user_id": "zeus",
"created": "2020-01-01T00:00:00"}]`, GET
`/registry/sample/{sample_id}/details`, assert the response's `remarks` is
exactly the native row (content matches the seeded native remark, the stale
SENAITE one absent) and `field_sources["remarks"] == "mk1"`.

Test 4 (`test_registry_endpoint_empty_native_remarks_is_empty_list`): no
native rows → response `remarks == []` even though the mocked lookup carried
a SENAITE remark (stale-by-design, spec §6).

- [ ] **Step 2: Run to verify they fail**

Run: `docker exec readflip-test sh -c "cd /app && python -m pytest tests/test_native_remarks_read.py -q"`
Expected: AttributeError (`_native_sample_remarks` missing) for tests 1-2; tests 3-4 FAIL showing the mocked SENAITE remark passing through.

- [ ] **Step 3: Implement**

(a) In `backend/main.py`, directly below the `SenaiteRemark` class, add:

```python
def _native_sample_remarks(db: Session, sample_id: str) -> list["SenaiteRemark"]:
    """lims_sample_remarks → SenaiteRemark list (read-flip spec §6).

    Native in BOTH read modes: SENAITE's Remarks field is stale by design
    since the 2026-07-14 write flip. Backfilled rows carry the SENAITE login
    in author_label; Mk1-era rows resolve the users FK to "First Last",
    falling back to email.
    """
    rows = db.execute(
        select(LimsSampleRemark, User)
        .outerjoin(User, LimsSampleRemark.author_user_id == User.id)
        .join(LimsSample, LimsSampleRemark.lims_sample_pk == LimsSample.id)
        .where(LimsSample.sample_id == sample_id.strip().upper())
        .order_by(LimsSampleRemark.created_at, LimsSampleRemark.id)
    ).all()
    out: list[SenaiteRemark] = []
    for remark, user in rows:
        label = remark.author_label
        if not label and user is not None:
            label = (f"{user.first_name or ''} {user.last_name or ''}".strip()
                     or user.email)
        out.append(SenaiteRemark(
            content=remark.content,
            user_id=label,
            created=(remark.created_at.isoformat()
                     if remark.created_at else None),
        ))
    return out
```

(`User` is already imported in `main.py`; verify and extend the models import
if not.)

(b) In `lookup_senaite_sample`, replace the remarks-parse block:

```python
        # Parse remarks (list of {content, user_id, created, ...})
        senaite_remarks: list[SenaiteRemark] = []
        raw_remarks = item.get("Remarks")
        if isinstance(raw_remarks, list):
            for r in raw_remarks:
                if isinstance(r, dict) and r.get("content"):
                    senaite_remarks.append(SenaiteRemark(
                        content=r["content"],
                        user_id=r.get("user_id") or None,
                        created=r.get("created") or None,
                    ))
```

with:

```python
        # Native remarks (read-flip spec §6): lims_sample_remarks is the
        # system of record in BOTH read modes — SENAITE's Remarks field is
        # stale by design since the write flip. The SENAITE payload's
        # "Remarks" key is deliberately ignored.
        senaite_remarks: list[SenaiteRemark] = _native_sample_remarks(
            db, sample_id)
```

(c) In `get_sample_read_from_registry`, after the overlay loop and before the
final `return`, add:

```python
    # Remarks are native in both modes (read-flip spec §6). Re-applied here
    # (idempotent — the wrapped lookup already serves native) so the wiring
    # is provable through this endpoint's lookup-mocked test harness.
    payload["remarks"] = [r.model_dump()
                          for r in _native_sample_remarks(db, sample_id)]
    field_sources["remarks"] = "mk1"
```

(Apply it on BOTH return paths of that endpoint — the `registry_missing=True`
early return and the overlay return — remarks are native regardless of
whether the registry basic-info row exists; a sample with no `lims_samples`
row has no native remarks, so the early-return path serves `[]`.)

- [ ] **Step 4: Run the tests + neighbors**

Run: `docker exec readflip-test sh -c "cd /app && python -m pytest tests/test_native_remarks_read.py tests/test_registry_read_endpoint.py tests/test_registry_read.py -q"`
Expected: all pass except any names already in the 60-name baseline (check names against the baseline file before treating as regressions).

- [ ] **Step 5: Commit**

```bash
git add backend/main.py backend/tests/test_native_remarks_read.py
git commit -m "feat(readflip-l2): lookup serves native remarks in both read modes"
```
(with the standard trailers)

---

### Task 4: One-time SENAITE→Mk1 remarks backfill

**Files:**
- Create: `backend/scripts/backfill_lims_sample_remarks.py`
- Test: `backend/tests/test_backfill_lims_sample_remarks.py` (new)

**Interfaces:**
- Consumes: `sub_samples.senaite.fetch_parent_metadata(parent_sample_id) -> dict` (the complete AR detail — its `Remarks` key is the same `[{content, user_id, created}, ...]` list the lookup used to parse); the harness idioms from `backend/tests/test_backfill_basic_info.py` (`db_factory`, mocked `sen.fetch_parent_metadata`, `_run` wrapper, tmp checkpoints).
- Produces: the script (run once on prod post-deploy, per spec §6 ordering note: write-flip deploys, backfill sweeps, idempotent re-run closes the gap window).

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_backfill_lims_sample_remarks.py`, cloning the
harness shape of `test_backfill_basic_info.py` (a `_run(db_factory, ids,
metas, ...)` helper that patches `scripts.backfill_lims_sample_remarks.sen
.fetch_parent_metadata` and calls `backfill(...)` with a tmp checkpoint).
Metas helper:

```python
def _meta_with_remarks(remarks):
    return {"Remarks": remarks}
```

Test 1 (`test_backfill_inserts_rows_with_author_label`): registry row
`TEST-RMKBF-P1`; meta `[{"content": "<p>r1</p>", "user_id": "zeus",
"created": "2026-01-02T03:04:05"}, {"content": "<p>r2</p>", "user_id": None,
"created": "2026-01-03T00:00:00"}]` → 2 rows inserted; first has
`author_label == "zeus"`, `author_user_id is None`,
`created_at == datetime(2026, 1, 2, 3, 4, 5)`, content verbatim; stats
`{"fetched": 1, "inserted": 2, "dup": 0, "errors": 0}`-shaped counts match.

Test 2 (`test_backfill_idempotent_rerun_inserts_nothing`): run twice (delete
the checkpoint file between runs, per the module's re-scan contract); second
run `inserted == 0`, `dup == 2`, row count still 2.

Test 3 (`test_backfill_dry_run_writes_nothing`): `dry_run=True` → would-insert
count reported, zero rows, no checkpoint file written.

Test 4 (`test_backfill_skips_malformed_entries`): meta with one good dict, one
`"not-a-dict"`, one dict without content → only the good one inserted,
`skipped_malformed == 2`, no exception.

Test 5 (`test_backfill_unparseable_created_uses_none_guard`): entry with
`created="garbage"` → row inserted with `created_at` set to the epoch
sentinel `datetime(1970, 1, 1)` (deterministic dedup key — see Step 3) and
counted in `unparseable_created`.

- [ ] **Step 2: Run to verify they fail**

Run: `docker exec readflip-test sh -c "cd /app && python -m pytest tests/test_backfill_lims_sample_remarks.py -q"`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the script**

Create `backend/scripts/backfill_lims_sample_remarks.py`, cloning
`backfill_lims_sample_basic_info.py`'s operational shell exactly. Import the
fetch module as `from sub_samples import senaite as sen` so the tests'
`patch("scripts.backfill_lims_sample_remarks.sen.fetch_parent_metadata", ...)`
target resolves (the basic-info harness precedent). Shell = module
docstring contract, registry-cursor batching over `lims_samples`, throttled
`--sleep` between per-sample fetches, `--checkpoint`/`--dry-run`/`--limit`,
per-sample try/except with an `errors` count, checkpoint advances only after
commit, argparse `main()`), with this per-sample core:

```python
def _rows_for_sample(meta: dict, lims_sample_pk: int):
    """SENAITE Remarks list → insert-param dicts + stat deltas."""
    out, malformed, unparseable = [], 0, 0
    raw = meta.get("Remarks")
    if not isinstance(raw, list):
        return out, malformed, unparseable
    for r in raw:
        if not isinstance(r, dict) or not r.get("content"):
            malformed += 1
            continue
        created = r.get("created")
        try:
            created_dt = datetime.fromisoformat(created) if created else None
        except (TypeError, ValueError):
            created_dt = None
        if created_dt is None:
            # Deterministic dedup key for entries without a usable timestamp:
            # the epoch sentinel keeps (pk, created_at, md5) stable across
            # re-runs where NOW() would create duplicates.
            created_dt = datetime(1970, 1, 1)
            unparseable += 1
        out.append({
            "pk": lims_sample_pk,
            "content": r["content"],
            "author_label": (r.get("user_id") or None),
            "created": created_dt,
        })
    return out, malformed, unparseable
```

and the insert (per sample, one transaction):

```python
INSERT_SQL = text(
    "INSERT INTO lims_sample_remarks "
    "  (lims_sample_pk, content, author_label, created_at) "
    "VALUES (:pk, :content, :author_label, :created) "
    "ON CONFLICT DO NOTHING"
)
# inserted-vs-dup: rowcount is 1 on insert, 0 on conflict
```

Stats line printed as JSON on completion (house shape):
`{"fetched": N, "inserted": N, "dup": N, "skipped_malformed": N,
"unparseable_created": N, "no_registry_row": N, "errors": N}`.
`--dry-run`: count `would_insert` by running the SELECT-side only (existence
check against the dedup triple via
`SELECT 1 FROM lims_sample_remarks WHERE lims_sample_pk=:pk AND
created_at=:created AND md5(content)=md5(:content)`), write nothing, touch no
checkpoint.

- [ ] **Step 4: Run the tests**

Run: `docker exec readflip-test sh -c "cd /app && python -m pytest tests/test_backfill_lims_sample_remarks.py -q"`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/scripts/backfill_lims_sample_remarks.py backend/tests/test_backfill_lims_sample_remarks.py
git commit -m "feat(readflip-l2): idempotent SENAITE-remarks history backfill"
```
(with the standard trailers)

---

### Task 5: Layer gate — full-suite failure-set diff + push

**Files:** none (verification + push only; controller may run inline).

- [ ] **Step 1:** Layer-2 suite sweep:
`docker exec readflip-test sh -c "cd /app && python -m pytest tests/test_lims_sample_remarks_schema.py tests/test_receive_remarks_native.py tests/test_native_remarks_read.py tests/test_backfill_lims_sample_remarks.py tests/test_sample_transition_log.py tests/test_registry_read_endpoint.py tests/test_registry_read.py -q"`
Expected: green outside baseline names.

- [ ] **Step 2:** Full-suite failure-set diff vs the 60-name baseline (same command as Layer 1's Task 3). Expected: byte-identical.

- [ ] **Step 3:** `git push`.

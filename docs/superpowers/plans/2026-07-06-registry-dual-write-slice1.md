# Registry Dual-Write Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the `lims_samples` copy (14 new columns), mint internal native IDs, and have IS write the registry row at order time — dual-write, no reader changes.

**Architecture:** All population still funnels through `_populate_basic_info` (extended to the full field set). A new S2S endpoint (`POST /s2s/lims-samples`, existing `X-Service-Token` auth) upserts rows from a SENAITE-shaped meta dict that IS forwards right after AR creation; native IDs come from a row-locked per-prefix sequence table. Mk1's two SENAITE field-edit sites gain same-transaction local mirrors.

**Tech Stack:** Mk1 backend (FastAPI + SQLAlchemy 2.0, hand-rolled idempotent ALTERs); IS (FastAPI, `AccuMk1Adapter` httpx client); pytest (sqlite in-memory).

**Spec:** `C:\tmp\canonical-basic-info\docs\superpowers\specs\2026-07-06-registry-dual-write-program-design.md` (approved 2026-07-06). The spec wins on any ambiguity.

## Global Constraints

- **Two repos, two worktrees.** Mk1: `C:\tmp\canonical-basic-info`, branch `feat/registry-dual-write` (exists). IS: create worktree `C:\tmp\is-registry`, branch `feat/registry-creation-signal`, from the IS main checkout (`C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\integration-service`), based on `origin/master`. Never touch main checkouts.
- **Additive only.** All new columns nullable; no reader behavior changes; SENAITE writes unchanged everywhere.
- **New tables use the `lims_` prefix** → `lims_native_id_sequences`.
- **Native IDs:** internal-only, forward-only, minted exactly once per row, never re-minted, never exposed customer-facing.
- **Signal is best-effort from IS:** a failed call must NEVER fail order processing.
- **Existing `sample_type` column stays the UID** (load-bearing for secondary creation) — the new title goes in `sample_type_title`.
- **Verified live payload keys (2026-07-06, do not re-derive):** `Coa*` fields are exactly `CoaAddress, CoaCompanyName, CoaEmail, CoaWebsite`; sample-type title = `getSampleTypeTitle` (fallback `SampleTypeTitle`); contact = top-level `ContactFullName` / `ContactEmail` (fallbacks `getContactFullName` / `getContactEmail`); logo = `CompanyLogoUrl`; AR creation time = `created` (ISO w/ offset); quantities are freeform strings.
- **Git hygiene:** explicit file paths, never `git add -A`. Commit messages end with the Claude Code co-author line only if the repo's history uses it (it does not — omit).
- **Mk1 test loop:** `docker exec canonical-basic-info-test python -m pytest tests/<file> -q` (persistent container mounts the Mk1 worktree `backend/` at `/app`; pytest installed). It follows branch switches automatically.
- **IS test loop (create once in Task 6):** find the local IS image with `docker images --format "{{.Repository}}:{{.Tag}}" | grep -i integration`, then `docker run -d --name is-registry-test -v C:/tmp/is-registry://app -w //app --entrypoint sleep <image> infinity && docker exec is-registry-test pip install -q pytest pytest-asyncio httpx respx` (IS runtime image lacks pytest — known gotcha; `//app` avoids Git-Bash path mangling). Then `docker exec is-registry-test python -m pytest tests/... -q`. **IS repo-wide ruff/mypy is red (pre-existing)** — gate on new code only.
- **Mk1 baseline reds:** `test_container_mode.py` 4F/7E (Postgres-connectivity in the container) + ~19 known full-suite failures. Anything else must reproduce at the pre-task commit before being called baseline.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| Mk1 `backend/models.py` | Modify | 14 new nullable columns on `LimsSample`; new `LimsNativeIdSequence` model |
| Mk1 `backend/database.py` | Modify | idempotent `ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS …` block |
| Mk1 `backend/sub_samples/native_id.py` | Create | `mint_native_id` — row-locked per-prefix sequence allocation |
| Mk1 `backend/sub_samples/service.py` | Modify | `_populate_basic_info` extension; `_parse_analyte_slots`; `apply_senaite_fields_to_row`; `upsert_sample_from_signal` |
| Mk1 `backend/main.py` | Modify | `POST /s2s/lims-samples` endpoint; dual-write mirrors in `update_senaite_sample_fields` (~:13346) and the publish-flow VerificationCode write (~:9885) |
| Mk1 `backend/tests/test_lims_sample_basic_info.py` | Modify | extended-populate tests |
| Mk1 `backend/tests/test_native_id.py` | Create | minting tests |
| Mk1 `backend/tests/test_registry_signal.py` | Create | upsert + endpoint + dual-write tests |
| IS `app/adapters/accumk1.py` | Modify | `notify_sample_created` method |
| IS `app/services/order_processor.py` | Modify | fire signal after successful AR creation, best-effort |
| IS `tests/unit/test_registry_signal.py` | Create | adapter + wiring tests |

---

### Task 1: Mk1 schema — columns + sequence table

**Files:**
- Modify: `backend/models.py` (LimsSample block ends ~line 780; add columns after `customer_remarks_delivered_at`, new model after `LimsSubSample`)
- Modify: `backend/database.py` (the `lims_samples` idempotent-ALTER block — find it with `grep -n "lims_samples" backend/database.py`)
- Test: `backend/tests/test_registry_signal.py` (create with schema smoke test)

**Interfaces:**
- Produces: `LimsSample.{client_title, contact_title, contact_email, sample_type_title, date_created, verification_code, client_order_number, analytes, declared_total_quantity, client_lot, client_reference, company_logo_url, coa_meta, native_id}`; `LimsNativeIdSequence(prefix, next_value)`. All later tasks depend on these exact names.

- [ ] **Step 1: Write the failing schema smoke test**

Create `backend/tests/test_registry_signal.py`:

```python
"""Slice-1 registry tests: schema, signal upsert, S2S endpoint, dual-write
(2026-07-06-registry-dual-write-program-design.md)."""
import json
import pytest
from datetime import datetime
from unittest.mock import patch
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from database import Base
from models import LimsSample, LimsNativeIdSequence


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    yield s
    s.close()


def test_new_columns_and_sequence_table_exist(db):
    row = LimsSample(
        sample_id="P-0134",
        client_title="forrest@valenceanalytical.com",
        contact_title="Forrest P",
        contact_email="f@example.com",
        sample_type_title="Peptide",
        date_created=datetime(2026, 2, 2, 3, 59, 29),
        verification_code="AB12-CD34",
        client_order_number="WP-3031",
        analytes=json.dumps([{"name": "BPC-157", "declared_quantity": "10.00"}]),
        declared_total_quantity="123.00",
        client_lot="123",
        client_reference="ref-1",
        company_logo_url="/wp-content/uploads/logo.jpg",
        coa_meta=json.dumps({"CoaCompanyName": "Ftest"}),
        native_id="aP-0001",
    )
    db.add(row)
    db.add(LimsNativeIdSequence(prefix="aP", next_value=2))
    db.commit()
    got = db.query(LimsSample).filter_by(sample_id="P-0134").one()
    assert got.native_id == "aP-0001"
    assert json.loads(got.analytes)[0]["declared_quantity"] == "10.00"
    assert db.query(LimsNativeIdSequence).get("aP").next_value == 2
```

- [ ] **Step 2: Run to verify it fails**

Run: `docker exec canonical-basic-info-test python -m pytest tests/test_registry_signal.py -q`
Expected: FAIL — `ImportError: cannot import name 'LimsNativeIdSequence'`

- [ ] **Step 3: Add the columns and model**

In `backend/models.py`, inside `LimsSample` directly after the `customer_remarks_delivered_at` column:

```python
    # --- Registry dual-write slice 1 (2026-07-06 spec): the complete sample
    # record. All nullable/additive; SENAITE stays the write surface upstream.
    client_title: Mapped[Optional[str]] = mapped_column(String(200))
    contact_title: Mapped[Optional[str]] = mapped_column(String(200))
    contact_email: Mapped[Optional[str]] = mapped_column(String(320))
    # sample_type (above) is the SENAITE UID and stays load-bearing for
    # secondary creation; this is the human-readable title.
    sample_type_title: Mapped[Optional[str]] = mapped_column(String(200))
    # AR creation time in SENAITE — distinct from created_at (row creation).
    date_created: Mapped[Optional[datetime]] = mapped_column(DateTime)
    verification_code: Mapped[Optional[str]] = mapped_column(String(50))
    client_order_number: Mapped[Optional[str]] = mapped_column(String(100))
    # JSON list of {"name": str, "declared_quantity": str|None}, analyte
    # slots 1-8 in order, empty slots omitted. peptide_name stays = slot-1
    # label for back-compat.
    analytes: Mapped[Optional[str]] = mapped_column(Text)
    declared_total_quantity: Mapped[Optional[str]] = mapped_column(String(50))
    client_lot: Mapped[Optional[str]] = mapped_column(String(100))
    client_reference: Mapped[Optional[str]] = mapped_column(String(200))
    company_logo_url: Mapped[Optional[str]] = mapped_column(Text)
    # Verbatim map of SENAITE's Coa* custom fields (CoaAddress, CoaCompanyName,
    # CoaEmail, CoaWebsite) — COABuilder consumes this in slice 4.
    coa_meta: Mapped[Optional[str]] = mapped_column(Text)
    # Internal-only Mk1-native identifier (aP-0001 …), forward-only, minted
    # once by sub_samples.native_id. Never customer-facing in this program.
    native_id: Mapped[Optional[str]] = mapped_column(String(20), unique=True, index=True)
```

After the `LimsSubSample` class, add:

```python
class LimsNativeIdSequence(Base):
    """Per-prefix counters for native sample IDs (aP-0001, aPB-0001, …).
    Allocation happens under SELECT ... FOR UPDATE on the prefix row —
    same idiom as vial_sequence assignment."""
    __tablename__ = "lims_native_id_sequences"

    prefix: Mapped[str] = mapped_column(String(8), primary_key=True)
    next_value: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
```

- [ ] **Step 4: Add the idempotent ALTERs**

In `backend/database.py`, find the existing `lims_samples` ALTER block (grep `"lims_samples"`) and append to it, following the file's exact string style:

```python
            "ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS client_title VARCHAR(200)",
            "ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS contact_title VARCHAR(200)",
            "ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS contact_email VARCHAR(320)",
            "ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS sample_type_title VARCHAR(200)",
            "ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS date_created TIMESTAMP",
            "ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS verification_code VARCHAR(50)",
            "ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS client_order_number VARCHAR(100)",
            "ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS analytes TEXT",
            "ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS declared_total_quantity VARCHAR(50)",
            "ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS client_lot VARCHAR(100)",
            "ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS client_reference VARCHAR(200)",
            "ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS company_logo_url TEXT",
            "ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS coa_meta TEXT",
            "ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS native_id VARCHAR(20)",
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_lims_samples_native_id ON lims_samples (native_id)",
```

(`lims_native_id_sequences` itself is created by `Base.metadata.create_all` — new tables need no ALTER, matching how other new tables land.)

- [ ] **Step 5: Run to verify it passes**

Run: `docker exec canonical-basic-info-test python -m pytest tests/test_registry_signal.py tests/test_lims_sample_basic_info.py -q`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
cd C:/tmp/canonical-basic-info
git add backend/models.py backend/database.py backend/tests/test_registry_signal.py
git commit -m "feat(registry): slice-1 schema — full sample-record columns + native-id sequences"
```

---

### Task 2: Extend `_populate_basic_info` to the full field set

**Files:**
- Modify: `backend/sub_samples/service.py` (`_populate_basic_info`, currently ends at `row.last_synced_at = datetime.utcnow()`; add `_parse_analyte_slots` helper above it)
- Test: `backend/tests/test_lims_sample_basic_info.py` (extend)

**Interfaces:**
- Consumes: Task 1 columns.
- Produces: `_populate_basic_info(row, meta)` now writes the full set; `_parse_analyte_slots(meta) -> list[dict]` (module-level, reused by Task 5's field mirror). Tasks 4/5 rely on both.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_lims_sample_basic_info.py` (note: its `_full_meta()` gains keys — extend the helper in place by adding the new keys shown here to its dict):

Add to `_full_meta()`'s dict:

```python
        "getClientTitle": "forrest@valenceanalytical.com",
        "ContactFullName": "Forrest P",
        "ContactEmail": "fp@example.com",
        "getSampleTypeTitle": "Peptide",
        "created": "2026-02-02T03:59:29+00:00",
        "VerificationCode": "AB12-CD34",
        "ClientOrderNumber": "WP-3031",
        "Analyte1DeclaredQuantity": "10.00",
        "Analyte2Peptide": "GHK-Cu",
        "Analyte2DeclaredQuantity": None,
        "DeclaredTotalQuantity": "123.00",
        "ClientLot": "123",
        "ClientReference": "ref-1",
        "CompanyLogoUrl": "/wp-content/uploads/logo.jpg",
        "CoaCompanyName": "Ftest' 123",
        "CoaAddress": None,
        "CoaEmail": None,
        "CoaWebsite": None,
```

New tests:

```python
import json as _json


def test_populate_full_record_fields(db):
    row = LimsSample(sample_id="P-0134")
    service._populate_basic_info(row, _full_meta())
    assert row.client_title == "forrest@valenceanalytical.com"
    assert row.contact_title == "Forrest P"
    assert row.contact_email == "fp@example.com"
    assert row.sample_type_title == "Peptide"
    assert row.date_created == datetime(2026, 2, 2, 3, 59, 29)
    assert row.verification_code == "AB12-CD34"
    assert row.client_order_number == "WP-3031"
    assert row.declared_total_quantity == "123.00"
    assert row.client_lot == "123"
    assert row.client_reference == "ref-1"
    assert row.company_logo_url == "/wp-content/uploads/logo.jpg"
    assert _json.loads(row.coa_meta) == {
        "CoaAddress": None, "CoaCompanyName": "Ftest' 123",
        "CoaEmail": None, "CoaWebsite": None,
    }


def test_populate_analyte_slots_pairs_ordered(db):
    row = LimsSample(sample_id="P-0134")
    service._populate_basic_info(row, _full_meta())
    slots = _json.loads(row.analytes)
    assert slots == [
        {"name": "BPC-157", "declared_quantity": "10.00"},
        {"name": "GHK-Cu", "declared_quantity": None},
    ]
    # peptide_name stays slot-1 label (back-compat)
    assert row.peptide_name == "BPC-157"


def test_populate_missing_new_keys_yields_nulls(db):
    """Old-shape metas (tests, sparse SENAITE objects) must not break."""
    meta = {"uid": "U1", "ClientID": "c", "review_state": "received"}
    row = LimsSample(sample_id="P-0200")
    service._populate_basic_info(row, meta)
    assert row.analytes is None and row.coa_meta is not None  # map of Nones
    assert row.client_title is None and row.date_created is None
```

Note on the last test: `coa_meta` is written as a map whose keys are always present (values may be None) — consumers get a stable shape. `analytes` is None when no slots exist.

- [ ] **Step 2: Run to verify they fail**

Run: `docker exec canonical-basic-info-test python -m pytest tests/test_lims_sample_basic_info.py -q`
Expected: the 3 new tests FAIL (attributes None / helper missing)

- [ ] **Step 3: Implement**

In `backend/sub_samples/service.py`, add above `_populate_basic_info`:

```python
_COA_META_FIELDS = ("CoaAddress", "CoaCompanyName", "CoaEmail", "CoaWebsite")


def _parse_analyte_slots(meta: dict) -> list[dict]:
    """Analyte slots 1-8 as ordered {name, declared_quantity} pairs; empty
    slots omitted. IS writes up to 8 slots; the Mk1 UI shows 4."""
    slots: list[dict] = []
    for i in range(1, 9):
        name = _extract_label(meta.get(f"Analyte{i}Peptide"))
        if not name or not str(name).strip():
            continue
        qty = meta.get(f"Analyte{i}DeclaredQuantity")
        slots.append({
            "name": str(name).strip(),
            "declared_quantity": str(qty) if qty not in (None, "") else None,
        })
    return slots
```

Extend `_populate_basic_info` — after the existing `row.status = meta.get("review_state")` line, before `row.last_synced_at`:

```python
    # Full sample record (dual-write slice 1). Getter-index keys first where
    # the live complete=true payload verified them (2026-07-06); bare-key
    # fallbacks keep old test fixtures and sparse payloads working.
    row.client_title = meta.get("getClientTitle") or meta.get("ClientTitle")
    row.contact_title = meta.get("ContactFullName") or meta.get("getContactFullName")
    row.contact_email = meta.get("ContactEmail") or meta.get("getContactEmail")
    row.sample_type_title = meta.get("getSampleTypeTitle") or meta.get("SampleTypeTitle")
    row.date_created = _parse_senaite_date(meta.get("created"))
    row.verification_code = meta.get("VerificationCode") or meta.get("getVerificationCode")
    row.client_order_number = meta.get("ClientOrderNumber") or meta.get("getClientOrderNumber")
    slots = _parse_analyte_slots(meta)
    row.analytes = json.dumps(slots) if slots else None
    dtq = meta.get("DeclaredTotalQuantity")
    row.declared_total_quantity = str(dtq) if dtq not in (None, "") else None
    row.client_lot = meta.get("ClientLot")
    row.client_reference = meta.get("ClientReference")
    row.company_logo_url = meta.get("CompanyLogoUrl")
    row.coa_meta = json.dumps({k: meta.get(k) for k in _COA_META_FIELDS})
```

(`json` is already imported at the top of service.py; verify, add if not.)

- [ ] **Step 4: Run the covering suites**

Run: `docker exec canonical-basic-info-test python -m pytest tests/test_lims_sample_basic_info.py tests/test_backfill_basic_info.py tests/test_sub_samples_service.py tests/test_registry_signal.py -q`
Expected: all pass — the backfill suite passing proves the re-sweep now fills the new columns with zero script changes (spec §Backfill re-sweep).

- [ ] **Step 5: Commit**

```bash
cd C:/tmp/canonical-basic-info
git add backend/sub_samples/service.py backend/tests/test_lims_sample_basic_info.py
git commit -m "feat(registry): populate the full sample record (analyte pairs, COA meta, display fields)"
```

---

### Task 3: Native-ID minting

**Files:**
- Create: `backend/sub_samples/native_id.py`
- Test: `backend/tests/test_native_id.py` (create)

**Interfaces:**
- Consumes: `LimsNativeIdSequence` (Task 1).
- Produces: `mint_native_id(db: Session, senaite_sample_id: Optional[str] = None, sample_type_title: Optional[str] = None) -> str`. Task 4 calls it.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_native_id.py`:

```python
"""Native-ID minting: prefix derivation, zero-padding, sequence isolation."""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from database import Base
from models import LimsNativeIdSequence
from sub_samples.native_id import mint_native_id


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    yield s
    s.close()


def test_prefix_derived_from_senaite_id(db):
    assert mint_native_id(db, senaite_sample_id="P-1234") == "aP-0001"
    assert mint_native_id(db, senaite_sample_id="PB-0007") == "aPB-0001"
    assert mint_native_id(db, senaite_sample_id="BW-0013") == "aBW-0001"


def test_sequences_are_per_prefix_and_monotonic(db):
    assert mint_native_id(db, senaite_sample_id="P-0001") == "aP-0001"
    assert mint_native_id(db, senaite_sample_id="P-0002") == "aP-0002"
    assert mint_native_id(db, senaite_sample_id="PB-0001") == "aPB-0001"
    assert mint_native_id(db, senaite_sample_id="P-0003") == "aP-0003"


def test_senaite_free_uses_sample_type_map(db):
    assert mint_native_id(db, sample_type_title="Peptide") == "aP-0001"
    assert mint_native_id(db, sample_type_title="Peptide Blend") == "aPB-0001"
    assert mint_native_id(db, sample_type_title="Bacteriostatic Water") == "aBW-0001"
    # unknown type falls back to the generic prefix
    assert mint_native_id(db, sample_type_title="Mystery Goo") == "aS-0001"


def test_padding_grows_past_9999(db):
    db.add(LimsNativeIdSequence(prefix="aP", next_value=10000))
    db.commit()
    assert mint_native_id(db, senaite_sample_id="P-9999") == "aP-10000"


def test_requires_some_identity_source(db):
    with pytest.raises(ValueError):
        mint_native_id(db)
```

- [ ] **Step 2: Run to verify they fail**

Run: `docker exec canonical-basic-info-test python -m pytest tests/test_native_id.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'sub_samples.native_id'`

- [ ] **Step 3: Implement**

Create `backend/sub_samples/native_id.py`:

```python
"""Mk1-native sample IDs (aP-0001, aPB-0001, aBW-0001, …).

Internal-only in the dual-write program: customers keep seeing SENAITE ids
until a testing line goes SENAITE-free (2026-07-06 spec, decision 3).
Forward-only: historical rows keep native_id NULL.

Prefix = "a" + the SENAITE id's own prefix when one exists (zero config for
the SENAITE-attached world); for SENAITE-free callers a sample-type map
applies, falling back to the generic "aS".

Allocation locks the prefix row (SELECT ... FOR UPDATE) — the same
concurrency idiom as vial_sequence assignment. sqlite (tests) treats the
lock as a no-op, which is the established test trade-off in this repo.
"""
from typing import Optional
from sqlalchemy import select
from sqlalchemy.orm import Session
from models import LimsNativeIdSequence

_SAMPLE_TYPE_PREFIXES = {
    "peptide": "aP",
    "peptide blend": "aPB",
    "bacteriostatic water": "aBW",
}
_GENERIC_PREFIX = "aS"
_PAD = 4


def _derive_prefix(senaite_sample_id: Optional[str],
                   sample_type_title: Optional[str]) -> str:
    if senaite_sample_id:
        return "a" + senaite_sample_id.split("-", 1)[0]
    if sample_type_title:
        return _SAMPLE_TYPE_PREFIXES.get(
            sample_type_title.strip().lower(), _GENERIC_PREFIX
        )
    raise ValueError(
        "mint_native_id needs a senaite_sample_id or sample_type_title"
    )


def mint_native_id(db: Session,
                   senaite_sample_id: Optional[str] = None,
                   sample_type_title: Optional[str] = None) -> str:
    prefix = _derive_prefix(senaite_sample_id, sample_type_title)
    seq = db.execute(
        select(LimsNativeIdSequence)
        .where(LimsNativeIdSequence.prefix == prefix)
        .with_for_update()
    ).scalar_one_or_none()
    if seq is None:
        seq = LimsNativeIdSequence(prefix=prefix, next_value=1)
        db.add(seq)
        db.flush()
    value = seq.next_value
    seq.next_value = value + 1
    db.flush()
    return f"{prefix}-{value:0{_PAD}d}"
```

- [ ] **Step 4: Run to verify they pass**

Run: `docker exec canonical-basic-info-test python -m pytest tests/test_native_id.py -q`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
cd C:/tmp/canonical-basic-info
git add backend/sub_samples/native_id.py backend/tests/test_native_id.py
git commit -m "feat(registry): native sample-ID minting with per-prefix row-locked sequences"
```

---

### Task 4: Signal upsert + S2S endpoint

**Files:**
- Modify: `backend/sub_samples/service.py` (add `upsert_sample_from_signal` after `_create_sample_row`)
- Modify: `backend/main.py` (new endpoint next to the other `require_internal_service_token` endpoints, ~line 16546 — grep `require_internal_service_token` for the cluster)
- Test: `backend/tests/test_registry_signal.py` (extend)

**Interfaces:**
- Consumes: `_populate_basic_info` (Task 2), `mint_native_id` (Task 3), `_create_sample_row`'s container gate (existing), `require_internal_service_token` (existing, `backend/auth.py`).
- Produces: `upsert_sample_from_signal(db, sample_id: Optional[str], senaite_uid: Optional[str], meta: dict) -> LimsSample`; HTTP `POST /s2s/lims-samples` → `{"sample_id": str, "native_id": str}`. Task 6's IS adapter targets this contract.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_registry_signal.py`:

```python
from sub_samples.service import upsert_sample_from_signal


def _signal_meta(**over):
    m = {
        "uid": "AR_UID_1",
        "ClientID": "client-8",
        "getClientTitle": "forrest@valenceanalytical.com",
        "ContactFullName": "Forrest P",
        "ContactEmail": "fp@example.com",
        "ClientUID": "C_UID",
        "ContactUID": "CT_UID",
        "SampleType": "ST_UID",
        "getSampleTypeTitle": "Peptide",
        "ClientSampleID": "CS-1",
        "ClientOrderNumber": "WP-3031",
        "Analyte1Peptide": "BPC-157",
        "Analyte1DeclaredQuantity": "10.00",
        "DeclaredTotalQuantity": "10.00",
        "created": "2026-07-06T01:00:00+00:00",
        "DateSampled": "2026-07-05T00:00:00+00:00",
    }
    m.update(over)
    return m


def test_signal_creates_row_and_mints_native_id(db):
    row = upsert_sample_from_signal(db, sample_id="P-2001",
                                    senaite_uid="AR_UID_1", meta=_signal_meta())
    assert row.sample_id == "P-2001"
    assert row.external_lims_uid == "AR_UID_1"
    assert row.native_id == "aP-0001"
    assert row.client_order_number == "WP-3031"
    # signal fires at order time -> pre-received -> container family,
    # matching the wizard's first-touch gate
    assert row.status == "sample_due"
    assert row.container_mode is True


def test_signal_is_idempotent_and_never_reminets(db):
    r1 = upsert_sample_from_signal(db, "P-2001", "AR_UID_1", _signal_meta())
    r2 = upsert_sample_from_signal(db, "P-2001", "AR_UID_1",
                                   _signal_meta(ClientSampleID="CS-9"))
    assert r2.id == r1.id
    assert r2.native_id == "aP-0001"          # minted once
    assert r2.client_sample_id == "CS-9"      # fields refreshed


def test_signal_does_not_clobber_existing_status(db):
    """A lazily-created row already tracks live state — the (stale-at-send)
    signal must not regress it."""
    db.add(LimsSample(sample_id="P-2002", status="sample_received"))
    db.commit()
    row = upsert_sample_from_signal(db, "P-2002", "AR_UID_2", _signal_meta(uid="AR_UID_2"))
    assert row.status == "sample_received"


def test_signal_senaite_free_form(db):
    row = upsert_sample_from_signal(db, sample_id=None, senaite_uid=None,
                                    meta=_signal_meta(uid=None))
    assert row.native_id == "aP-0001"
    assert row.sample_id == "aP-0001"          # native id IS the id (1F on-ramp)
    assert row.external_lims_uid is None
    assert row.external_lims_system == "mk1"
```

- [ ] **Step 2: Run to verify they fail**

Run: `docker exec canonical-basic-info-test python -m pytest tests/test_registry_signal.py -q`
Expected: new tests FAIL — `ImportError: cannot import name 'upsert_sample_from_signal'`

- [ ] **Step 3: Implement the service function**

In `backend/sub_samples/service.py` (after `_create_sample_row`; add `from sub_samples.native_id import mint_native_id` to the imports):

```python
def upsert_sample_from_signal(db: Session, sample_id: Optional[str],
                              senaite_uid: Optional[str], meta: dict) -> LimsSample:
    """Create/refresh a registry row from the IS creation signal
    (2026-07-06 dual-write spec). The payload is a SENAITE-shaped meta dict,
    so population runs through the same _populate_basic_info as every other
    writer.

    SENAITE-attached form: sample_id = the fresh P-xxxx id. SENAITE-free form
    (future native lines): sample_id None -> the minted native id becomes the
    sample_id and external_lims_system = "mk1".

    Idempotent: keyed on sample_id; native_id minted exactly once; a repeat
    signal refreshes fields but never re-mints and never regresses status
    (the signal's state is stale the moment it's sent — live state is owned
    by SENAITE until a line goes native)."""
    meta = dict(meta)
    meta.setdefault("review_state", "sample_due")
    if senaite_uid and not meta.get("uid"):
        meta["uid"] = senaite_uid

    existing = None
    if sample_id:
        existing = db.execute(
            select(LimsSample).where(LimsSample.sample_id == sample_id)
        ).scalar_one_or_none()

    if existing:
        prior_status = existing.status
        _populate_basic_info(existing, meta)
        if prior_status:
            existing.status = prior_status
        if existing.native_id is None:
            existing.native_id = mint_native_id(db, senaite_sample_id=existing.sample_id)
        db.flush()
        return existing

    native = mint_native_id(
        db,
        senaite_sample_id=sample_id,
        sample_type_title=(meta.get("getSampleTypeTitle")
                           or meta.get("SampleTypeTitle")),
    )
    row = _create_sample_row(db, sample_id or native, meta)
    row.native_id = native
    if not sample_id:
        row.external_lims_uid = None
        row.external_lims_system = "mk1"
    db.flush()
    return row
```

- [ ] **Step 4: Run the service-level tests**

Run: `docker exec canonical-basic-info-test python -m pytest tests/test_registry_signal.py -q`
Expected: all pass

- [ ] **Step 5: Add the endpoint**

In `backend/main.py`, next to the existing internal-service endpoints (the `require_internal_service_token` cluster; grep for it):

```python
class RegistrySampleSignal(BaseModel):
    """IS -> Mk1 creation signal (dual-write slice 1). meta is a
    SENAITE-shaped field dict (same keys as a complete=true AR payload)."""
    sample_id: Optional[str] = None
    senaite_uid: Optional[str] = None
    meta: dict


class RegistrySampleSignalResponse(BaseModel):
    sample_id: str
    native_id: Optional[str]


@app.post("/s2s/lims-samples", response_model=RegistrySampleSignalResponse)
async def s2s_upsert_lims_sample(
    req: RegistrySampleSignal,
    db: Session = Depends(get_db),
    _: None = Depends(require_internal_service_token),
):
    """Server-to-server registry upsert, called by the Integration Service
    immediately after it creates a SENAITE AR (or, for future SENAITE-free
    lines, with no SENAITE id at all). Idempotent."""
    from sub_samples.service import upsert_sample_from_signal
    row = upsert_sample_from_signal(db, req.sample_id, req.senaite_uid, req.meta)
    db.commit()
    return RegistrySampleSignalResponse(sample_id=row.sample_id, native_id=row.native_id)
```

- [ ] **Step 6: Endpoint auth test**

Append to `backend/tests/test_registry_signal.py` (mirror the TestClient override idiom used in `tests/test_sub_samples_cutover.py` — read its app/client fixture and reuse the same pattern):

```python
def test_s2s_endpoint_rejects_missing_token():
    from fastapi.testclient import TestClient
    from main import app
    client = TestClient(app)
    resp = client.post("/s2s/lims-samples",
                       json={"sample_id": "P-1", "meta": {}})
    assert resp.status_code in (401, 403)
```

Run: `docker exec canonical-basic-info-test python -m pytest tests/test_registry_signal.py -q`
Expected: all pass (if importing `main` pulls heavy deps that fail in-container, mark the auth test with the same workaround the existing main-importing tests use — check `tests/test_worksheets_inbox.py` imports first).

- [ ] **Step 7: Commit**

```bash
cd C:/tmp/canonical-basic-info
git add backend/sub_samples/service.py backend/main.py backend/tests/test_registry_signal.py
git commit -m "feat(registry): S2S creation-signal endpoint + idempotent upsert with native-id mint"
```

---

### Task 5: Dual-write at Mk1's SENAITE field-edit sites

**Files:**
- Modify: `backend/sub_samples/service.py` (add `apply_senaite_fields_to_row`)
- Modify: `backend/main.py` — two sites: `update_senaite_sample_fields` (~:13346, after the successful SENAITE update, before returning) and the publish flow's VerificationCode write (~:9885)
- Test: `backend/tests/test_registry_signal.py` (extend)

**Interfaces:**
- Consumes: `_parse_analyte_slots` (Task 2).
- Produces: `apply_senaite_fields_to_row(db, senaite_uid: str, fields: dict) -> bool` — maps SENAITE field names onto the registry row found by `external_lims_uid`; returns False (no-op) when no row matches. Best-effort by contract: callers must never fail the user request over a mirror error.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_registry_signal.py`:

```python
from sub_samples.service import apply_senaite_fields_to_row


def _seeded(db, **kw):
    row = LimsSample(sample_id="P-3001", external_lims_uid="U-3001", **kw)
    db.add(row)
    db.commit()
    return row


def test_field_mirror_maps_scalar_fields(db):
    _seeded(db)
    ok = apply_senaite_fields_to_row(db, "U-3001", {
        "ClientSampleID": "NEW-CS",
        "ClientLot": "LOT-9",
        "DeclaredTotalQuantity": "55.5",
        "CoaCompanyName": "NewCo",
        "VerificationCode": "ZZ99-YY88",
        "ClientOrderNumber": "WP-4000",
        "ClientReference": "r2",
        "CompanyLogoUrl": "/logo2.jpg",
    })
    assert ok is True
    row = db.query(LimsSample).filter_by(sample_id="P-3001").one()
    assert row.client_sample_id == "NEW-CS"
    assert row.client_lot == "LOT-9"
    assert row.declared_total_quantity == "55.5"
    assert json.loads(row.coa_meta)["CoaCompanyName"] == "NewCo"
    assert row.verification_code == "ZZ99-YY88"
    assert row.client_order_number == "WP-4000"
    assert row.client_reference == "r2"
    assert row.company_logo_url == "/logo2.jpg"


def test_field_mirror_merges_analyte_slot_edit(db):
    _seeded(db, analytes=json.dumps([
        {"name": "BPC-157", "declared_quantity": "10.00"},
        {"name": "GHK-Cu", "declared_quantity": "5.00"},
    ]), peptide_name="BPC-157")
    apply_senaite_fields_to_row(db, "U-3001", {"Analyte1Peptide": "TB-500"})
    row = db.query(LimsSample).filter_by(sample_id="P-3001").one()
    slots = json.loads(row.analytes)
    assert slots[0] == {"name": "TB-500", "declared_quantity": "10.00"}
    assert slots[1]["name"] == "GHK-Cu"        # untouched
    assert row.peptide_name == "TB-500"        # slot-1 back-compat follows


def test_field_mirror_coa_merge_preserves_other_keys(db):
    _seeded(db, coa_meta=json.dumps({"CoaAddress": "addr", "CoaCompanyName": "Old",
                                     "CoaEmail": None, "CoaWebsite": None}))
    apply_senaite_fields_to_row(db, "U-3001", {"CoaEmail": "c@x.com"})
    row = db.query(LimsSample).filter_by(sample_id="P-3001").one()
    meta = json.loads(row.coa_meta)
    assert meta["CoaEmail"] == "c@x.com" and meta["CoaAddress"] == "addr"


def test_field_mirror_noop_when_row_missing(db):
    assert apply_senaite_fields_to_row(db, "UNKNOWN-UID", {"ClientLot": "x"}) is False


def test_field_mirror_ignores_unmapped_fields(db):
    _seeded(db)
    ok = apply_senaite_fields_to_row(db, "U-3001", {"Remarks": "internal note"})
    assert ok is True   # row found; nothing mapped; no error
```

- [ ] **Step 2: Run to verify they fail**

Run: `docker exec canonical-basic-info-test python -m pytest tests/test_registry_signal.py -q`
Expected: new tests FAIL — `ImportError: cannot import name 'apply_senaite_fields_to_row'`

- [ ] **Step 3: Implement the mirror helper**

In `backend/sub_samples/service.py`:

```python
# SENAITE field name -> lims_samples column, for the dual-write mirror at
# Mk1's field-edit sites. Analyte slots and Coa* fields are handled
# structurally below; fields not listed here (e.g. Remarks) are
# SENAITE-internal and deliberately unmirrored.
_FIELD_MIRROR_SCALARS = {
    "ClientSampleID": "client_sample_id",
    "ClientLot": "client_lot",
    "ClientReference": "client_reference",
    "ClientOrderNumber": "client_order_number",
    "DeclaredTotalQuantity": "declared_total_quantity",
    "VerificationCode": "verification_code",
    "CompanyLogoUrl": "company_logo_url",
}
_ANALYTE_KEY_RE = re.compile(r"^Analyte([1-8])(Peptide|DeclaredQuantity)$")


def apply_senaite_fields_to_row(db: Session, senaite_uid: str, fields: dict) -> bool:
    """Mirror a SENAITE field update onto the registry row (dual-write
    slice 1). Returns False when no row carries this uid (pre-registry
    samples) — callers treat that as a no-op, and callers must NEVER fail
    the user's request over a mirror problem."""
    row = db.execute(
        select(LimsSample).where(LimsSample.external_lims_uid == senaite_uid)
    ).scalar_one_or_none()
    if row is None:
        return False

    for senaite_key, column in _FIELD_MIRROR_SCALARS.items():
        if senaite_key in fields:
            v = fields[senaite_key]
            setattr(row, column, str(v) if v not in (None, "") else None)

    coa_updates = {k: v for k, v in fields.items() if k in _COA_META_FIELDS}
    if coa_updates:
        meta = json.loads(row.coa_meta) if row.coa_meta else {k: None for k in _COA_META_FIELDS}
        meta.update({k: (v if v not in ("",) else None) for k, v in coa_updates.items()})
        row.coa_meta = json.dumps(meta)

    analyte_edits = {k: v for k in fields if (m := _ANALYTE_KEY_RE.match(k))
                     for v in [fields[k]]}
    if analyte_edits:
        slots = json.loads(row.analytes) if row.analytes else []
        for key, value in analyte_edits.items():
            m = _ANALYTE_KEY_RE.match(key)
            idx, kind = int(m.group(1)) - 1, m.group(2)
            while len(slots) <= idx:
                slots.append({"name": None, "declared_quantity": None})
            if kind == "Peptide":
                slots[idx]["name"] = str(value).strip() if value else None
            else:
                slots[idx]["declared_quantity"] = str(value) if value not in (None, "") else None
        slots = [s for s in slots if s.get("name")]
        row.analytes = json.dumps(slots) if slots else None
        row.peptide_name = slots[0]["name"] if slots else None

    row.last_synced_at = datetime.utcnow()
    db.flush()
    return True
```

(`re` is already imported in service.py? Check the imports — add `import re` if absent.)

- [ ] **Step 4: Run the tests**

Run: `docker exec canonical-basic-info-test python -m pytest tests/test_registry_signal.py -q`
Expected: all pass

- [ ] **Step 5: Wire the two main.py sites**

In `update_senaite_sample_fields` (main.py ~:13346), after the successful SENAITE update and before the `return SenaiteFieldUpdateResponse(success=True, ...)`, add (the function needs a `db: Session = Depends(get_db)` parameter if it lacks one — check the signature):

```python
            # Dual-write mirror (registry slice 1): reflect the accepted
            # SENAITE edit onto the local registry row. Best-effort — a
            # mirror problem must never fail the user's edit.
            try:
                from sub_samples.service import apply_senaite_fields_to_row
                if apply_senaite_fields_to_row(db, uid, req.fields):
                    db.commit()
            except Exception as mirror_err:
                logger.warning(
                    "registry.field_mirror_failed uid=%s err=%s", uid, mirror_err
                )
```

In the publish flow (main.py ~:9885), after the VerificationCode `code_resp.raise_for_status()` succeeds, add the same pattern for just that field:

```python
                    try:
                        from sub_samples.service import apply_senaite_fields_to_row
                        if apply_senaite_fields_to_row(
                            db, senaite_uid, {"VerificationCode": verification_code}
                        ):
                            db.commit()
                    except Exception as mirror_err:
                        logger.warning(
                            "registry.field_mirror_failed uid=%s err=%s",
                            senaite_uid, mirror_err,
                        )
```

(Verify the publish-flow function has `db` in scope the same way — grep its signature; if it doesn't take a `db` dependency, add `db: Session = Depends(get_db)`.)

- [ ] **Step 6: Regression run**

Run: `docker exec canonical-basic-info-test python -m pytest tests/test_registry_signal.py tests/test_lims_sample_basic_info.py tests/test_sub_samples_service.py -q`
Expected: all pass

- [ ] **Step 7: Commit**

```bash
cd C:/tmp/canonical-basic-info
git add backend/sub_samples/service.py backend/main.py backend/tests/test_registry_signal.py
git commit -m "feat(registry): dual-write mirror at SENAITE field-edit sites"
```

---

### Task 6: IS — signal client + order-processor wiring

**Files (IS worktree `C:\tmp\is-registry`):**
- Modify: `app/adapters/accumk1.py` (add `notify_sample_created`)
- Modify: `app/services/order_processor.py` (~line 523: inside the `if result.success:` block after `create_analysis_request`)
- Test: `tests/unit/test_registry_signal.py` (create)

**Setup (one-time):**

```bash
cd C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/integration-service
git fetch origin && git worktree add C:/tmp/is-registry -b feat/registry-creation-signal origin/master
docker images --format "{{.Repository}}:{{.Tag}}" | grep -i integration   # pick the newest IS image
docker rm -f is-registry-test 2>/dev/null; docker run -d --name is-registry-test -v C:/tmp/is-registry://app -w //app --entrypoint sleep <IS_IMAGE> infinity
docker exec is-registry-test pip install -q pytest pytest-asyncio respx
```

**Interfaces:**
- Consumes: Mk1 `POST /s2s/lims-samples` (Task 4): body `{"sample_id": str|null, "senaite_uid": str|null, "meta": {…SENAITE field names…}}`, header `X-Service-Token`, response `{"sample_id", "native_id"}`.
- Produces: `AccuMk1Adapter.notify_sample_created(sample_id, senaite_uid, meta, idempotency_key=None) -> dict` (raises on HTTP error — best-effort handling lives at the CALLER); order processor fires it post-AR-creation inside a try/except.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/test_registry_signal.py` (follow the conventions of the neighboring adapter tests in `tests/unit/` — check how they construct `AccuMk1Adapter` and mock httpx; `respx` is available for httpx mocking):

```python
"""IS -> Mk1 registry creation signal (dual-write slice 1)."""
import pytest
import respx
import httpx
from app.adapters.accumk1 import AccuMk1Adapter


def _adapter():
    return AccuMk1Adapter(base_url="http://mk1.test", service_token="tok")


@respx.mock
@pytest.mark.asyncio
async def test_notify_sample_created_posts_contract():
    route = respx.post("http://mk1.test/s2s/lims-samples").mock(
        return_value=httpx.Response(200, json={"sample_id": "P-2001", "native_id": "aP-0001"})
    )
    out = await _adapter().notify_sample_created(
        sample_id="P-2001", senaite_uid="U1",
        meta={"ClientOrderNumber": "WP-1"}, idempotency_key="order-1-s1",
    )
    assert out["native_id"] == "aP-0001"
    req = route.calls[0].request
    assert req.headers["X-Service-Token"] == "tok"
    assert req.headers["Idempotency-Key"] == "order-1-s1"
    body = httpx.Request("POST", "http://x").read  # noqa — decode below
    import json as _json
    payload = _json.loads(route.calls[0].request.content)
    assert payload == {"sample_id": "P-2001", "senaite_uid": "U1",
                       "meta": {"ClientOrderNumber": "WP-1"}}


@respx.mock
@pytest.mark.asyncio
async def test_notify_sample_created_raises_on_http_error():
    respx.post("http://mk1.test/s2s/lims-samples").mock(
        return_value=httpx.Response(500)
    )
    with pytest.raises(httpx.HTTPStatusError):
        await _adapter().notify_sample_created("P-1", "U1", {})
```

(Drop the stray `body = …` line when writing the file — it's noise; keep the `payload` assertions.)

- [ ] **Step 2: Run to verify they fail**

Run: `docker exec is-registry-test python -m pytest tests/unit/test_registry_signal.py -q`
Expected: FAIL — `AttributeError: 'AccuMk1Adapter' object has no attribute 'notify_sample_created'`

- [ ] **Step 3: Implement the adapter method**

In `app/adapters/accumk1.py`, following the class's existing async-method conventions (httpx.AsyncClient per call or shared — match whatever the neighboring methods do):

```python
    async def notify_sample_created(
        self,
        sample_id: str | None,
        senaite_uid: str | None,
        meta: dict,
        idempotency_key: str | None = None,
    ) -> dict:
        """Registry creation signal (dual-write slice 1): tell Accu-Mk1 a
        sample now exists so it can mint its registry row + native id.
        meta is a SENAITE-shaped field dict (the same keys the AR was
        created from). Raises on HTTP error — the caller decides whether
        the failure matters (order processing treats it as best-effort)."""
        url = f"{self.base_url}/s2s/lims-samples"
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.post(
                url,
                json={"sample_id": sample_id, "senaite_uid": senaite_uid, "meta": meta},
                headers=self._headers(idempotency_key=idempotency_key),
            )
            resp.raise_for_status()
            return resp.json()
```

- [ ] **Step 4: Run adapter tests**

Run: `docker exec is-registry-test python -m pytest tests/unit/test_registry_signal.py -q`
Expected: 2 passed

- [ ] **Step 5: Wire the order processor**

In `app/services/order_processor.py`, inside the `if result.success:` block right after the `sample_results.append(...)` / "Sample created in SENAITE" log (~line 535), add:

```python
                    # Registry creation signal (dual-write slice 1):
                    # best-effort — Mk1 registry problems must never fail
                    # order processing (the lazy first-touch + reconcile
                    # fallback catches missed samples).
                    try:
                        accumk1 = self._accumk1 or get_accumk1_adapter()
                        await accumk1.notify_sample_created(
                            sample_id=result.sample_id,
                            senaite_uid=getattr(result, "uid", None),
                            meta=dict(ar_data),
                            idempotency_key=f"registry-{order.order_id}-{normalized.number}",
                        )
                    except Exception as reg_err:
                        logger.warning(
                            "Registry signal failed (non-fatal)",
                            extra={"sample_number": normalized.number,
                                   "senaite_id": result.sample_id,
                                   "error": str(reg_err)},
                        )
```

Adaptation notes for the implementer (resolve against the real file, escalate NEEDS_CONTEXT if structurally different):
- How the processor gets adapters: if the class already holds adapters via constructor/DI (`self.senaite` exists), add an `accumk1` adapter the same way (`self._accumk1`, injected via `dependencies.get_accumk1_adapter()` at construction, with the try/except above ALSO catching the not-configured RuntimeError so unconfigured environments skip silently — that is required: environments without `ACCUMK1_BASE_URL` must process orders normally).
- `ar_data` is the SENAITE-shaped dict built by `build_analysis_request_from_sample` — forward it as `meta` verbatim (it carries ClientSampleID, Analyte*, Coa*, ClientOrderNumber, etc.). If `ar_data` nests fields (inspect the builder), flatten to the field dict the SENAITE create API receives.
- `result.uid`: include if the create result exposes the AR uid; else pass None (Mk1 fills uid via its reconcile later).

- [ ] **Step 6: Wiring test**

Append to `tests/unit/test_registry_signal.py` a test at whatever seam the order-processor tests already use (check `tests/unit/test_order_processor*.py` for the harness — reuse its fixtures). The two behaviors to pin:

```python
# Pseudocode contract — adapt to the existing order-processor test harness:
# 1) after a successful create_analysis_request, notify_sample_created is
#    awaited once with sample_id == result.sample_id and meta == ar_data
# 2) notify_sample_created raising (or the adapter being unconfigured) does
#    NOT fail processing: the sample still lands in sample_results as
#    "created" and a warning is logged
```

Write both as real tests against the existing harness — if the harness can't reach this seam without deep refactoring, report DONE_WITH_CONCERNS explaining exactly what blocked it.

- [ ] **Step 7: Run IS suite + lint gate on new code**

Run: `docker exec is-registry-test python -m pytest tests/unit/test_registry_signal.py -q` then `docker exec is-registry-test sh -c "export PATH=$PATH:/home/appuser/.local/bin 2>/dev/null; ruff check app/adapters/accumk1.py app/services/order_processor.py 2>/dev/null || true"`
Expected: tests pass; ruff clean on the touched files (repo-wide red is baseline).

- [ ] **Step 8: Commit (IS repo)**

```bash
cd C:/tmp/is-registry
git add app/adapters/accumk1.py app/services/order_processor.py tests/unit/test_registry_signal.py
git commit -m "feat(registry): fire Mk1 creation signal after SENAITE AR creation (best-effort)"
```

---

### Task 7: Regression gate + push + PRs

- [ ] **Step 1: Mk1 regression**

Run: `docker exec canonical-basic-info-test python -m pytest tests/test_registry_signal.py tests/test_native_id.py tests/test_lims_sample_basic_info.py tests/test_backfill_basic_info.py tests/test_sub_samples_service.py tests/test_sub_samples_cutover.py tests/test_container_mode.py tests/test_customer_remarks.py -q`
Expected: all pass except the known `test_container_mode.py` 4F/7E Postgres baseline. Anything else: verify at the pre-branch commit before attributing.

- [ ] **Step 2: Push + PRs**

```bash
cd C:/tmp/canonical-basic-info && git push -u origin feat/registry-dual-write
gh pr create --repo Zstar0/Accu-Mk1 --base master --head feat/registry-dual-write --title "feat: registry dual-write slice 1 — full sample record + native IDs + S2S creation signal"
cd C:/tmp/is-registry && git push -u origin feat/registry-creation-signal
gh pr create --repo ValenceAnalytical/accumark-integration-service --base master --head feat/registry-creation-signal --title "feat: registry creation signal to Accu-Mk1 (best-effort, post-AR-creation)"
```

PR bodies: summary + test counts + the dormancy statement (Mk1 endpoint is inert until IS is configured with `ACCUMK1_*` env; IS wiring is inert until those env vars exist — no behavior change on deploy without config).

---

### Task 8 (Handler-gated): Stack rehearsal + deploy sequencing

**Do not start without the Handler.** Needs an isolated stack with BOTH worktrees mounted (`accumark-stack create` + `mount <name> --mk1 <mk1-worktree> --is <is-worktree>` on the devbox) and the stack's IS env given `ACCUMK1_BASE_URL=http://accu-mk1-backend:8000` + `ACCUMK1_INTERNAL_SERVICE_TOKEN=<the stack's token>` (via the per-stack `.env` — never by editing the services).

- [ ] Place a WP order end-to-end on the stack → verify the registry row exists with `native_id`, full composition, `container_mode=true`, `status=sample_due` — BEFORE any Mk1 touch.
- [ ] Re-run the backfill re-sweep (`rm` checkpoint first) → historical rows gain the new columns; `native_id` stays NULL on them (forward-only).
- [ ] Kill the Mk1 backend, place another order → order processing still succeeds (signal best-effort proven live); lazy fallback later creates the row.
- [ ] Deploy sequencing (after the base registry deploy + prod backfill from the previous slice): Mk1 release first (endpoint live, inert), then IS release + add the two `ACCUMK1_*` keys to prod IS `.env` (append — never overwrite prod env files), then one off-hours re-sweep to fill the new columns across history.

---

## Self-Review (completed)

- **Spec coverage:** columns+sequences → T1; populate extension + re-sweep-fills-for-free → T2 (backfill suite green proves it); minting → T3; signal upsert + endpoint + SENAITE-free form + container gate + status-no-regress → T4; dual-write mirrors (both sites incl. publish VerificationCode) → T5; IS adapter + wiring + failure isolation + unconfigured-env silence → T6; ISO evidence + rehearsal → T8. Open items from the spec all resolved by recon (keys pinned in Global Constraints; edit sites enumerated; S2S = `require_internal_service_token`; IS placement = order_processor:~523).
- **Placeholder scan:** T6 Step 6 gives a contract-pseudocode block by design (the existing IS test harness must be reused, not invented here) — the step demands real tests and defines the two behaviors precisely; acceptable. No TBDs elsewhere.
- **Type consistency:** `upsert_sample_from_signal(db, sample_id, senaite_uid, meta)` (T4 def == T4 endpoint call == T6 adapter contract); `mint_native_id(db, senaite_sample_id=, sample_type_title=)` (T3 def == T4 calls); `apply_senaite_fields_to_row(db, senaite_uid, fields)` (T5 def == T5 main.py calls); `_parse_analyte_slots` defined T2, used T2 only (T5 has its own slot-merge — different semantics, intentional).
- **Known judgment call:** signal never regresses `status` (T4 test) — the signal's state is stale by definition; live state stays SENAITE-owned this program.

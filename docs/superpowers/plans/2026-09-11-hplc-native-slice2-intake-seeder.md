# HPLC Native — Slice 2 (M3 native-born intake + M4 native seeder/placeholders) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A sample registered with no SENAITE id becomes a real, customer-facing `P-`/`PB-` Mk1-native sample whose HPLC vial seeds the native trio per analyte slot, with per-slot parent placeholders, an idempotent registry signal, an adoption guard against SENAITE id collisions, and an S2S peptide list for the Integration Service.

**Architecture:** Extends the existing SENAITE-free branch of `upsert_sample_from_signal` (it already mints `aP-` ids and stamps `external_lims_system="mk1"`) so the customer-facing id comes from a new per-prefix counter seeded above SENAITE's max. A new module `lims_analyses/hplc_native.py` owns "what does a native-born HPLC sample need": slot→peptide resolution from `lims_samples.analytes`, stamped per-row titles, and the row builder. `seed_analyses_for_vial` forks on `parent.external_lims_system == "mk1"` before the SENAITE mirror; `seed_parent_placeholders` mints one `ordered` row per slot for trio members on native-born parents. Everything stays dark for SENAITE-born samples: their code paths are untouched, and no IS today sends a sample_id-less signal.

**Tech Stack:** Python 3.12 / FastAPI / SQLAlchemy 2, Postgres (live-DB tests via `SessionLocal`), sqlite in-memory unit tests, pytest.

**Spec:** `docs/superpowers/specs/2026-09-10-hplc-native-born-design.md` — sections "Key design decisions", M3, M4, and the Handler rulings (P-/PB- look; unresolved analyte ⇒ NULL peptide row + flag; identity result literal `Conforms`). Slice 1 (`docs/superpowers/plans/2026-09-10-hplc-native-slice1-schema-catalog-alias.md`) is the base: it added `lims_analyses.peptide_id`/`slot`, `create_analysis(..., peptide_id=, slot=, reportable_reason=)`, the five native services (`HPLC-IDENTITY`, `HPLC-PURITY`, `HPLC-QUANTITY`, `HPLC-BLEND-PURITY`, `HPLC-BLEND-TOTAL`) and the profile `hplc-purity-identity` (seeded inactive) in `backend/catalog/hplc_native_seed.py`.

## Global Constraints

- Branch `feat/hplc-native-slice2` off `feat/hplc-native-slice1` (8b0d2f74 or later; PR #192). Worktree `C:\tmp\Accu-Mk1-hplc-slice2`. Commit by pathspec only; never `git stash`.
- Additive only. SENAITE-born samples (`external_lims_system != "mk1"`) must behave byte-identically: every new branch is keyed on `external_lims_system == "mk1"` or on a sample_id-less signal.
- Customer-facing native ids are `P-NNNN` / `PB-NNNN` (4-digit zero pad, grows past 9999), minted from `lims_native_id_sequences` rows `P` and `PB` seeded at **5000** and **1000** by a guarded boot migration. Bacteriostatic Water is never native-minted in this program (raise).
- The internal `native_id` (`aP-`/`aPB-`) keeps its current contract and tests (`mint_native_id` byte-identical).
- Adoption guard: a signal carrying a `senaite_uid` for an existing `external_lims_system == "mk1"` row is an identity collision → quarantine via the existing `_quarantine_collision`, never adopt.
- `Idempotency-Key` on `POST /s2s/lims-samples` is optional (old IS) but, when present and already seen, the route returns the stored sample without re-upserting.
- Unresolved analyte name at seed time ⇒ row with `peptide_id NULL`, `reportable_reason="analyte_unresolved: <raw>"`, WARN log; never a guessed peptide. Two or more matches ⇒ same, reason `analyte_ambiguous`.
- Row titles are stamped per slot: `"<name> - Identity (HPLC)"`, `"<name> - Purity (HPLC)"`, `"<name> - Quantity (HPLC)"`; blend aggregates keep the service title. Slot = 1-based position in `lims_samples.analytes`.
- Raw-SQL boot migrations contain no `:name` bind tokens (`test_boot_migration_statements_have_no_bindparams`).
- Test gate = full backend failure-set diff vs the slice-1 branch head (never zero-failures). Python: `"C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1\backend\.venv\Scripts\python.exe" -m pytest -q -p no:cacheprovider` from the worktree's `backend/`. After adding boot migrations run `database._run_migrations()` once against the dev DB before live-DB tests.

---

### Task 1: Customer-facing native ids (`mint_customer_sample_id`) + counter seed

**Files:**
- Modify: `backend/sub_samples/native_id.py`
- Modify: `backend/database.py` (`_run_migrations()` list, append at the END)
- Test: `backend/tests/test_native_id.py` (extend), `backend/tests/test_hplc_native_schema.py` (extend: migration marker)

**Interfaces:**
- Produces: `mint_customer_sample_id(db: Session, sample_type_title: str) -> str` returning e.g. `"P-5000"`; raises `ValueError` for unknown/BW types or when the prefix row has not been seeded. Boot statement marker: `"lims_native_id_sequences"` + `"'P', 5000"`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_native_id.py`:

```python
from sub_samples.native_id import mint_customer_sample_id, CUSTOMER_PREFIXES


def _seed_customer_counters(db, p=5000, pb=1000):
    db.add(LimsNativeIdSequence(prefix="P", next_value=p))
    db.add(LimsNativeIdSequence(prefix="PB", next_value=pb))
    db.commit()


def test_customer_prefix_map_is_peptide_and_blend_only():
    assert CUSTOMER_PREFIXES == {"peptide": "P", "peptide blend": "PB"}


def test_customer_id_mints_from_seeded_counter(db):
    _seed_customer_counters(db)
    assert mint_customer_sample_id(db, "Peptide") == "P-5000"
    assert mint_customer_sample_id(db, "Peptide") == "P-5001"
    assert mint_customer_sample_id(db, "Peptide Blend") == "PB-1000"


def test_customer_id_skips_ids_already_taken(db):
    """SENAITE may still mint P- ids after the flip (legacy retests, transfers);
    a taken id is skipped forward, never reused."""
    from models import LimsSample
    _seed_customer_counters(db)
    db.add(LimsSample(sample_id="P-5000"))
    db.add(LimsSample(sample_id="P-5001"))
    db.commit()
    assert mint_customer_sample_id(db, "Peptide") == "P-5002"


def test_customer_id_refuses_unseeded_prefix(db):
    with pytest.raises(ValueError, match="not seeded"):
        mint_customer_sample_id(db, "Peptide")


def test_customer_id_refuses_bac_water_and_unknown(db):
    _seed_customer_counters(db)
    with pytest.raises(ValueError):
        mint_customer_sample_id(db, "Bacteriostatic Water")
    with pytest.raises(ValueError):
        mint_customer_sample_id(db, "Mystery Goo")


def test_internal_native_id_unchanged_for_customer_ids(db):
    """The aP- internal id still derives from the P- id (existing contract)."""
    assert mint_native_id(db, senaite_sample_id="P-5000") == "aP-0001"
```

Append to `backend/tests/test_hplc_native_schema.py`:

```python
def test_boot_migration_seeds_customer_counters():
    stmts = _captured()
    seed = [s for s in stmts if "lims_native_id_sequences" in s and "NOT EXISTS" in s]
    assert len(seed) == 2, [s[:80] for s in seed]
    assert any("'P', 5000" in s for s in seed)
    assert any("'PB', 1000" in s for s in seed)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python -m pytest tests/test_native_id.py tests/test_hplc_native_schema.py -v -k "customer or counters"`
Expected: FAIL with `ImportError: cannot import name 'mint_customer_sample_id'` / no seed statements.

- [ ] **Step 3: Implement the mint**

Append to `backend/sub_samples/native_id.py`:

```python
# ── Customer-facing native ids (spec 2026-09-10, M3) ────────────────────────
# A native-born sample (no SENAITE AR) must still LOOK like every other
# sample to the customer: P-NNNN / PB-NNNN. These counters are seeded by a
# guarded boot migration ABOVE SENAITE's prod maximum (P at 5000, PB at 1000,
# Handler ruling 2026-09-10) so the two authorities cannot collide while the
# legacy drain runs. Bacteriostatic Water is deliberately absent: BW stays
# SENAITE-born in this program. A prefix row that does not exist is an
# operator error (the seed never ran), never auto-created at 1 — that would
# mint P-0001 on prod.
CUSTOMER_PREFIXES = {"peptide": "P", "peptide blend": "PB"}


def mint_customer_sample_id(db: Session, sample_type_title: str) -> str:
    from models import LimsSample

    key = (sample_type_title or "").strip().lower()
    prefix = CUSTOMER_PREFIXES.get(key)
    if prefix is None:
        raise ValueError(
            f"no native customer-facing prefix for sample type {sample_type_title!r} "
            "(only Peptide / Peptide Blend are native-born)"
        )
    seq = db.execute(
        select(LimsNativeIdSequence)
        .where(LimsNativeIdSequence.prefix == prefix)
        .with_for_update()
    ).scalar_one_or_none()
    if seq is None:
        raise ValueError(
            f"customer id counter for prefix {prefix!r} is not seeded "
            "(boot migration lims_native_id_sequences P/PB missing)"
        )
    while True:
        value = seq.next_value
        seq.next_value = value + 1
        candidate = f"{prefix}-{value:0{_PAD}d}"
        taken = db.execute(
            select(LimsSample.id).where(LimsSample.sample_id == candidate)
        ).first()
        if taken is None:
            db.flush()
            return candidate
```

- [ ] **Step 4: Add the guarded counter seed to the boot migrations**

In `backend/database.py` `_run_migrations()`, append to the END of the `migrations` list (after the five HPLC-native DO blocks from slice 1):

```python
        # HPLC-native slice 2 (spec 2026-09-10, M3): customer-facing native id
        # counters, seeded ONCE above SENAITE's prod max (Handler ruling
        # 2026-09-10: P-5000 / PB-1000). Guarded — never resets an existing
        # counter. The aP/aPB internal counters are untouched.
        """
        INSERT INTO lims_native_id_sequences (prefix, next_value)
        SELECT 'P', 5000
        WHERE NOT EXISTS (SELECT 1 FROM lims_native_id_sequences WHERE prefix = 'P')
        """,
        """
        INSERT INTO lims_native_id_sequences (prefix, next_value)
        SELECT 'PB', 1000
        WHERE NOT EXISTS (SELECT 1 FROM lims_native_id_sequences WHERE prefix = 'PB')
        """,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `python -m pytest tests/test_native_id.py tests/test_hplc_native_schema.py tests/test_workflow_engine.py::test_boot_migration_statements_have_no_bindparams -v`
Expected: PASS. Then apply to the dev DB once: `python -c "import database; database._run_migrations()"` and confirm `SELECT prefix, next_value FROM lims_native_id_sequences` shows `P|5000`, `PB|1000`.

- [ ] **Step 6: Commit**

```bash
git add backend/sub_samples/native_id.py backend/database.py backend/tests/test_native_id.py backend/tests/test_hplc_native_schema.py
git commit -m "feat(registry): customer-facing native ids P-/PB- from seeded counters (HPLC-native M3)" -- backend/sub_samples/native_id.py backend/database.py backend/tests/test_native_id.py backend/tests/test_hplc_native_schema.py
```

---

### Task 2: Native-born intake — P-/PB- sample_id, adoption guard, `Analyte{i}PeptideId`

**Files:**
- Modify: `backend/sub_samples/service.py` (`upsert_sample_from_signal` ~293-386; `_parse_analyte_slots` ~459-481)
- Test: `backend/tests/test_registry_signal.py` (extend + one contract update)

**Interfaces:**
- Consumes: `mint_customer_sample_id` (Task 1).
- Produces: sample_id-less signal → `row.sample_id == "P-5000"` (from `SampleTypeTitle`), `row.native_id == "aP-0001"`, `external_lims_system="mk1"`, `external_lims_uid=None`. `lims_samples.analytes` slot dicts gain an optional `"peptide_id": int|None` key when the signal carries `Analyte{i}PeptideId`. A `senaite_uid` signal against an existing mk1 row quarantines (returns the quarantine row) and never rebinds.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_registry_signal.py`:

```python
def _seed_customer_counters(db):
    db.add(LimsNativeIdSequence(prefix="P", next_value=5000))
    db.add(LimsNativeIdSequence(prefix="PB", next_value=1000))
    db.commit()


def test_senaite_free_signal_mints_customer_facing_id(db):
    _seed_customer_counters(db)
    row = upsert_sample_from_signal(db, sample_id=None, senaite_uid=None,
                                    meta=_signal_meta(uid=None, SampleTypeTitle="Peptide"))
    assert row.sample_id == "P-5000"
    assert row.native_id == "aP-0001"
    assert row.external_lims_system == "mk1" and row.external_lims_uid is None


def test_senaite_free_blend_signal_uses_pb_prefix(db):
    _seed_customer_counters(db)
    row = upsert_sample_from_signal(db, sample_id=None, senaite_uid=None,
                                    meta=_signal_meta(uid=None, SampleTypeTitle="Peptide Blend"))
    assert row.sample_id == "PB-1000"


def test_senaite_free_signal_without_seeded_counter_raises(db):
    with pytest.raises(ValueError, match="not seeded"):
        upsert_sample_from_signal(db, sample_id=None, senaite_uid=None,
                                  meta=_signal_meta(uid=None, SampleTypeTitle="Peptide"))


def test_native_row_never_adopts_a_senaite_uid(db):
    """Spec ruling (F3): after the flip SENAITE keeps minting P- ids for legacy
    retests/transfers; a later signal for an EXISTING native row carrying a
    senaite_uid is an identity collision, not an attach."""
    _seed_customer_counters(db)
    native = upsert_sample_from_signal(db, sample_id=None, senaite_uid=None,
                                       meta=_signal_meta(uid=None, SampleTypeTitle="Peptide"))
    result = upsert_sample_from_signal(db, sample_id=native.sample_id,
                                       senaite_uid="LATE_UID",
                                       meta=_signal_meta(uid="LATE_UID"))
    db.refresh(native)
    assert native.external_lims_system == "mk1" and native.external_lims_uid is None
    assert result.id != native.id and result.quarantined is True
    assert result.sample_id.startswith(native.sample_id)


def test_signal_analyte_peptide_ids_land_in_slots(db):
    _seed_customer_counters(db)
    meta = _signal_meta(uid=None, SampleTypeTitle="Peptide Blend")
    meta.update({"Analyte1Peptide": "BPC-157 - Identity (HPLC)", "Analyte1PeptideId": 7,
                 "Analyte2Peptide": "TB-500 - Identity (HPLC)", "Analyte2PeptideId": "12"})
    row = upsert_sample_from_signal(db, sample_id=None, senaite_uid=None, meta=meta)
    slots = json.loads(row.analytes)
    assert slots[0]["peptide_id"] == 7 and slots[1]["peptide_id"] == 12
    assert slots[0]["name"] == "BPC-157 - Identity (HPLC)"


def test_signal_without_peptide_ids_keeps_slot_shape(db):
    row = upsert_sample_from_signal(db, "P-2001", "AR_UID_1",
                                    _signal_meta(Analyte1Peptide="BPC-157 - Identity (HPLC)"))
    slots = json.loads(row.analytes)
    assert slots[0].get("peptide_id") is None
    assert set(slots[0]) == {"name", "declared_quantity", "peptide_id"}
```

Read `_signal_meta` at the top of the file: it takes `**over` and merges into the dict, so the kwargs above work as written; if it does not accept arbitrary keys, extend it minimally (`m.update(over)`).

The existing test `test_native_row_later_attached_to_senaite_keeps_uid` asserts the OLD "attach wins" contract, which the spec's adoption-guard ruling reverses. **Delete that test** and note the reversal in the commit message (this is a deliberate contract change under the spec, not a stale test).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python -m pytest tests/test_registry_signal.py -v -k "customer_facing or pb_prefix or not_seeded or never_adopts or peptide_ids or slot_shape"`
Expected: FAIL (sample_id is `aP-0001`; attach still wins; no `peptide_id` key).

- [ ] **Step 3: Implement the intake changes**

In `backend/sub_samples/service.py`:

(a) `_parse_analyte_slots`: carry the optional id. Change `_EMPTY_SLOT` and the append:

```python
_EMPTY_SLOT = {"name": None, "declared_quantity": None, "peptide_id": None}
```
and inside the loop, after computing `qty`:
```python
        pid_raw = meta.get(f"Analyte{i}PeptideId")
        try:
            pid = int(pid_raw) if pid_raw not in (None, "") else None
        except (TypeError, ValueError):
            pid = None
        slots.append({
            "name": str(name).strip(),
            "declared_quantity": str(qty) if qty not in (None, "") else None,
            "peptide_id": pid,
        })
```
Grep for every reader of the slot dicts (`_parse_analyte_slots`, `registry_details`, `registry_inbox`, `coa/sample_meta.py:50`, the PB-0469 slot editor in `main.py`) and confirm they read by key (`slot["name"]`, `slot.get("declared_quantity")`) so the extra key is inert; the slot editor that WRITES slots must preserve `peptide_id` when it rewrites a slot — if it rebuilds dicts from `name`/`declared_quantity` only, add `"peptide_id": old.get("peptide_id")`.

(b) `upsert_sample_from_signal`, existing-row branch — the adoption guard. Replace:
```python
    if existing:
        if (senaite_uid and existing.external_lims_uid
                and existing.external_lims_uid != senaite_uid):
            return _quarantine_collision(db, existing, senaite_uid, meta)
```
with:
```python
    if existing:
        if (senaite_uid and existing.external_lims_uid
                and existing.external_lims_uid != senaite_uid):
            return _quarantine_collision(db, existing, senaite_uid, meta)
        # Adoption guard (spec 2026-09-10 F3): a native-born row has no uid to
        # disagree with, so the old guard let a SENAITE AR minted under the
        # same P- id (legacy retest / transfer after the flip) be ADOPTED onto
        # another customer's native sample. Native identity is final.
        if senaite_uid and existing.external_lims_system == "mk1":
            return _quarantine_collision(db, existing, senaite_uid, meta)
```
Check `_quarantine_collision`'s log/flag text still reads sensibly when `existing.external_lims_uid` is None (it prints `stored uid None`) — acceptable; extend the reason string with `"(native-born row)"` when `existing.external_lims_system == "mk1"`.

(c) `upsert_sample_from_signal`, new-row branch — customer id first:
```python
    sample_type_title = (meta.get("getSampleTypeTitle") or meta.get("SampleTypeTitle"))
    born_native = not sample_id
    if born_native:
        from sub_samples.native_id import mint_customer_sample_id
        sample_id = mint_customer_sample_id(db, sample_type_title)
    native_id_value = mint_native_id(
        db, senaite_sample_id=sample_id, sample_type_title=sample_type_title,
    )
    row = _create_sample_row(db, sample_id, meta)
    if meta.get("VendorName"):
        row.vendor_name = str(meta["VendorName"])[:200]
    row.native_id = native_id_value
    if born_native:
        row.external_lims_uid = None
        row.external_lims_system = "mk1"
```
Update the docstring's "SENAITE-free form" paragraph: the minted id is now the customer-facing `P-`/`PB-` id; the retry contract (echo the returned `sample_id`) is unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python -m pytest tests/test_registry_signal.py tests/test_native_id.py tests/test_adoption_uid_guard.py -v`
Expected: PASS (minus the deleted test). Also run `python -m pytest tests -q -k "analyte_slot or slot_editor or pb0469 or registry_details or registry_inbox or sample_meta"` and confirm no reader broke on the extra key.

- [ ] **Step 5: Commit**

```bash
git add backend/sub_samples/service.py backend/tests/test_registry_signal.py
git commit -m "feat(registry): native-born signals mint P-/PB- ids, never adopt a SENAITE uid, carry Analyte{i}PeptideId (HPLC-native M3)

Contract change under spec 2026-09-10 F3: a senaite_uid signal against an existing native row quarantines instead of attaching; the old attach-wins test is removed." -- backend/sub_samples/service.py backend/tests/test_registry_signal.py
```

---

### Task 3: Idempotent `POST /s2s/lims-samples`

**Files:**
- Modify: `backend/models.py` (new model after `LimsNativeIdSequence`)
- Modify: `backend/main.py` (`s2s_upsert_lims_sample` ~22816-22850)
- Test: `backend/tests/test_registry_signal.py` (extend; reuse the endpoint test idiom of `test_s2s_endpoint_rejects_missing_token`)

**Interfaces:**
- Produces: table `lims_registry_signal_keys(idempotency_key VARCHAR(200) PK, sample_id VARCHAR(100) NOT NULL, created_at TIMESTAMP)`; model `LimsRegistrySignalKey`. Route reads header `Idempotency-Key` (optional). Replay with a known key returns the stored sample's `{sample_id, native_id}` and schedules no background tasks.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_registry_signal.py` (read the existing `test_s2s_endpoint_rejects_missing_token` to copy exactly how it builds the `TestClient`, sets `ACCUMK1_INTERNAL_SERVICE_TOKEN`, and overrides `get_db` with the sqlite session — reuse that helper; if it is inline, factor it into `_client(db)` at the bottom of the file):

```python
def test_s2s_signal_replay_with_same_idempotency_key_does_not_remint(db, monkeypatch):
    _seed_customer_counters(db)
    client = _client(db)
    body = {"sample_id": None, "senaite_uid": None, "meta": _signal_meta(uid=None, SampleTypeTitle="Peptide")}
    h = {"X-Service-Token": "tok", "Idempotency-Key": "registry-3267-1"}
    r1 = client.post("/s2s/lims-samples", json=body, headers=h)
    r2 = client.post("/s2s/lims-samples", json=body, headers=h)
    assert r1.status_code == 200 and r2.status_code == 200
    assert r1.json() == r2.json() == {"sample_id": "P-5000", "native_id": "aP-0001"}
    assert db.query(LimsSample).filter(LimsSample.sample_id.like("P-%")).count() == 1


def test_s2s_signal_without_idempotency_key_still_works(db):
    """Old IS never sent the header on this route; keep accepting."""
    _seed_customer_counters(db)
    client = _client(db)
    body = {"sample_id": None, "senaite_uid": None, "meta": _signal_meta(uid=None, SampleTypeTitle="Peptide")}
    r = client.post("/s2s/lims-samples", json=body, headers={"X-Service-Token": "tok"})
    assert r.status_code == 200 and r.json()["sample_id"] == "P-5000"


def test_s2s_signal_key_is_scoped_per_sample_not_global(db):
    _seed_customer_counters(db)
    client = _client(db)
    mk = lambda n: {"sample_id": None, "senaite_uid": None,
                    "meta": _signal_meta(uid=None, SampleTypeTitle="Peptide")}
    r1 = client.post("/s2s/lims-samples", json=mk(1), headers={"X-Service-Token": "tok", "Idempotency-Key": "registry-1-1"})
    r2 = client.post("/s2s/lims-samples", json=mk(2), headers={"X-Service-Token": "tok", "Idempotency-Key": "registry-1-2"})
    assert {r1.json()["sample_id"], r2.json()["sample_id"]} == {"P-5000", "P-5001"}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python -m pytest tests/test_registry_signal.py -v -k idempotency`
Expected: FAIL — second post mints `P-5001`.

- [ ] **Step 3: Add the model**

In `backend/models.py` after `LimsNativeIdSequence`:

```python
class LimsRegistrySignalKey(Base):
    """Idempotency ledger for POST /s2s/lims-samples (spec 2026-09-10, M3).
    The IS sends `Idempotency-Key: registry-{order_id}-{sample_number}`; a
    sample_id-less (native-born) signal has no natural key, so without this a
    Mk1-committed-but-IS-timed-out retry minted a SECOND sample. Rows are
    write-once; replay returns the stored sample."""
    __tablename__ = "lims_registry_signal_keys"

    idempotency_key: Mapped[str] = mapped_column(String(200), primary_key=True)
    sample_id: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
```
`Base.metadata.create_all` in `init_db` creates the table on existing DBs; no raw migration needed.

- [ ] **Step 4: Wire the route**

In `backend/main.py` `s2s_upsert_lims_sample`, add the header param and the ledger:

```python
def s2s_upsert_lims_sample(
    req: RegistrySampleSignal,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    _: None = Depends(require_internal_service_token),
    idempotency_key: Optional[str] = Header(None, alias="Idempotency-Key"),
):
    ...
    from sub_samples.service import upsert_sample_from_signal
    from models import LimsRegistrySignalKey, LimsSample
    if idempotency_key:
        seen = db.get(LimsRegistrySignalKey, idempotency_key)
        if seen is not None:
            prior = db.query(LimsSample).filter_by(sample_id=seen.sample_id).one_or_none()
            if prior is not None:
                logger.info("registry.signal_replayed key=%s sample_id=%s", idempotency_key, prior.sample_id)
                return RegistrySampleSignalResponse(sample_id=prior.sample_id, native_id=prior.native_id)
    row = upsert_sample_from_signal(db, req.sample_id, req.senaite_uid, req.meta)
    if idempotency_key:
        db.merge(LimsRegistrySignalKey(idempotency_key=idempotency_key, sample_id=row.sample_id))
    db.commit()
    ... (background tasks unchanged) ...
```
Keep the existing docstring and add two sentences on the ledger. `Header`/`Optional` are already imported in `main.py` (used by the peptide-requests route); confirm.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `python -m pytest tests/test_registry_signal.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/models.py backend/main.py backend/tests/test_registry_signal.py
git commit -m "feat(s2s): honor Idempotency-Key on /s2s/lims-samples (HPLC-native M3)" -- backend/models.py backend/main.py backend/tests/test_registry_signal.py
```

---

### Task 4: `GET /s2s/peptides`

**Files:**
- Modify: `backend/main.py` (add after `s2s_catalog_service_keys` ~22779)
- Test: `backend/tests/test_s2s_peptides.py` (create; same TestClient idiom as Task 3)

**Interfaces:**
- Produces: `GET /s2s/peptides` (service token) → `{"peptides": [{id, name, abbreviation, is_blend, active, analyte_class, display_aliases, hplc_aliases}], "generated_at": iso}`; ships ALL peptides (active or not) like the catalog route — the IS filters.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_s2s_peptides.py
"""GET /s2s/peptides — Mk1 peptide list for the Integration Service (spec
2026-09-10 M3 / IS-6): replaces the SENAITE-sourced WordPress dropdown."""
import os
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import models  # noqa: F401
from models import Base, Peptide


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(db, monkeypatch):
    monkeypatch.setenv("ACCUMK1_INTERNAL_SERVICE_TOKEN", "tok")
    import main
    main.app.dependency_overrides[main.get_db] = lambda: db
    try:
        yield TestClient(main.app)
    finally:
        main.app.dependency_overrides.pop(main.get_db, None)


def test_s2s_peptides_requires_token(client):
    assert client.get("/s2s/peptides").status_code in (401, 403)


def test_s2s_peptides_ships_every_peptide_with_ids_and_aliases(client, db):
    db.add(Peptide(name="BPC-157", abbreviation="BPC157", active=True, hplc_aliases=["BPC"]))
    db.add(Peptide(name="Old Thing", abbreviation="OLD", active=False))
    db.add(Peptide(name="GLOW", abbreviation="GLOW", is_blend=True))
    db.commit()
    r = client.get("/s2s/peptides", headers={"X-Service-Token": "tok"})
    assert r.status_code == 200
    body = r.json()
    rows = {p["name"]: p for p in body["peptides"]}
    assert set(rows) == {"BPC-157", "Old Thing", "GLOW"}
    assert rows["BPC-157"]["hplc_aliases"] == ["BPC"] and rows["BPC-157"]["active"] is True
    assert rows["Old Thing"]["active"] is False
    assert rows["GLOW"]["is_blend"] is True
    assert set(rows["BPC-157"]) == {"id", "name", "abbreviation", "is_blend", "active",
                                    "analyte_class", "display_aliases", "hplc_aliases"}
    assert "generated_at" in body
```
If `main.get_db` is not the dependency name used by the S2S routes, read `s2s_catalog_service_keys`'s signature and override that one.

- [ ] **Step 2: Run to verify it fails**

Run: `python -m pytest tests/test_s2s_peptides.py -v`
Expected: 404 on the route.

- [ ] **Step 3: Implement the route**

In `backend/main.py`, directly after `s2s_catalog_service_keys`:

```python
class S2SPeptide(BaseModel):
    id: int
    name: str
    abbreviation: str
    is_blend: bool = False
    active: bool = True
    analyte_class: str = "peptide"
    display_aliases: Optional[list[str]] = None
    hplc_aliases: Optional[list[str]] = None


class S2SPeptideList(BaseModel):
    peptides: list[S2SPeptide]
    generated_at: str


@app.get("/s2s/peptides", response_model=S2SPeptideList)
def s2s_peptides(
    db: Session = Depends(get_db),
    _: None = Depends(require_internal_service_token),
):
    """Mk1 peptide catalog for the Integration Service (spec 2026-09-10,
    M3/IS-6): the WordPress analyte dropdown and Analyte{i}PeptideId on the
    registry signal come from HERE, not from SENAITE's service titles. Ships
    every peptide, active or not, on purpose (same rule as
    /s2s/catalog/service-keys): the IS decides what is sellable. Read-only,
    no pagination (low hundreds of rows). Every declared field is listed
    explicitly because response_model silently drops undeclared keys."""
    from models import Peptide
    rows = db.query(Peptide).order_by(Peptide.name).all()
    return S2SPeptideList(
        peptides=[S2SPeptide(
            id=p.id, name=p.name, abbreviation=p.abbreviation,
            is_blend=bool(p.is_blend), active=bool(p.active),
            analyte_class=p.analyte_class or "peptide",
            display_aliases=p.display_aliases, hplc_aliases=p.hplc_aliases,
        ) for p in rows],
        generated_at=datetime.utcnow().isoformat() + "Z",
    )
```

- [ ] **Step 4: Run to verify it passes**

Run: `python -m pytest tests/test_s2s_peptides.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/main.py backend/tests/test_s2s_peptides.py
git commit -m "feat(s2s): GET /s2s/peptides for the Integration Service peptide registry (HPLC-native M3)" -- backend/main.py backend/tests/test_s2s_peptides.py
```

---

### Task 5: `lims_analyses/hplc_native.py` — slot resolution, titles, row builder

**Files:**
- Create: `backend/lims_analyses/hplc_native.py`
- Test: `backend/tests/test_hplc_native_module.py` (create)

**Interfaces:**
- Consumes: `catalog.hplc_native_seed.HPLC_NATIVE_SERVICES`, `lims_analyses.service.create_analysis(..., peptide_id=, slot=, reportable_reason=)`.
- Produces:
  - constants `KW_IDENTITY="HPLC-IDENTITY"`, `KW_PURITY="HPLC-PURITY"`, `KW_QUANTITY="HPLC-QUANTITY"`, `KW_BLEND_PURITY="HPLC-BLEND-PURITY"`, `KW_BLEND_TOTAL="HPLC-BLEND-TOTAL"`, `TRIO`, `AGGREGATES`, `HPLC_NATIVE_PROFILE_KEY`
  - `is_native_born(parent: LimsSample) -> bool`
  - `@dataclass SlotResolution(slot: int, raw_name: str, display_name: str, peptide_id: int | None, reason: str | None)`
  - `resolve_slot_peptides(db, parent) -> list[SlotResolution]` (empty/placeholder slots skipped)
  - `identity_title(name)`, `purity_title(name)`, `quantity_title(name)`
  - `native_hplc_services(db) -> dict[str, AnalysisService]` (fail-closed: any of the five missing ⇒ `{}` + ERROR log)
  - `seed_native_hplc_rows(db, *, sub_sample, parent, existing_keys: set[tuple[str,int]], existing_service_ids: set[tuple[int,int]], created_by_user_id, commit) -> list[LimsAnalysis]`

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_hplc_native_module.py
"""lims_analyses/hplc_native.py — the native-born HPLC seeding model (spec
2026-09-10, M4): slot→peptide resolution from lims_samples.analytes, stamped
per-row titles, unresolved ⇒ NULL peptide + reason (Handler ruling), blend
aggregates only for N>1."""
import json
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import models  # noqa: F401
from models import AnalysisService, Base, LimsAnalysis, LimsSample, LimsSubSample, Peptide


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _catalog(db):
    from catalog.hplc_native_seed import HPLC_NATIVE_SERVICES
    for kw, title, unit, rtype, vc in HPLC_NATIVE_SERVICES:
        db.add(AnalysisService(title=title, keyword=kw, unit=unit, result_type=rtype,
                               origin="mk1", variance_capable=vc))
    db.flush()


def _peptides(db):
    db.add(Peptide(name="BPC-157", abbreviation="BPC157", hplc_aliases=["BPC"]))
    db.add(Peptide(name="TB-500", abbreviation="TB500", display_aliases=["Thymosin Beta-4"]))
    db.add(Peptide(name="TB-500 (17-23)", abbreviation="TB500-17-23"))
    db.flush()


def _native_parent(db, analytes, sample_id="P-5000"):
    p = LimsSample(sample_id=sample_id, external_lims_system="mk1", sample_type_title="Peptide",
                   analytes=json.dumps(analytes))
    db.add(p); db.flush()
    return p


def _vial(db, parent, seq=1):
    v = LimsSubSample(sample_id=f"{parent.sample_id}-S{seq:02d}", vial_sequence=seq,
                      parent_sample_pk=parent.id, external_lims_uid=f"zz-{parent.sample_id}-{seq}",
                      assignment_role="hplc")
    db.add(v); db.flush()
    return v


def test_constants_match_slice1_catalog():
    from lims_analyses import hplc_native as h
    from catalog.hplc_native_seed import HPLC_NATIVE_SERVICES, HPLC_NATIVE_PROFILE_KEY
    assert h.TRIO == ("HPLC-IDENTITY", "HPLC-PURITY", "HPLC-QUANTITY")
    assert h.AGGREGATES == ("HPLC-BLEND-PURITY", "HPLC-BLEND-TOTAL")
    assert set(h.TRIO + h.AGGREGATES) == {kw for kw, *_ in HPLC_NATIVE_SERVICES}
    assert h.HPLC_NATIVE_PROFILE_KEY == HPLC_NATIVE_PROFILE_KEY


def test_is_native_born(db):
    from lims_analyses.hplc_native import is_native_born
    assert is_native_born(LimsSample(sample_id="a", external_lims_system="mk1"))
    assert not is_native_born(LimsSample(sample_id="b", external_lims_system="senaite"))
    assert not is_native_born(LimsSample(sample_id="c"))   # NULL = legacy default


def test_titles():
    from lims_analyses.hplc_native import identity_title, purity_title, quantity_title
    assert identity_title("BPC-157") == "BPC-157 - Identity (HPLC)"
    assert purity_title("BPC-157") == "BPC-157 - Purity (HPLC)"
    assert quantity_title("BPC-157") == "BPC-157 - Quantity (HPLC)"


def test_resolve_prefers_peptide_id_then_exact_name_then_alias(db):
    from lims_analyses.hplc_native import resolve_slot_peptides
    _peptides(db)
    bpc = db.query(Peptide).filter_by(name="BPC-157").one()
    p = _native_parent(db, [
        {"name": "Whatever - Identity (HPLC)", "declared_quantity": "10", "peptide_id": bpc.id},
        {"name": "TB-500 - Identity (HPLC)", "declared_quantity": None},
        {"name": "bpc - Identity (HPLC)", "declared_quantity": None},
    ])
    res = resolve_slot_peptides(db, p)
    assert [(r.slot, r.peptide_id, r.reason) for r in res] == [
        (1, bpc.id, None), (2, db.query(Peptide).filter_by(name="TB-500").one().id, None), (3, bpc.id, None)]
    assert res[0].display_name == "BPC-157"          # from the peptide row, not the raw label
    assert res[1].raw_name == "TB-500 - Identity (HPLC)"


def test_resolve_marks_unresolved_and_ambiguous_without_guessing(db):
    from lims_analyses.hplc_native import resolve_slot_peptides
    _peptides(db)
    db.add(Peptide(name="Dup", abbreviation="DUP1", hplc_aliases=["SAMEALIAS"]))
    db.add(Peptide(name="Dup Two", abbreviation="DUP2", hplc_aliases=["SAMEALIAS"]))
    db.flush()
    p = _native_parent(db, [
        {"name": "Nonexistent Peptide - Identity (HPLC)", "declared_quantity": None},
        {"name": "SAMEALIAS", "declared_quantity": None},
    ])
    res = resolve_slot_peptides(db, p)
    assert (res[0].peptide_id, res[0].reason, res[0].display_name) == (None, "unresolved", "Nonexistent Peptide")
    assert (res[1].peptide_id, res[1].reason) == (None, "ambiguous")


def test_resolve_skips_middle_placeholder_but_keeps_slot_numbers(db):
    from lims_analyses.hplc_native import resolve_slot_peptides
    _peptides(db)
    p = _native_parent(db, [
        {"name": "BPC-157 - Identity (HPLC)", "declared_quantity": None},
        {"name": None, "declared_quantity": None},
        {"name": "TB-500 - Identity (HPLC)", "declared_quantity": None},
    ])
    assert [r.slot for r in resolve_slot_peptides(db, p)] == [1, 3]


def test_resolve_ignores_inactive_peptides(db):
    from lims_analyses.hplc_native import resolve_slot_peptides
    db.add(Peptide(name="Retired", abbreviation="RET", active=False)); db.flush()
    p = _native_parent(db, [{"name": "Retired - Identity (HPLC)", "declared_quantity": None}])
    assert resolve_slot_peptides(db, p)[0].reason == "unresolved"


def test_native_hplc_services_fail_closed(db, caplog):
    from lims_analyses.hplc_native import native_hplc_services
    assert native_hplc_services(db) == {}
    assert any("hplc_native.catalog_incomplete" in r.message for r in caplog.records)
    _catalog(db)
    assert set(native_hplc_services(db)) == {"HPLC-IDENTITY", "HPLC-PURITY", "HPLC-QUANTITY",
                                            "HPLC-BLEND-PURITY", "HPLC-BLEND-TOTAL"}


def test_seed_single_peptide_three_rows(db):
    from lims_analyses.hplc_native import seed_native_hplc_rows
    _catalog(db); _peptides(db)
    bpc = db.query(Peptide).filter_by(name="BPC-157").one()
    p = _native_parent(db, [{"name": "BPC-157 - Identity (HPLC)", "declared_quantity": "10"}])
    v = _vial(db, p)
    rows = seed_native_hplc_rows(db, sub_sample=v, parent=p, existing_keys=set(),
                                 existing_service_ids=set(), created_by_user_id=None, commit=False)
    got = sorted((r.keyword, r.slot, r.peptide_id, r.title) for r in rows)
    assert got == [
        ("HPLC-IDENTITY", 1, bpc.id, "BPC-157 - Identity (HPLC)"),
        ("HPLC-PURITY", 1, bpc.id, "BPC-157 - Purity (HPLC)"),
        ("HPLC-QUANTITY", 1, bpc.id, "BPC-157 - Quantity (HPLC)"),
    ]
    assert all(r.lims_sub_sample_pk == v.id and r.review_state == "unassigned" for r in rows)


def test_seed_blend_three_per_slot_plus_two_aggregates(db):
    from lims_analyses.hplc_native import seed_native_hplc_rows
    _catalog(db); _peptides(db)
    p = _native_parent(db, [{"name": "BPC-157 - Identity (HPLC)", "declared_quantity": "5"},
                            {"name": "TB-500 - Identity (HPLC)", "declared_quantity": "5"}], sample_id="PB-1000")
    v = _vial(db, p)
    rows = seed_native_hplc_rows(db, sub_sample=v, parent=p, existing_keys=set(),
                                 existing_service_ids=set(), created_by_user_id=None, commit=False)
    assert len(rows) == 8
    agg = [r for r in rows if r.keyword.startswith("HPLC-BLEND-")]
    assert {(r.slot, r.peptide_id, r.title) for r in agg} == {
        (None, None, "HPLC Blend Purity (mass-weighted)"), (None, None, "HPLC Blend Total Quantity")}


def test_seed_unresolved_slot_gets_null_peptide_and_reason(db, caplog):
    from lims_analyses.hplc_native import seed_native_hplc_rows
    _catalog(db); _peptides(db)
    p = _native_parent(db, [{"name": "Mystery - Identity (HPLC)", "declared_quantity": None}])
    v = _vial(db, p)
    rows = seed_native_hplc_rows(db, sub_sample=v, parent=p, existing_keys=set(),
                                 existing_service_ids=set(), created_by_user_id=None, commit=False)
    assert len(rows) == 3
    assert all(r.peptide_id is None and r.reportable_reason == "analyte_unresolved: Mystery - Identity (HPLC)"
               for r in rows)
    assert rows[0].title == "Mystery - Identity (HPLC)"
    assert any("seeder.native_hplc.unresolved_slot" in r.message for r in caplog.records)


def test_seed_is_idempotent_via_slot_aware_keys(db):
    from lims_analyses.hplc_native import seed_native_hplc_rows
    _catalog(db); _peptides(db)
    p = _native_parent(db, [{"name": "BPC-157 - Identity (HPLC)", "declared_quantity": None}])
    v = _vial(db, p)
    keys, ids = set(), set()
    first = seed_native_hplc_rows(db, sub_sample=v, parent=p, existing_keys=keys,
                                  existing_service_ids=ids, created_by_user_id=None, commit=False)
    second = seed_native_hplc_rows(db, sub_sample=v, parent=p, existing_keys=keys,
                                   existing_service_ids=ids, created_by_user_id=None, commit=False)
    assert len(first) == 3 and second == []
    assert ("HPLC-PURITY", 1) in keys


def test_seed_refuses_when_catalog_incomplete(db):
    from lims_analyses.hplc_native import seed_native_hplc_rows
    _peptides(db)
    p = _native_parent(db, [{"name": "BPC-157 - Identity (HPLC)", "declared_quantity": None}])
    v = _vial(db, p)
    assert seed_native_hplc_rows(db, sub_sample=v, parent=p, existing_keys=set(),
                                 existing_service_ids=set(), created_by_user_id=None, commit=False) == []
```

- [ ] **Step 2: Run to verify they fail**

Run: `python -m pytest tests/test_hplc_native_module.py -v`
Expected: `ModuleNotFoundError: lims_analyses.hplc_native`.

- [ ] **Step 3: Write the module**

```python
# backend/lims_analyses/hplc_native.py
"""Native-born HPLC seeding model (spec 2026-09-10-hplc-native-born-design, M4).

A native-born sample (lims_samples.external_lims_system == 'mk1') has no
SENAITE AR to mirror. Its HPLC content is derived from lims_samples.analytes
(the positional slot list) against the GENERIC native trio: one identity /
purity / quantity row per occupied slot, carrying the slot's peptide_id and a
STAMPED per-row title, plus the two blend aggregates when more than one slot
is occupied. The peptide is data on the row — never part of the catalog key —
which is what removes the SENAITE-era title-string joins (P-1500 / P-1611 /
PB-0469 class).

Resolution order per slot: the signal's Analyte{i}PeptideId (written by the
IS once WordPress carries Mk1 ids) → exact fold of the label (identity suffix
stripped) against peptides.name / abbreviation → hplc_aliases / display_aliases.
Zero matches or 2+ distinct matches never guess: the rows are still seeded,
with peptide_id NULL and reportable_reason 'analyte_unresolved|ambiguous: …'
(Handler ruling 2026-09-10) so the bench sees the slot, the prep bridge never
routes a result onto it, and the COA stays blocked until relabel_native_slot
(slice 3) fixes the id.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from catalog.hplc_native_seed import HPLC_NATIVE_PROFILE_KEY, HPLC_NATIVE_SERVICES
from models import AnalysisService, LimsAnalysis, LimsSample, LimsSubSample, Peptide

log = logging.getLogger(__name__)

KW_IDENTITY = "HPLC-IDENTITY"
KW_PURITY = "HPLC-PURITY"
KW_QUANTITY = "HPLC-QUANTITY"
KW_BLEND_PURITY = "HPLC-BLEND-PURITY"
KW_BLEND_TOTAL = "HPLC-BLEND-TOTAL"
TRIO = (KW_IDENTITY, KW_PURITY, KW_QUANTITY)
AGGREGATES = (KW_BLEND_PURITY, KW_BLEND_TOTAL)
assert set(TRIO + AGGREGATES) == {kw for kw, *_ in HPLC_NATIVE_SERVICES}

# Same rule sub_samples/senaite.py uses to strip SENAITE's identity-service
# title form ("BPC-157 - Identity (HPLC)") back to the bare label.
_IDENTITY_SUFFIX_RE = re.compile(r"\s*-\s*identity\s*\(hplc\)\s*$", re.I)


def is_native_born(parent: LimsSample) -> bool:
    return (getattr(parent, "external_lims_system", None) or "senaite") == "mk1"


def strip_identity_suffix(label: str) -> str:
    return _IDENTITY_SUFFIX_RE.sub("", label or "").strip()


def _fold(s: Optional[str]) -> str:
    """Alphanumeric-only, upper-cased — the same fold the HPLC standard-label
    matcher uses (main.py _normalize_label)."""
    return re.sub(r"[^A-Za-z0-9]", "", s or "").upper()


def identity_title(name: str) -> str:
    return f"{name} - Identity (HPLC)"


def purity_title(name: str) -> str:
    return f"{name} - Purity (HPLC)"


def quantity_title(name: str) -> str:
    return f"{name} - Quantity (HPLC)"


@dataclass
class SlotResolution:
    slot: int                 # 1-based position in lims_samples.analytes
    raw_name: str             # label as stored (title form or bare)
    display_name: str         # peptide.name when resolved, else suffix-stripped raw
    peptide_id: Optional[int]
    reason: Optional[str]     # None | "unresolved" | "ambiguous"


def _parse_slots(parent: LimsSample) -> list[dict]:
    try:
        slots = json.loads(parent.analytes) if parent.analytes else []
    except (TypeError, ValueError):
        return []
    return slots if isinstance(slots, list) else []


def resolve_slot_peptides(db: Session, parent: LimsSample) -> list[SlotResolution]:
    """One SlotResolution per OCCUPIED slot (placeholders with name None are
    skipped but keep their neighbours' slot numbers). Only active peptides
    resolve; a retired peptide is 'unresolved' on purpose."""
    peptides = db.execute(select(Peptide).where(Peptide.active.is_(True))).scalars().all()
    by_id = {p.id: p for p in peptides}
    by_exact: dict[str, set[int]] = {}
    by_alias: dict[str, set[int]] = {}
    for p in peptides:
        by_exact.setdefault(_fold(p.name), set()).add(p.id)
        by_exact.setdefault(_fold(p.abbreviation), set()).add(p.id)
        for alias in (p.hplc_aliases or []) + (p.display_aliases or []):
            by_alias.setdefault(_fold(alias), set()).add(p.id)

    out: list[SlotResolution] = []
    for idx, slot in enumerate(_parse_slots(parent), start=1):
        raw = (slot.get("name") or "").strip() if isinstance(slot, dict) else ""
        if not raw:
            continue
        bare = strip_identity_suffix(raw)
        pid = slot.get("peptide_id") if isinstance(slot, dict) else None
        if pid is not None and pid in by_id:
            out.append(SlotResolution(idx, raw, by_id[pid].name, pid, None))
            continue
        hits = by_exact.get(_fold(bare)) or by_alias.get(_fold(bare)) or set()
        if len(hits) == 1:
            p = by_id[next(iter(hits))]
            out.append(SlotResolution(idx, raw, p.name, p.id, None))
        elif not hits:
            out.append(SlotResolution(idx, raw, bare, None, "unresolved"))
        else:
            out.append(SlotResolution(idx, raw, bare, None, "ambiguous"))
    return out


def native_hplc_services(db: Session) -> dict[str, AnalysisService]:
    """The five origin=mk1 services by keyword. Fail-closed: if any is
    missing (seed skipped, collision at boot) return {} and log ERROR so the
    caller seeds nothing rather than a partial trio."""
    rows = db.execute(select(AnalysisService).where(
        AnalysisService.keyword.in_(TRIO + AGGREGATES),
        AnalysisService.origin == "mk1",
    )).scalars().all()
    found = {r.keyword: r for r in rows}
    missing = [kw for kw in TRIO + AGGREGATES if kw not in found]
    if missing:
        log.error("hplc_native.catalog_incomplete missing=%s", missing)
        return {}
    return found


def _title_for(kw: str, name: str) -> str:
    return {KW_IDENTITY: identity_title, KW_PURITY: purity_title, KW_QUANTITY: quantity_title}[kw](name)


def seed_native_hplc_rows(
    db: Session, *, sub_sample: LimsSubSample, parent: LimsSample,
    existing_keys: set, existing_service_ids: set,
    created_by_user_id: Optional[int], commit: bool,
) -> list[LimsAnalysis]:
    """Seed the trio per occupied slot (+ the two aggregates when N>1) on an
    HPLC vial of a native-born parent. Dedupe keys are SLOT-AWARE tuples
    ((keyword, slot or 0) and (service_id, slot or 0)) mirroring the widened
    root indexes; the caller passes the live sets and we add to them."""
    from lims_analyses import service as la_service

    services = native_hplc_services(db)
    if not services:
        return []
    slots = resolve_slot_peptides(db, parent)
    inserted: list[LimsAnalysis] = []

    def _mint(kw: str, *, slot: Optional[int], peptide_id: Optional[int],
              title: str, reason: Optional[str]) -> None:
        svc = services[kw]
        key_kw, key_id = (kw, slot or 0), (svc.id, slot or 0)
        if key_kw in existing_keys or key_id in existing_service_ids:
            return
        row = la_service.create_analysis(
            db, host_kind="sub_sample", host_pk=sub_sample.id,
            analysis_service_id=svc.id, keyword=kw, title=title,
            created_by_user_id=created_by_user_id, commit=commit,
            peptide_id=peptide_id, slot=slot, reportable_reason=reason,
        )
        existing_keys.add(key_kw)
        existing_service_ids.add(key_id)
        inserted.append(row)
        log.info("seeder.native_hplc_seeded sub=%s analysis_id=%s keyword=%s slot=%s peptide_id=%s",
                 sub_sample.sample_id, row.id, kw, slot, peptide_id)

    for res in slots:
        reason = f"analyte_{res.reason}: {res.raw_name}" if res.reason else None
        if res.reason:
            log.warning("seeder.native_hplc.unresolved_slot sub=%s slot=%s raw=%r reason=%s",
                        sub_sample.sample_id, res.slot, res.raw_name, res.reason)
        # Title: the peptide's canonical name when resolved; the raw label as
        # stored (already title-form from the IS) when not — the bench must show
        # what the customer typed, and the relabel action restamps it later.
        for kw in TRIO:
            title = _title_for(kw, res.display_name) if res.peptide_id else (
                res.raw_name if kw == KW_IDENTITY else _title_for(kw, res.display_name))
            _mint(kw, slot=res.slot, peptide_id=res.peptide_id, title=title, reason=reason)

    if len(slots) > 1:
        for kw in AGGREGATES:
            _mint(kw, slot=None, peptide_id=None, title=services[kw].title, reason=None)
    return inserted
```
Note the unresolved identity title: the test expects the raw label (`"Mystery - Identity (HPLC)"`) on the identity row and stamped purity/quantity titles built from the bare name; that is what the code above does.

- [ ] **Step 4: Run to verify they pass**

Run: `python -m pytest tests/test_hplc_native_module.py -v`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/lims_analyses/hplc_native.py backend/tests/test_hplc_native_module.py
git commit -m "feat(lims): hplc_native module — slot resolution, stamped titles, native trio row builder (HPLC-native M4)" -- backend/lims_analyses/hplc_native.py backend/tests/test_hplc_native_module.py
```

---

### Task 6: Seeder fork for native-born parents + slot-aware dedupe

**Files:**
- Modify: `backend/lims_analyses/seeder.py` (`seed_analyses_for_vial` ~656-760: dedupe sets + hplc branch; `_seed_rows_from_services` ~565)
- Modify: `backend/lims_analyses/manage_native.py` (`_seed_members_on_vial` ~210-235)
- Test: `backend/tests/test_hplc_native_seeder.py` (create)

**Interfaces:**
- Consumes: `hplc_native.is_native_born`, `seed_native_hplc_rows`.
- Produces: `seed_analyses_for_vial(role="hplc")` on a native-born parent seeds via `seed_native_hplc_rows` (then riders); SENAITE-born parents keep the mirror path byte-identical. Dedupe sets become `existing_kw: set[tuple[str,int]]`, `existing_service_ids: set[tuple[int,int]]` (slot or 0). `_seed_rows_from_services` and `_seed_rider_members` are updated to the tuple form with `slot=None` (compares as 0) so every legacy caller is unchanged in behaviour.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_hplc_native_seeder.py
"""seed_analyses_for_vial forks on native-born parents (spec 2026-09-10 M4);
SENAITE-born parents still hit mirror_parent_hplc_analyses byte-identically."""
import json
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import models  # noqa: F401
from models import AnalysisService, Base, Department, LimsAnalysis, LimsSample, LimsSubSample, Peptide


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _catalog(db):
    from catalog.hplc_native_seed import HPLC_NATIVE_SERVICES
    dept = Department(name="Analytical"); db.add(dept); db.flush()
    for kw, title, unit, rtype, vc in HPLC_NATIVE_SERVICES:
        db.add(AnalysisService(title=title, keyword=kw, unit=unit, result_type=rtype,
                               origin="mk1", variance_capable=vc, department_id=dept.id))
    db.add(Peptide(name="BPC-157", abbreviation="BPC157"))
    db.add(Peptide(name="TB-500", abbreviation="TB500"))
    db.flush()


def _parent(db, *, system, analytes, sample_id):
    p = LimsSample(sample_id=sample_id, external_lims_system=system, sample_type_title="Peptide",
                   external_lims_uid=None if system == "mk1" else f"uid-{sample_id}",
                   analytes=json.dumps(analytes))
    db.add(p); db.flush()
    return p


def _vial(db, parent, seq=1, role="hplc"):
    v = LimsSubSample(sample_id=f"{parent.sample_id}-S{seq:02d}", vial_sequence=seq,
                      parent_sample_pk=parent.id, external_lims_uid=f"zz-{parent.sample_id}-{seq}",
                      assignment_role=role)
    db.add(v); db.flush()
    return v


WP = {"hplc-purity-identity": True}


def test_native_born_hplc_vial_seeds_trio_not_mirror(db, monkeypatch):
    from lims_analyses import seeder
    _catalog(db)
    called = []
    monkeypatch.setattr(seeder, "mirror_parent_hplc_analyses",
                        lambda *a, **k: called.append(1) or [])
    p = _parent(db, system="mk1", sample_id="P-5000",
                analytes=[{"name": "BPC-157 - Identity (HPLC)", "declared_quantity": "10"}])
    v = _vial(db, p)
    rows = seeder.seed_analyses_for_vial(db, sub_sample=v, role="hplc", wp_services=WP,
                                         parent_sample_id=p.sample_id, commit=False)
    assert called == []
    assert sorted(r.keyword for r in rows) == ["HPLC-IDENTITY", "HPLC-PURITY", "HPLC-QUANTITY"]
    assert {r.slot for r in rows} == {1}


def test_native_born_blend_seeds_per_slot_plus_aggregates(db):
    from lims_analyses import seeder
    _catalog(db)
    p = _parent(db, system="mk1", sample_id="PB-1000",
                analytes=[{"name": "BPC-157 - Identity (HPLC)", "declared_quantity": "5"},
                          {"name": "TB-500 - Identity (HPLC)", "declared_quantity": "5"}])
    v = _vial(db, p)
    rows = seeder.seed_analyses_for_vial(db, sub_sample=v, role="hplc", wp_services=WP,
                                         parent_sample_id=p.sample_id, commit=False)
    assert len(rows) == 8
    assert sorted((r.keyword, r.slot) for r in rows if r.slot) == [
        ("HPLC-IDENTITY", 1), ("HPLC-IDENTITY", 2), ("HPLC-PURITY", 1), ("HPLC-PURITY", 2),
        ("HPLC-QUANTITY", 1), ("HPLC-QUANTITY", 2)]


def test_native_born_seed_is_idempotent_on_rerun(db):
    from lims_analyses import seeder
    _catalog(db)
    p = _parent(db, system="mk1", sample_id="PB-1001",
                analytes=[{"name": "BPC-157 - Identity (HPLC)", "declared_quantity": None},
                          {"name": "TB-500 - Identity (HPLC)", "declared_quantity": None}])
    v = _vial(db, p)
    first = seeder.seed_analyses_for_vial(db, sub_sample=v, role="hplc", wp_services=WP,
                                          parent_sample_id=p.sample_id, commit=False)
    second = seeder.seed_analyses_for_vial(db, sub_sample=v, role="hplc", wp_services=WP,
                                           parent_sample_id=p.sample_id, commit=False)
    assert len(first) == 8 and second == []


def test_senaite_born_parent_still_uses_the_mirror(db, monkeypatch):
    from lims_analyses import seeder
    _catalog(db)
    seen = {}
    def fake_mirror(db_, *, sub_sample, parent_sample_id, existing_kw, existing_service_ids, **k):
        seen["parent"] = parent_sample_id
        seen["kw_type"] = type(next(iter(existing_kw))) if existing_kw else None
        return []
    monkeypatch.setattr(seeder, "mirror_parent_hplc_analyses", fake_mirror)
    p = _parent(db, system="senaite", sample_id="P-0141",
                analytes=[{"name": "BPC-157 - Identity (HPLC)", "declared_quantity": None}])
    v = _vial(db, p)
    seeder.seed_analyses_for_vial(db, sub_sample=v, role="hplc", wp_services={"hplcpurity_identity": True},
                                  parent_sample_id=p.sample_id, commit=False)
    assert seen["parent"] == "P-0141"


def test_native_born_without_parent_sample_id_does_not_raise(db):
    """The legacy mirror raised ValueError without a parent id; a native-born
    parent is resolved from the vial itself."""
    from lims_analyses import seeder
    _catalog(db)
    p = _parent(db, system="mk1", sample_id="P-5002",
                analytes=[{"name": "BPC-157 - Identity (HPLC)", "declared_quantity": None}])
    v = _vial(db, p)
    rows = seeder.seed_analyses_for_vial(db, sub_sample=v, role="hplc", wp_services=WP, commit=False)
    assert len(rows) == 3


def test_legacy_dedupe_still_blocks_same_keyword_reseed(db):
    """Slot-NULL legacy rows compare as slot 0 — a second seed of the same
    keyword is still skipped (byte-identical legacy behaviour)."""
    from lims_analyses.seeder import _seed_rows_from_services
    _catalog(db)
    p = _parent(db, system="senaite", sample_id="P-0142", analytes=[])
    v = _vial(db, p, role="hm")
    svc = db.query(AnalysisService).filter_by(keyword="HPLC-PURITY").one()
    kw, ids = set(), set()
    a = _seed_rows_from_services(db, sub_sample=v, services=[svc], existing_kw=kw, existing_service_ids=ids,
                                 created_by_user_id=None, commit=False, log_event="t")
    b = _seed_rows_from_services(db, sub_sample=v, services=[svc], existing_kw=kw, existing_service_ids=ids,
                                 created_by_user_id=None, commit=False, log_event="t")
    assert len(a) == 1 and b == [] and ("HPLC-PURITY", 0) in kw and (svc.id, 0) in ids
```

- [ ] **Step 2: Run to verify they fail**

Run: `python -m pytest tests/test_hplc_native_seeder.py -v`
Expected: FAIL (mirror is called / raises; dedupe sets are plain strings).

- [ ] **Step 3: Make the dedupe sets slot-aware**

In `backend/lims_analyses/seeder.py` `seed_analyses_for_vial`, replace the `existing` query and set construction (~lines 715-722) with:

```python
    existing = db.execute(
        select(LimsAnalysis.keyword, LimsAnalysis.analysis_service_id, LimsAnalysis.slot).where(
            LimsAnalysis.lims_sub_sample_pk == sub_sample.id,
            LimsAnalysis.review_state.notin_(["rejected", "retracted"]),
        )
    ).all()
    # Slot-aware since HPLC-native slice 1 widened the root indexes to
    # (…, COALESCE(slot, 0)): a blend holds N rows of the SAME generic service
    # on one vial. Legacy rows carry slot NULL and compare as 0 — the tuple
    # form is byte-identical to the old string/int sets for them.
    existing_kw = {(kw, slot or 0) for kw, _sid, slot in existing}
    existing_service_ids = {(sid, slot or 0) for _kw, sid, slot in existing if sid is not None}
```
Update the comment block above it (the "TWO sets because BOTH root indexes are live" paragraph) to mention the slot term.

In `_seed_rows_from_services` change the skip and the adds:
```python
        if (svc.id, 0) in existing_service_ids or (svc.keyword, 0) in existing_kw:
            continue
        ...
        existing_kw.add((svc.keyword, 0))
        existing_service_ids.add((svc.id, 0))
```
`mirror_parent_hplc_analyses` also reads/adds to both sets (grep `existing_kw` / `existing_service_ids` inside it, ~lines 406-560) — convert every membership test and `.add(...)` to the `(x, 0)` tuple form. Same in `backend/lims_analyses/manage_native.py::_seed_members_on_vial` (~lines 218-228): build `existing_kw = {(kw, slot or 0) …}` and `existing_service_ids = {(sid, slot or 0) …}` from a query that also selects `LimsAnalysis.slot`.

Run `grep -rn "existing_kw\|existing_service_ids" backend --include=*.py | grep -v tests` and convert every remaining site (there should be none outside `seeder.py` and `manage_native.py`; if `parent_placeholders.py` or `order_seed.py` show up, report it in the task report rather than guessing).

- [ ] **Step 4: Fork the hplc branch**

Replace the `if role == "hplc":` block in `seed_analyses_for_vial` with:

```python
    # ── HPLC ──────────────────────────────────────────────────────────────────
    if role == "hplc":
        from lims_analyses.hplc_native import is_native_born, seed_native_hplc_rows
        parent = sub_sample.parent_sample if sub_sample.parent_sample_pk else None
        if parent is not None and is_native_born(parent):
            # Native-born (spec 2026-09-10 M4): no SENAITE AR to mirror — the
            # trio per analyte slot comes from lims_samples.analytes.
            inserted = seed_native_hplc_rows(
                db, sub_sample=sub_sample, parent=parent,
                existing_keys=existing_kw, existing_service_ids=existing_service_ids,
                created_by_user_id=created_by_user_id, commit=commit,
            )
        else:
            # SENAITE-born: mirror the parent's Analytics analyte set (unchanged).
            if not parent_sample_id:
                raise ValueError(
                    "seed_analyses_for_vial(role='hplc') requires parent_sample_id"
                )
            inserted = mirror_parent_hplc_analyses(
                db,
                sub_sample=sub_sample,
                parent_sample_id=parent_sample_id,
                existing_kw=existing_kw,
                existing_service_ids=existing_service_ids,
                created_by_user_id=created_by_user_id,
                commit=commit,
            )
        inserted.extend(_seed_rider_members(
            db,
            sub_sample=sub_sample,
            existing_kw=existing_kw,
            existing_service_ids=existing_service_ids,
            created_by_user_id=created_by_user_id,
            commit=commit,
        ))
        return inserted
```
Confirm `LimsSubSample.parent_sample` is the relationship name used by `_seed_rider_members` (`sub_sample.parent_sample.catalog_snapshot`) — it is; reuse it. Update the docstring of `seed_analyses_for_vial` ("HPLC vials mirror the parent's Analytics analyte set" → add the native-born sentence).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `python -m pytest tests/test_hplc_native_seeder.py tests/test_lims_analyses_seeder.py tests/test_seeder_mirror.py tests/test_catalog_seeding.py tests/test_ride_lists.py tests/test_native_manage_analyses.py -v` (if the last file has a different name, run `python -m pytest tests -q -k "manage_native or seed_members"`).
Expected: PASS for all existing seeder/mirror/catalog suites (legacy behaviour unchanged) plus the new file.

- [ ] **Step 6: Commit**

```bash
git add backend/lims_analyses/seeder.py backend/lims_analyses/manage_native.py backend/tests/test_hplc_native_seeder.py
git commit -m "feat(seeder): native-born HPLC vials seed the trio per slot; slot-aware dedupe (HPLC-native M4)" -- backend/lims_analyses/seeder.py backend/lims_analyses/manage_native.py backend/tests/test_hplc_native_seeder.py
```

---

### Task 7: Per-slot parent placeholders for native-born parents

**Files:**
- Modify: `backend/lims_analyses/parent_placeholders.py` (`seed_parent_placeholders`)
- Modify: `backend/lims_analyses/service.py` (`_annotate_profile_sections` ~1243: HPLC- prefix group)
- Test: `backend/tests/test_hplc_native_placeholders.py` (create)

**Interfaces:**
- Consumes: `hplc_native.is_native_born`, `resolve_slot_peptides`, `TRIO`, `AGGREGATES`, title helpers.
- Produces: on a native-born parent whose ordered services include the profile `hplc-purity-identity`, `seed_parent_placeholders` mints one `ordered` row per occupied slot for each trio member (with `slot`, `peptide_id`, stamped `title`) and the two aggregates (slot NULL) when N>1; pre-check filters on `slot` too. Non-native parents: byte-identical (the slot loop never runs; trio rows are minted the old way, slot NULL — the same as today).

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_hplc_native_placeholders.py
"""seed_parent_placeholders on native-born parents mints the trio PER SLOT
(spec 2026-09-10 M4); SENAITE-born parents are unchanged."""
import json
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import models  # noqa: F401
from models import (AnalysisProfile, AnalysisService, Base, LimsAnalysis, LimsSample, Peptide,
                    analysis_profile_members)
from lims_analyses.parent_placeholders import PROVENANCE_ORDERED, seed_parent_placeholders


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _seed(db):
    from catalog.hplc_native_seed import seed_hplc_native_catalog
    seed_hplc_native_catalog(db)
    prof = db.query(AnalysisProfile).filter_by(key="hplc-purity-identity").one()
    prof.active = True
    db.add(Peptide(name="BPC-157", abbreviation="BPC157"))
    db.add(Peptide(name="TB-500", abbreviation="TB500"))
    db.commit()


def _parent(db, *, system, analytes, sample_id):
    p = LimsSample(sample_id=sample_id, external_lims_system=system, sample_type_title="Peptide",
                   analytes=json.dumps(analytes))
    db.add(p); db.commit()
    return p


SERVICES = {"hplc-purity-identity": True}


def _rows(db, parent):
    return db.query(LimsAnalysis).filter_by(lims_sample_pk=parent.id, provenance=PROVENANCE_ORDERED).all()


def test_native_blend_parent_gets_one_placeholder_per_slot_plus_aggregates(db):
    _seed(db)
    p = _parent(db, system="mk1", sample_id="PB-1000",
                analytes=[{"name": "BPC-157 - Identity (HPLC)", "declared_quantity": "5"},
                          {"name": "TB-500 - Identity (HPLC)", "declared_quantity": "5"}])
    stats = seed_parent_placeholders(db, parent=p, services=SERVICES)
    rows = _rows(db, p)
    assert stats["created"] == 8 and len(rows) == 8
    bpc = db.query(Peptide).filter_by(name="BPC-157").one().id
    assert ("HPLC-PURITY", 1, bpc, "BPC-157 - Purity (HPLC)") in {(r.keyword, r.slot, r.peptide_id, r.title) for r in rows}
    assert {r.keyword for r in rows if r.slot is None} == {"HPLC-BLEND-PURITY", "HPLC-BLEND-TOTAL"}


def test_native_single_parent_gets_three_placeholders_no_aggregates(db):
    _seed(db)
    p = _parent(db, system="mk1", sample_id="P-5000",
                analytes=[{"name": "BPC-157 - Identity (HPLC)", "declared_quantity": "10"}])
    seed_parent_placeholders(db, parent=p, services=SERVICES)
    assert sorted((r.keyword, r.slot) for r in _rows(db, p)) == [
        ("HPLC-IDENTITY", 1), ("HPLC-PURITY", 1), ("HPLC-QUANTITY", 1)]


def test_native_placeholders_idempotent_per_slot(db):
    _seed(db)
    p = _parent(db, system="mk1", sample_id="PB-1001",
                analytes=[{"name": "BPC-157 - Identity (HPLC)", "declared_quantity": None},
                          {"name": "TB-500 - Identity (HPLC)", "declared_quantity": None}])
    seed_parent_placeholders(db, parent=p, services=SERVICES)
    again = seed_parent_placeholders(db, parent=p, services=SERVICES)
    assert again["created"] == 0 and again["existing"] == 8 and len(_rows(db, p)) == 8


def test_native_unresolved_slot_placeholder_has_null_peptide_and_reason(db):
    _seed(db)
    p = _parent(db, system="mk1", sample_id="P-5001",
                analytes=[{"name": "Mystery - Identity (HPLC)", "declared_quantity": None}])
    seed_parent_placeholders(db, parent=p, services=SERVICES)
    rows = _rows(db, p)
    assert all(r.peptide_id is None and r.reportable_reason.startswith("analyte_unresolved") for r in rows)


def test_senaite_born_parent_unchanged_slot_null_one_per_service(db):
    """Legacy behaviour: a SENAITE-born parent ordering the native profile
    (only possible after the WP flip in an edge case) still gets one row per
    member with slot NULL — exactly what today's code mints."""
    _seed(db)
    p = _parent(db, system="senaite", sample_id="P-0141",
                analytes=[{"name": "BPC-157 - Identity (HPLC)", "declared_quantity": None},
                          {"name": "TB-500 - Identity (HPLC)", "declared_quantity": None}])
    stats = seed_parent_placeholders(db, parent=p, services=SERVICES)
    rows = _rows(db, p)
    assert stats["created"] == 5 and all(r.slot is None and r.peptide_id is None for r in rows)
```

- [ ] **Step 2: Run to verify they fail**

Run: `python -m pytest tests/test_hplc_native_placeholders.py -v`
Expected: FAIL — native blend gets 5 rows (one per member), no slots.

- [ ] **Step 3: Implement the slot loop**

In `backend/lims_analyses/parent_placeholders.py`, inside `seed_parent_placeholders`, replace the member loop body with a helper call:

```python
    from lims_analyses.hplc_native import (AGGREGATES, TRIO, identity_title, is_native_born,
                                           purity_title, quantity_title, resolve_slot_peptides)

    native_slots = None
    if is_native_born(parent):
        native_slots = resolve_slot_peptides(db, parent)

    def _mint(svc, *, slot, peptide_id, title, reason):
        exists = (
            db.query(LimsAnalysis)
            .filter_by(lims_sample_pk=parent.id, analysis_service_id=svc.id,
                       provenance=PROVENANCE_ORDERED, slot=slot)
            .filter(LimsAnalysis.review_state.notin_(("rejected", "retracted")))
            .first()
        )
        if exists is not None:
            stats["existing"] += 1
            return
        row = LimsAnalysis(
            lims_sample_pk=parent.id, lims_sub_sample_pk=None,
            analysis_service_id=svc.id, keyword=svc.keyword, title=title,
            result_value=None, review_state="unassigned",
            provenance=PROVENANCE_ORDERED, created_by_user_id=created_by_user_id,
            slot=slot, peptide_id=peptide_id, reportable_reason=reason,
        )
        db.add(row)
        db.flush()
        if reason_action:
            record_placeholder_created(db, row, reason=reason_action, user_id=created_by_user_id)
        stats["created"] += 1
        stats["created_ids"].append(row.id)

    for prof in profiles:
        for svc in prof.analysis_services:
            if (getattr(svc, "origin", None) or "") != "mk1":
                stats["skipped"] += 1
                continue
            if native_slots is not None and svc.keyword in TRIO:
                titler = {"HPLC-IDENTITY": identity_title, "HPLC-PURITY": purity_title,
                          "HPLC-QUANTITY": quantity_title}[svc.keyword]
                for res in native_slots:
                    reason = f"analyte_{res.reason}: {res.raw_name}" if res.reason else None
                    title = (titler(res.display_name) if res.peptide_id
                             else (res.raw_name if svc.keyword == "HPLC-IDENTITY" else titler(res.display_name)))
                    _mint(svc, slot=res.slot, peptide_id=res.peptide_id, title=title, reason=reason)
                continue
            if native_slots is not None and svc.keyword in AGGREGATES and len(native_slots) < 2:
                stats["skipped"] += 1
                continue
            _mint(svc, slot=None, peptide_id=None, title=svc.title, reason=None)
    return stats
```
Rename the function's existing `reason` parameter usage: the manage-analyses "why it exists" string is `reason` today; to avoid clashing with the per-row unresolved reason, bind it as `reason_action = reason` at the top of the function (the public signature is unchanged). Note `filter_by(slot=slot)` with `slot=None` produces `slot IS NULL` in SQLAlchemy — verify with the SENAITE-born test (5 rows, idempotent).

In `backend/lims_analyses/service.py` `_annotate_profile_sections` (~1243), add the native profile's prefix so the parent card groups the rows: find the mapping of profile key → keyword prefixes and add `"hplc-purity-identity": ("HPLC-",)` in the same shape as the existing entries (read the function first; if it derives sections from profile membership rather than a literal map, no change is needed — say so in the report).

- [ ] **Step 4: Run to verify they pass**

Run: `python -m pytest tests/test_hplc_native_placeholders.py tests/test_parent_placeholders.py tests/test_order_upsert_placeholders.py -v` (use `-k placeholder` if the last name differs).
Expected: PASS, existing placeholder suites unchanged.

- [ ] **Step 5: Commit**

```bash
git add backend/lims_analyses/parent_placeholders.py backend/lims_analyses/service.py backend/tests/test_hplc_native_placeholders.py
git commit -m "feat(lims): per-slot parent placeholders for native-born HPLC parents (HPLC-native M4)" -- backend/lims_analyses/parent_placeholders.py backend/lims_analyses/service.py backend/tests/test_hplc_native_placeholders.py
```

---

### Task 8: Full-suite gate, CHANGELOG

**Files:**
- Modify: `CHANGELOG.md` (Unreleased → Added)

- [ ] **Step 1: Baseline on the slice-1 head**

```bash
git worktree add C:/tmp/Accu-Mk1-slice1-baseline feat/hplc-native-slice1
cd C:/tmp/Accu-Mk1-slice1-baseline/backend && python -m pytest -q -p no:cacheprovider 2>&1 | grep -E "^(FAILED|ERROR) tests/" | sort -u > C:/tmp/mk1-slice1-baseline-failures.txt
```

- [ ] **Step 2: Branch run + diff**

```bash
cd <slice2 worktree>/backend && python -m pytest -q -p no:cacheprovider 2>&1 | grep -E "^(FAILED|ERROR) tests/" | sort -u > C:/tmp/mk1-slice2-failures.txt
diff C:/tmp/mk1-slice1-baseline-failures.txt C:/tmp/mk1-slice2-failures.txt
```
Expected: empty, except the deliberately deleted `test_native_row_later_attached_to_senaite_keeps_uid` disappearing from the baseline side (not a failure line, so it does not show). Any new failure: fix or report BLOCKED with the traceback; "stale test" is not a valid classification for a test this slice's own changes broke unless the spec ruling says the contract changed (only the adoption guard qualifies, and its test was deleted in Task 2).

- [ ] **Step 3: CHANGELOG**

```markdown
### Added
- HPLC-native slice 2 (spec `docs/superpowers/specs/2026-09-10-hplc-native-born-design.md`, M3+M4): a registry signal with no SENAITE id now mints a customer-facing `P-`/`PB-` sample from counters seeded at 5000/1000 (guarded boot migration) and never adopts a later SENAITE uid (identity collision → quarantine); `POST /s2s/lims-samples` honors `Idempotency-Key`; `GET /s2s/peptides` ships the Mk1 peptide list to the Integration Service; `Analyte{i}PeptideId` on the signal lands in `lims_samples.analytes`; HPLC vials of native-born parents seed the generic native trio per analyte slot (unresolved names ⇒ `peptide_id NULL` + `analyte_unresolved` reason, never a guess) with the two blend aggregates for blends; parent placeholders are minted per slot. SENAITE-born samples are untouched.
```

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): HPLC-native slice 2" -- CHANGELOG.md
```
Push and PR (`feat/hplc-native-slice2` → `feat/hplc-native-slice1`, or → `master` once #192 merges) are the controller's finish step.

- [ ] **Step 5: Stack smoke (after merge; requires the IS-3 slice to send a sample_id-less signal — until then, exercise via a direct S2S call)**

On `priority` (Mk1 mounted at the slice-2 worktree, boot migrations applied): `POST /s2s/lims-samples` with the token, `{"sample_id": null, "senaite_uid": null, "meta": {"SampleTypeTitle": "Peptide Blend", "Analyte1Peptide": "BPC-157 - Identity (HPLC)", "Analyte2Peptide": "TB-500 - Identity (HPLC)", "ClientOrderNumber": "WP-TEST", "review_state": "sample_due"}}` with `Idempotency-Key: registry-test-1` twice → same `PB-1000` both times; then seed placeholders via the order-upsert path or `heal_missing_placeholders.py` → 8 `ordered` rows; receive the sample with one HPLC vial → 8 vial rows with slots; `GET /s2s/peptides` → 200 with ids.

---

## Self-review notes
- Spec coverage: M3 = Tasks 1–4 (customer ids + seed, intake + adoption guard + `Analyte{i}PeptideId`, idempotent signal, `/s2s/peptides`); M4 = Tasks 5–7 (module, seeder fork + slot-aware dedupe, per-slot placeholders). `RetestOfSampleId`/`AutoCheckin` meta consumption is deferred to the M8 (native retest check-in) plan by design; `_annotate_profile_sections` is covered in Task 7.
- Type consistency: `SlotResolution` fields (`slot`, `raw_name`, `display_name`, `peptide_id`, `reason`) are used identically in Tasks 5 and 7; dedupe sets are `(str|int, int)` tuples in Tasks 5–6; `create_analysis` kwargs match slice 1.
- No placeholders: every step has its code; the three "read the file first" notes are for confirming a name, with the fallback stated.

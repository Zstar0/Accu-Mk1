# Native-ID Mirror Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `native_id` mirror the SENAITE sample id for SENAITE-linked samples (`P-1234` → `aP-1234`), demote the per-prefix counter to SENAITE-free lines only, and have the backfill retro-mint every historical row + seed the counters — replacing slice-1's blind-counter minting before the prod backfill runs.

**Architecture:** `mint_native_id` branches: SENAITE-linked → deterministic whole-id mirror (`"a" + <senaite id>`, no counter draw, no DB write); SENAITE-free → the existing per-prefix `SELECT … FOR UPDATE` counter. A new `seed_native_id_counters(db)` implements collision strategy (a). The one-time backfill script retro-mints `native_id` (mirror-derived) for every row it touches, then seeds the counters on a complete sweep. Backend-only; dormant/additive; the behavior change is authorized by the 2026-07-07 spec revision (551e1e3).

**Tech Stack:** Python, SQLAlchemy 2.x, pytest. Tests run in the `canonical-basic-info-test` docker container.

## Global Constraints

- **Native-ID format — SENAITE-linked:** `native_id = "a" + <full SENAITE sample_id>`, whole id including retests: `P-1234` → `aP-1234`, `PB-0216-R01` → `aPB-0216-R01`. Deterministic, NO counter draw, NO DB write.
- **Native-ID format — SENAITE-free** (no `senaite_sample_id`, `sample_type_title` only): counter `a{PREFIX}-{NNNN}`, zero-padded to 4, growing past 9999; prefix from `_SAMPLE_TYPE_PREFIXES` (`peptide→aP`, `peptide blend→aPB`, `bacteriostatic water→aBW`), fallback `aS`. Allocation under `SELECT … FOR UPDATE` on the prefix row.
- **`-S\d+` secondaries are never minted** — callers exclude them upstream (unchanged); do not add handling.
- **Minted once per row, never re-minted** — every mint site gates on `native_id IS NULL`. `native_id` `UNIQUE` is the loud backstop.
- **Counter seed (collision strategy a):** after a COMPLETE backfill sweep, seed each prefix `next_value = max(mirrored number) + 1`. Strip the `-R\d+` retest suffix before parsing the number. Compute maxima from a **DB aggregate over `lims_samples`**, never from a run's in-memory stats. Re-run-safe: never regress an already-advanced counter. Skip on `--dry-run` and `--limit` (partial sweeps).
- **Additive / dormant:** nothing is deployed. Rewriting `test_native_id.py` / `test_registry_signal.py` mint assertions is authorized — the spec revision is the sign-off, not test-bending.
- **Run tests:** `docker exec canonical-basic-info-test python -m pytest tests/<file> -q` (container mounts the worktree `backend/` at `/app`).

---

### Task 1: Mirror minting in `mint_native_id`

**Files:**
- Modify: `backend/sub_samples/native_id.py` (rewrite `mint_native_id`; drop dead `_derive_prefix`)
- Test: `backend/tests/test_native_id.py` (rewrite mint tests)
- Test: `backend/tests/test_registry_signal.py` (update the two mint-value assertions + the schema-fixture literal)

**Interfaces:**
- Produces: `mint_native_id(db, senaite_sample_id=None, sample_type_title=None) -> str` — signature unchanged; behavior: mirror when `senaite_sample_id` given, else counter. Consumed unchanged by `sub_samples/service.py` (both call sites already pass the SENAITE id or `None`) and by Task 3's backfill.

- [ ] **Step 1: Rewrite the mint tests (failing)**

Replace the entire body of `backend/tests/test_native_id.py` with:

```python
"""Native-ID minting: SENAITE-number mirror + SENAITE-free counter."""
import pytest
from sqlalchemy import create_engine, select
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


def test_senaite_linked_mirrors_the_whole_id(db):
    assert mint_native_id(db, senaite_sample_id="P-1234") == "aP-1234"
    assert mint_native_id(db, senaite_sample_id="PB-0007") == "aPB-0007"
    assert mint_native_id(db, senaite_sample_id="BW-0013") == "aBW-0013"


def test_mirror_includes_retest_suffix(db):
    assert mint_native_id(db, senaite_sample_id="PB-0216-R01") == "aPB-0216-R01"


def test_mirror_draws_no_counter(db):
    """The mirror path must never touch lims_native_id_sequences — it is
    deterministic. A counter row appearing would mean a wasted sequence value
    and a drift risk at SENAITE retirement."""
    mint_native_id(db, senaite_sample_id="P-1234")
    mint_native_id(db, senaite_sample_id="P-5678")
    assert db.execute(select(LimsNativeIdSequence)).scalars().all() == []


def test_mirror_is_pure_same_in_same_out(db):
    assert mint_native_id(db, senaite_sample_id="P-0001") == "aP-0001"
    assert mint_native_id(db, senaite_sample_id="P-0001") == "aP-0001"


def test_senaite_free_uses_sample_type_map(db):
    assert mint_native_id(db, sample_type_title="Peptide") == "aP-0001"
    assert mint_native_id(db, sample_type_title="Peptide Blend") == "aPB-0001"
    assert mint_native_id(db, sample_type_title="Bacteriostatic Water") == "aBW-0001"
    # unknown type falls back to the generic prefix
    assert mint_native_id(db, sample_type_title="Mystery Goo") == "aS-0001"


def test_senaite_free_counter_is_per_prefix_and_monotonic(db):
    assert mint_native_id(db, sample_type_title="Peptide") == "aP-0001"
    assert mint_native_id(db, sample_type_title="Peptide") == "aP-0002"
    assert mint_native_id(db, sample_type_title="Peptide Blend") == "aPB-0001"
    assert mint_native_id(db, sample_type_title="Peptide") == "aP-0003"


def test_senaite_free_counter_grows_past_9999(db):
    db.add(LimsNativeIdSequence(prefix="aP", next_value=10000))
    db.commit()
    assert mint_native_id(db, sample_type_title="Peptide") == "aP-10000"


def test_requires_some_identity_source(db):
    with pytest.raises(ValueError):
        mint_native_id(db)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `docker exec canonical-basic-info-test python -m pytest tests/test_native_id.py -q`
Expected: FAIL — `test_senaite_linked_mirrors_the_whole_id` gets `aP-0001` (old blind counter) not `aP-1234`; `test_mirror_draws_no_counter` finds a sequence row.

- [ ] **Step 3: Rewrite `mint_native_id`**

Replace the entire body of `backend/sub_samples/native_id.py` with:

```python
"""Mk1-native sample IDs.

Internal-only in the dual-write program: customers keep seeing SENAITE ids
until a testing line goes SENAITE-free (2026-07-06 spec, decision 3;
native-ID minting revised 2026-07-07 to mirror the SENAITE number).

SENAITE-linked samples MIRROR the SENAITE id: native_id = "a" + <full SENAITE
sample id>, retests included (P-1234 -> aP-1234, PB-0216-R01 -> aPB-0216-R01).
Deterministic, no counter draw, unique because SENAITE ids are unique.

SENAITE-free samples (future native-only lines) draw a per-prefix counter:
a{PREFIX}-{NNNN} zero-padded to 4, prefix from a sample-type map (fallback aS).
Allocation locks the prefix row (SELECT ... FOR UPDATE) -- the same concurrency
idiom as vial_sequence assignment. sqlite (tests) treats the lock as a no-op.

-S\\d+ secondaries are sub-samples, not parents -- never minted (callers
exclude them upstream).
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


def mint_native_id(db: Session,
                   senaite_sample_id: Optional[str] = None,
                   sample_type_title: Optional[str] = None) -> str:
    """Mint the internal native id for a sample.

    SENAITE-linked (senaite_sample_id given): mirror the whole id -- "a" + id.
    No counter draw, no DB write, deterministic, idempotent.

    SENAITE-free (senaite_sample_id absent): draw the per-prefix counter,
    prefix derived from sample_type_title.
    """
    if senaite_sample_id:
        return "a" + senaite_sample_id

    if not sample_type_title:
        raise ValueError(
            "mint_native_id needs a senaite_sample_id or sample_type_title"
        )
    prefix = _SAMPLE_TYPE_PREFIXES.get(
        sample_type_title.strip().lower(), _GENERIC_PREFIX
    )
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

- [ ] **Step 4: Run the mint tests to verify they pass**

Run: `docker exec canonical-basic-info-test python -m pytest tests/test_native_id.py -q`
Expected: PASS (8 tests).

- [ ] **Step 5: Update the signal-test mint assertions**

In `backend/tests/test_registry_signal.py`, the mirror now derives `native_id` from the sample id. Make these edits:

- Line ~40: `native_id="aP-0001",` → `native_id="aP-0134",` (fixture row is `sample_id="P-0134"` — keep the literal self-consistent)
- Line ~46: `assert got.native_id == "aP-0001"` → `assert got.native_id == "aP-0134"`
- Line ~82 (in `test_signal_creates_row_and_mints_native_id`, row is `P-2001`): `assert row.native_id == "aP-0001"` → `assert row.native_id == "aP-2001"`
- Line ~95 (in `test_signal_is_idempotent_and_never_reminets`): `assert r2.native_id == "aP-0001"          # minted once` → `assert r2.native_id == "aP-2001"          # minted once`

Do NOT touch the SENAITE-free tests (`test_signal_senaite_free_form`, `test_senaite_free_retry_*`) — they exercise the counter path and their `aP-0001` values are still correct.

- [ ] **Step 6: Run the signal tests to verify they pass**

Run: `docker exec canonical-basic-info-test python -m pytest tests/test_registry_signal.py -q`
Expected: PASS (all).

- [ ] **Step 7: Commit**

```bash
git add backend/sub_samples/native_id.py backend/tests/test_native_id.py backend/tests/test_registry_signal.py
git commit -m "feat(native-id): mirror the SENAITE number for linked samples"
```

---

### Task 2: `seed_native_id_counters` — collision strategy (a)

**Files:**
- Modify: `backend/sub_samples/native_id.py` (add `seed_native_id_counters`)
- Test: `backend/tests/test_native_id.py` (append seed tests)

**Interfaces:**
- Consumes: `mint_native_id` from Task 1 (indirectly — seeds parse mirror-format ids).
- Produces: `seed_native_id_counters(db: Session) -> int` — reads all non-null `LimsSample.native_id`, groups by prefix, sets each prefix counter `next_value = max(number)+1` (never regressing), returns the count of prefixes seeded/advanced. Consumed by Task 3's backfill.

- [ ] **Step 1: Append the seed tests (failing)**

Append to `backend/tests/test_native_id.py`:

```python
from sub_samples.native_id import seed_native_id_counters
from models import LimsSample


def _sample(sid, nid):
    return LimsSample(sample_id=sid, native_id=nid)


def test_seed_sets_counter_past_max_per_prefix(db):
    db.add_all([_sample("P-0007", "aP-0007"), _sample("P-0003", "aP-0003"),
                _sample("PB-0100", "aPB-0100")])
    db.commit()
    seed_native_id_counters(db)
    db.commit()
    assert db.get(LimsNativeIdSequence, "aP").next_value == 8
    assert db.get(LimsNativeIdSequence, "aPB").next_value == 101


def test_seed_strips_retest_suffix_before_parsing(db):
    db.add_all([_sample("PB-0216-R01", "aPB-0216-R01"), _sample("PB-0100", "aPB-0100")])
    db.commit()
    seed_native_id_counters(db)
    db.commit()
    # base number 216 (retest suffix ignored) wins over 100
    assert db.get(LimsNativeIdSequence, "aPB").next_value == 217


def test_seed_never_regresses_an_advanced_counter(db):
    db.add(_sample("P-0002", "aP-0002"))
    db.add(LimsNativeIdSequence(prefix="aP", next_value=500))
    db.commit()
    seed_native_id_counters(db)
    db.commit()
    assert db.get(LimsNativeIdSequence, "aP").next_value == 500  # not regressed to 3


def test_seed_is_rerun_safe(db):
    db.add(_sample("P-0007", "aP-0007"))
    db.commit()
    seed_native_id_counters(db)
    db.commit()
    seed_native_id_counters(db)
    db.commit()
    assert db.get(LimsNativeIdSequence, "aP").next_value == 8  # stable across runs


def test_seed_ignores_rows_without_native_id(db):
    db.add_all([_sample("P-0007", "aP-0007"), LimsSample(sample_id="P-9999")])
    db.commit()
    seed_native_id_counters(db)
    db.commit()
    assert db.get(LimsNativeIdSequence, "aP").next_value == 8


def test_seed_returns_prefix_count(db):
    db.add_all([_sample("P-0007", "aP-0007"), _sample("PB-0100", "aPB-0100")])
    db.commit()
    assert seed_native_id_counters(db) == 2
```

- [ ] **Step 2: Run the seed tests to verify they fail**

Run: `docker exec canonical-basic-info-test python -m pytest tests/test_native_id.py -k seed -q`
Expected: FAIL — `ImportError: cannot import name 'seed_native_id_counters'`.

- [ ] **Step 3: Implement `seed_native_id_counters`**

In `backend/sub_samples/native_id.py`: add `import re` under the existing imports, add `LimsSample` to the models import (making it `from models import LimsNativeIdSequence, LimsSample`), add the module-level regex under `_PAD`:

```python
# native_id -> (prefix, base number); the -R\d+ retest suffix is intentionally
# not captured so aPB-0216-R01 seeds from 216, not a parse failure.
_MIRRORED_NUM = re.compile(r"^(a[A-Za-z]+)-(\d+)")
```

then append this function to the end of the module:

```python
def seed_native_id_counters(db: Session) -> int:
    """Collision strategy (a): after a COMPLETE retro-mint sweep, seed each
    prefix's counter to max(native number) + 1, so the SENAITE-free counter
    cannot collide with an existing mirrored id once it takes over a prefix at
    SENAITE retirement.

    Idempotent / re-run-safe: never regresses an already-advanced counter.
    Computes maxima from a DB aggregate over lims_samples (not a run's
    in-memory stats), so a --limit / resumed sweep can never seed from partial
    data. The -R\\d+ retest suffix is stripped before parsing the number.
    Returns the number of prefixes seeded or advanced.
    """
    maxes: dict[str, int] = {}
    for nid in db.execute(
        select(LimsSample.native_id).where(LimsSample.native_id.is_not(None))
    ).scalars():
        m = _MIRRORED_NUM.match(nid)
        if not m:
            continue
        prefix, num = m.group(1), int(m.group(2))
        if num > maxes.get(prefix, 0):
            maxes[prefix] = num

    seeded = 0
    for prefix, mx in maxes.items():
        target = mx + 1
        seq = db.execute(
            select(LimsNativeIdSequence)
            .where(LimsNativeIdSequence.prefix == prefix)
            .with_for_update()
        ).scalar_one_or_none()
        if seq is None:
            db.add(LimsNativeIdSequence(prefix=prefix, next_value=target))
            seeded += 1
        elif seq.next_value < target:
            seq.next_value = target
            seeded += 1
    db.flush()
    return seeded
```

- [ ] **Step 4: Run the seed tests to verify they pass**

Run: `docker exec canonical-basic-info-test python -m pytest tests/test_native_id.py -q`
Expected: PASS (14 tests — 8 mint + 6 seed).

- [ ] **Step 5: Commit**

```bash
git add backend/sub_samples/native_id.py backend/tests/test_native_id.py
git commit -m "feat(native-id): seed per-prefix counters past max (collision strategy a)"
```

---

### Task 3: Backfill retro-mints native_id + seeds counters

**Files:**
- Modify: `backend/scripts/backfill_lims_sample_basic_info.py`
- Test: `backend/tests/test_backfill_basic_info.py`

**Interfaces:**
- Consumes: `mint_native_id`, `seed_native_id_counters` from Tasks 1–2.
- Produces: the backfill sets `row.native_id = "a" + sample_id` for every parent row it touches (gated on `native_id IS NULL`), tracked in `stats["native_minted"]`; on a complete sweep (`not dry_run and limit is None`) it calls `seed_native_id_counters`, tracked in `stats["counters_seeded"]`.

- [ ] **Step 1: Add the backfill tests (failing)**

In `backend/tests/test_backfill_basic_info.py`, add `LimsNativeIdSequence` to the models import (`from models import LimsSample, LimsNativeIdSequence`), then append:

```python
def test_backfill_retro_mints_native_id(db_factory, tmp_path):
    stats, _, _ = _run(db_factory, [("P-0001", 0), ("PB-0042", 0)], tmp_path=tmp_path)
    assert stats["native_minted"] == 2
    db = db_factory()
    assert db.query(LimsSample).filter_by(sample_id="P-0001").one().native_id == "aP-0001"
    assert db.query(LimsSample).filter_by(sample_id="PB-0042").one().native_id == "aPB-0042"
    db.close()


def test_backfill_does_not_remint_existing_native_id(db_factory, tmp_path):
    db = db_factory()
    db.add(LimsSample(sample_id="P-0001", native_id="aP-OLD"))
    db.commit(); db.close()
    stats, _, _ = _run(db_factory, [("P-0001", 0)], tmp_path=tmp_path)
    assert stats["native_minted"] == 0
    db = db_factory()
    assert db.query(LimsSample).filter_by(sample_id="P-0001").one().native_id == "aP-OLD"
    db.close()


def test_backfill_seeds_counters_on_complete_sweep(db_factory, tmp_path):
    stats, _, _ = _run(db_factory, [("P-0007", 0), ("PB-0100", 0)], tmp_path=tmp_path)
    assert stats["counters_seeded"] == 2
    db = db_factory()
    assert db.get(LimsNativeIdSequence, "aP").next_value == 8
    assert db.get(LimsNativeIdSequence, "aPB").next_value == 101
    db.close()


def test_backfill_limit_run_does_not_seed_counters(db_factory, tmp_path):
    _run(db_factory, [("P-0007", 0), ("P-0008", 0)], tmp_path=tmp_path, limit=1)
    db = db_factory()
    assert db.query(LimsNativeIdSequence).count() == 0   # partial sweep: no seed
    db.close()


def test_backfill_dry_run_does_not_seed_counters(db_factory, tmp_path):
    with patch("scripts.backfill_lims_sample_basic_info.senaite") as sen, \
         patch("scripts.backfill_lims_sample_basic_info.time.sleep"):
        sen.iter_all_sample_ids.return_value = iter([("P-0007", 0)])
        sen.fetch_parent_metadata.return_value = _full_meta("P-0007")
        backfill(db_factory, sleep_s=0, batch_size=50,
                 checkpoint_path=str(tmp_path / "c.json"), dry_run=True, limit=None)
    db = db_factory()
    assert db.query(LimsNativeIdSequence).count() == 0
    db.close()
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `docker exec canonical-basic-info-test python -m pytest tests/test_backfill_basic_info.py -k "native or seed or counter" -q`
Expected: FAIL — `KeyError: 'native_minted'` / `KeyError: 'counters_seeded'` and no minted native_id.

- [ ] **Step 3: Wire retro-mint + seed into the backfill**

In `backend/scripts/backfill_lims_sample_basic_info.py`:

(a) Extend the import on line ~49 to add the native-id helpers:

```python
from sub_samples.service import _create_sample_row, _populate_basic_info
from sub_samples.native_id import mint_native_id, seed_native_id_counters
```

(b) In `backfill()`, extend the stats dict (line ~85):

```python
    stats = {"seen": 0, "created": 0, "updated": 0,
             "skipped_secondary": 0, "errors": 0,
             "native_minted": 0, "counters_seeded": 0}
```

(c) Replace the create/update block (lines ~110-116) so it captures the row and retro-mints:

```python
                    if row is None:
                        row = _create_sample_row(db, sample_id, meta)
                        stats["created"] += 1
                    else:
                        _populate_basic_info(row, meta)
                        stats["updated"] += 1
                    if row.native_id is None:
                        row.native_id = mint_native_id(db, senaite_sample_id=sample_id)
                        stats["native_minted"] += 1
                    db.commit()
```

(d) After the enumeration loop, before `log.info("backfill done: %s", stats)` (line ~127), seed the counters on a complete sweep only:

```python
    if not dry_run and limit is None:
        db = db_factory()
        try:
            stats["counters_seeded"] = seed_native_id_counters(db)
            db.commit()
        finally:
            db.close()
```

- [ ] **Step 4: Run the full backfill suite to verify green (no regressions)**

Run: `docker exec canonical-basic-info-test python -m pytest tests/test_backfill_basic_info.py -q`
Expected: PASS (all — the 5 new tests plus the pre-existing ones, including `test_backfill_dry_run_writes_nothing`, `test_backfill_respects_limit`, `test_main_prints_stats_json`).

- [ ] **Step 5: Commit**

```bash
git add backend/scripts/backfill_lims_sample_basic_info.py backend/tests/test_backfill_basic_info.py
git commit -m "feat(backfill): retro-mint mirrored native_id + seed counters on complete sweep"
```

---

### Task 4: Correct the spec's collision-safety wording

**Files:**
- Modify: `docs/superpowers/specs/2026-07-06-registry-dual-write-program-design.md` (the "Collision strategy (a)" bullet, ~line 80)

**Interfaces:** none (documentation). This corrects a factual error flagged during planning: the shipped `_SAMPLE_TYPE_PREFIXES` maps the SENAITE-free counter to `aP/aPB/aBW` — the SAME prefixes SENAITE mirrors — so the "one issuer per prefix / prefixes SENAITE never touches" claim is false. Safety actually rests on `UNIQUE` + re-seed-at-cutover.

- [ ] **Step 1: Replace the collision-strategy bullet**

Find the bullet beginning `- **Collision strategy (a) — seed the counter past SENAITE.**` and replace that entire bullet with:

```markdown
- **Collision strategy (a) — seed the counter past SENAITE.** After the backfill, seed each prefix's `next_value` to `max(mirrored SENAITE number for that prefix) + 1`. Note the sample-type map deliberately reuses `aP/aPB/aBW` — the same prefixes SENAITE mirrors — so the counter and the mirror are **not** disjoint by prefix; safety does NOT rest on a one-issuer-per-prefix invariant (an earlier draft claimed this; it was false). During the dual-write transition the counter simply never *draws* those prefixes in practice: every sample originates from a SENAITE AR and is mirror-minted, so no SENAITE-free line requests `aP/aPB/aBW`. The real backstops are (1) `native_id`'s `UNIQUE` constraint — any accidental overlap raises IntegrityError (loud), never a silent duplicate, and the counter path retries-and-bumps on conflict; and (2) **re-seeding the counter at each per-type cutover** — when a line's type goes SENAITE-free and SENAITE stops issuing that prefix, re-seed the counter to `max(existing native number for that prefix) + 1` at that moment, because the backfill-time seed is a stale snapshot the instant SENAITE issues the next id. The seed only becomes load-bearing at that cutover.
```

- [ ] **Step 2: Verify the surrounding sections still read consistently**

Read the "Native-ID minting" section (~lines 73-82) and the "Backfill re-sweep" section (~line 112). Confirm no other sentence still asserts prefix-disjointness as the safety mechanism. (Line ~35's summary — "seeded past each prefix's max SENAITE number after backfill (collision strategy (a); native_id UNIQUE is the backstop)" — is already accurate; leave it.)

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-07-06-registry-dual-write-program-design.md
git commit -m "docs(spec): correct collision-safety rationale (UNIQUE + re-seed, not disjoint prefixes)"
```

---

## Self-Review

**Spec coverage:**
- Mirror for SENAITE-linked (spec §Native-ID minting, bullet 1) → Task 1.
- Counter for SENAITE-free (bullet 2) → preserved in Task 1, tested.
- Retro-mint at backfill (bullet 3) → Task 3.
- Collision strategy (a) seed (bullet 4) → Task 2 (function) + Task 3 (wiring).
- Spec's false safety claim → Task 4 (the planning correction).
- `mint once / never re-mint` → gated in Task 1 (mint is pure) + Task 3 (`native_id IS NULL`), tested `test_backfill_does_not_remint_existing_native_id`.

**Placeholder scan:** every code step contains complete code; no TBD/TODO. Test commands have exact expected outcomes.

**Type consistency:** `mint_native_id(db, senaite_sample_id, sample_type_title) -> str` unchanged across Tasks 1/3. `seed_native_id_counters(db) -> int` consistent Task 2/3. `stats` keys `native_minted` / `counters_seeded` consistent Task 3 impl + tests.

**Not covered (out of scope, intentional):** `service.py` needs no change (the mint branch lives in `mint_native_id`; both call sites already pass the SENAITE id or `None`). `String(20)` length: `"a" + "PB-0216-R01"` = 12 chars; Postgres raises loudly on any overflow — no silent truncation added.

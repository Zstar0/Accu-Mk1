"""Perf finding #1 — batch entity-context resolution in the list endpoints.

Two guarantees are load-bearing here:

1. **Equality.** `seams.resolve_contexts` (batch) and the route-level
   `_with_entities` must return output byte-identical to the per-id
   `resolve_context` / `_with_entity` path — same stamped dict shape, same
   None/absent semantics, same input order — for a mixed set (sample-anchored
   by pk AND by human Sample ID, sub_sample-anchored, worksheet, virtual-kind,
   general-task, and missing/deleted entities).

2. **Bounded query count.** Resolving N same-type flags must cost a CONSTANT
   number of queries, not ~3N. The identity map would mask this if we measured
   warm, so the query-count harness goes cold: seed + commit, `expunge_all`,
   re-attach ONLY the flag rows (entities stay cold, as in a real request),
   THEN attach the counter.
"""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker


def _new_engine():
    from database import Base
    import models  # noqa: F401 — register the LIMS tables on Base.metadata
    import flags.models  # noqa: F401 — register the flag tables
    eng = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(eng)
    return eng


@pytest.fixture
def db():
    s = sessionmaker(bind=_new_engine())()
    try:
        yield s
    finally:
        s.close()


class _QueryCounter:
    """Counts SQL statements executed on an engine within the `with` block."""

    def __init__(self, engine):
        self.engine = engine
        self.count = 0
        self.statements: list[str] = []

    def _on(self, conn, cursor, statement, parameters, context, executemany):
        self.count += 1
        self.statements.append(statement)

    def __enter__(self):
        event.listen(self.engine, "before_cursor_execute", self._on)
        return self

    def __exit__(self, *exc):
        event.remove(self.engine, "before_cursor_execute", self._on)
        return False


def _seed(db, *, n_vials=5, n_flags=None):
    """One parent sample P-0071, `n_vials` vials (each with a de-dupe-worthy
    analysis set), and `n_flags` sub_sample-anchored flags (default: one per
    vial). Commits so a later `expunge_all` yields a cold identity map."""
    from models import LimsSample, LimsSubSample, LimsAnalysis
    from flags.models import FlagFlag
    n_flags = n_vials if n_flags is None else n_flags
    sample = LimsSample(sample_id="P-0071")
    db.add(sample)
    db.flush()
    vials = []
    for i in range(1, n_vials + 1):
        v = LimsSubSample(parent_sample_pk=sample.id,
                          external_lims_uid=f"mk1://v{i}",
                          sample_id=f"P-0071-S{i:02d}", vial_sequence=i)
        db.add(v)
        vials.append(v)
    db.flush()
    for v in vials:
        for title, kw in [("PEPT-Total", "pept_total"), ("HPLC-PUR", "hplc_pur"),
                          ("PEPT-Total", "pept_total")]:  # dup exercises de-dupe
            db.add(LimsAnalysis(lims_sub_sample_pk=v.id, analysis_service_id=1,
                                keyword=kw, title=title))
    db.flush()
    flags = [FlagFlag(entity_type="sub_sample", entity_id=str(v.id),
                      kind="issue", type="blocker", status="open",
                      title=f"issue {v.sample_id}", created_by=1)
             for v in vials[:n_flags]]
    db.add_all(flags)
    db.commit()
    return sample, vials, flags


def _fresh_cold(n):
    """A session whose flag rows are attached/live but whose LIMS entity rows are
    COLD (never loaded) — exactly the shape a real HTTP request session has.
    Returns (engine, session, flags)."""
    from flags.models import FlagFlag
    from flags import seams
    seams.register_mk1_entities()
    engine = _new_engine()
    db = sessionmaker(bind=engine)()
    _seed(db, n_vials=n)
    db.expunge_all()                 # drop everything from the identity map
    flags = list(db.query(FlagFlag).order_by(FlagFlag.id).all())  # flags live, entities cold
    return engine, db, flags


# --- equality: batch seam == per-id seam ---------------------------------
def test_resolve_contexts_matches_per_id_for_mixed_set(db):
    from flags import seams
    seams.register_mk1_entities()
    sample, vials, _ = _seed(db, n_vials=3, n_flags=0)

    # sub_sample: real ids + a missing one.
    sub_ids = [str(v.id) for v in vials] + ["999999"]
    batch = seams.resolve_contexts(db, "sub_sample", sub_ids)
    per_id = {}
    for i in sub_ids:
        ctx = seams.resolve_context(db, "sub_sample", i)
        if ctx is not None:
            per_id[i] = ctx
    assert batch == per_id
    assert "999999" not in batch                       # missing → absent, not None
    assert batch[str(vials[0].id)]["analyses"] == ["PEPT-Total", "HPLC-PUR"]

    # sample: by pk AND by human Sample ID (P-0071-style) + a missing id.
    samp_ids = [str(sample.id), "P-0071", "P-9999"]
    b = seams.resolve_contexts(db, "sample", samp_ids)
    p = {}
    for i in samp_ids:
        ctx = seams.resolve_context(db, "sample", i)
        if ctx is not None:
            p[i] = ctx
    assert b == p
    assert b[str(sample.id)]["entity_id"] == str(sample.id)   # stamped with pk
    assert b["P-0071"]["entity_id"] == "P-0071"                # stamped with human id
    assert "P-9999" not in b

    # worksheet (DB-free) — batch == per-id.
    w = seams.resolve_contexts(db, "worksheet", ["9", "10"])
    assert w == {i: seams.resolve_context(db, "worksheet", i) for i in ["9", "10"]}

    # unregistered / no-resolver type → {} (never raises).
    assert seams.resolve_contexts(db, "nope", ["1", "2"]) == {}


# --- equality: batch route helper == per-row route helper ----------------
def test_with_entities_matches_with_entity_mixed_and_ordered(db):
    from flags import seams
    from flags.models import FlagFlag
    from flags.routes import _with_entities, _with_entity
    seams.register_mk1_entities()
    _sample, vials, _ = _seed(db, n_vials=2, n_flags=0)

    rows = [
        FlagFlag(entity_type="sub_sample", entity_id=str(vials[0].id),
                 kind="issue", type="blocker", status="open", title="v0", created_by=1),
        FlagFlag(entity_type="sample", entity_id="P-0071",
                 kind="issue", type="blocker", status="open", title="samp", created_by=1),
        FlagFlag(entity_type="general_task", entity_id=None,
                 kind="issue", type="task", status="open", title="virtual", created_by=1),
        FlagFlag(entity_type=None, entity_id=None,
                 kind="issue", type="task", status="open", title="general", created_by=1),
        FlagFlag(entity_type="sub_sample", entity_id="999999",
                 kind="issue", type="blocker", status="open", title="missing", created_by=1),
        FlagFlag(entity_type="worksheet", entity_id="9",
                 kind="issue", type="task", status="open", title="ws", created_by=1),
        FlagFlag(entity_type="sub_sample", entity_id=str(vials[1].id),
                 kind="issue", type="blocker", status="open", title="v1", created_by=1),
    ]
    db.add_all(rows)
    db.flush()

    batch = _with_entities(db, rows)
    per_row = [_with_entity(db, r) for r in rows]

    # Order preserved.
    assert [r.title for r in batch] == [r.title for r in per_row] == \
        ["v0", "samp", "virtual", "general", "missing", "ws", "v1"]
    # Per-flag entity payloads identical (None where unresolved).
    for b, p in zip(batch, per_row):
        bd = b.entity.model_dump() if b.entity is not None else None
        pd = p.entity.model_dump() if p.entity is not None else None
        assert bd == pd, (b.title, bd, pd)

    by_title = {r.title: r for r in batch}
    assert by_title["virtual"].entity is None      # virtual kind → no seam context
    assert by_title["general"].entity is None       # general task → no seam context
    assert by_title["missing"].entity is None       # deleted entity → no context
    assert by_title["v0"].entity.sample_id == "P-0071"
    assert by_title["samp"].entity.entity_id == "P-0071"
    assert by_title["ws"].entity.deep_link.kind == "worksheet"


# --- bounded query count -------------------------------------------------
def test_with_entities_query_count_is_bounded_not_n_proportional():
    from flags.routes import _with_entities

    # Batch path at N=5 and N=10 — the count must be CONSTANT (bounded), and
    # small. Measured from a cold identity map so the win is real.
    eng5, db5, flags5 = _fresh_cold(5)
    try:
        with _QueryCounter(eng5) as qc5:
            r5 = _with_entities(db5, flags5)
        assert all(r.entity is not None for r in r5)   # context actually resolved
    finally:
        db5.close()

    eng10, db10, flags10 = _fresh_cold(10)
    try:
        with _QueryCounter(eng10) as qc10:
            r10 = _with_entities(db10, flags10)
        assert all(r.entity is not None for r in r10)
    finally:
        db10.close()

    assert qc5.count == qc10.count, (qc5.statements, qc10.statements)
    assert qc5.count <= 5, qc5.statements     # 3 in practice: vials, parents, analyses

    # Old per-row path (the N+1 this replaces) from the same cold state — must be
    # N-proportional, proving the batch path is the fix, not the harness.
    from flags.routes import _with_entity
    engp, dbp, flagsp = _fresh_cold(10)
    try:
        with _QueryCounter(engp) as qcp:
            [_with_entity(dbp, f) for f in flagsp]
    finally:
        dbp.close()

    assert qcp.count > qc10.count             # per-row strictly worse
    assert qcp.count >= len(flagsp)           # ~3 queries per vial


if __name__ == "__main__":       # pragma: no cover — handy for eyeballing numbers
    eng, db_, flags = _fresh_cold(10)
    from flags.routes import _with_entities, _with_entity
    with _QueryCounter(eng) as qc:
        _with_entities(db_, flags)
    batch_n = qc.count
    db_.close()
    eng2, db2, flags2 = _fresh_cold(10)
    with _QueryCounter(eng2) as qc2:
        [_with_entity(db2, f) for f in flags2]
    print(f"N=10  batch={batch_n} queries  per-row={qc2.count} queries")
    db2.close()

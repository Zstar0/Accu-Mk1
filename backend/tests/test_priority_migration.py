"""Schema + seed assertions for the priority feature. Runs against the dev DB.

`_run_migrations()` is idempotent, so the module calls it directly at import
rather than relying on the app's startup lifespan having run.
"""
import uuid
from datetime import datetime, timezone

from sqlalchemy import text

from database import engine, _run_migrations

_run_migrations()


def _cols(table: str) -> set[str]:
    with engine.connect() as c:
        rows = c.execute(text(
            "SELECT column_name FROM information_schema.columns WHERE table_name = :t"
        ), {"t": table}).scalars().all()
    return set(rows)


def test_priorities_table_seeded_with_three_rows():
    with engine.connect() as c:
        rows = c.execute(text(
            "SELECT key, rank, icon, color, pulse, is_default, is_active FROM priorities ORDER BY rank"
        )).all()
    by_key = {r[0]: r for r in rows}
    assert set(by_key) >= {"default", "high", "expedited"}
    assert by_key["default"][1:] == (0, "minus", "zinc", False, True, True)
    assert by_key["high"][1:] == (10, "chevron-up", "amber", False, False, True)
    assert by_key["expedited"][1:] == (20, "chevrons-up", "red", True, False, True)


def test_single_default_index_exists():
    with engine.connect() as c:
        n = c.execute(text(
            "SELECT count(*) FROM pg_indexes WHERE indexname = 'uq_priorities_single_default'"
        )).scalar()
    assert n == 1


def test_level_columns_exist():
    assert "priority_key" in _cols("lims_orders")
    assert "priority_source" in _cols("lims_orders")
    assert {"priority_key", "sla_priority_key", "sla_priority_source",
            "sla_target_minutes", "sla_snapshot_at"} <= _cols("lims_samples")
    assert {"priority_key", "sla_priority_key", "sla_priority_source",
            "sla_target_minutes", "sla_snapshot_at"} <= _cols("lims_sub_samples")
    assert {"wp_customer_user_id", "priority_key", "note"} <= _cols("customer_priorities")
    assert {"level", "entity_id", "old_key", "new_key", "source"} <= _cols("priority_audit")


def test_sla_priority_tiers_has_fk_to_priorities():
    with engine.connect() as c:
        n = c.execute(text(
            "SELECT count(*) FROM information_schema.table_constraints "
            "WHERE table_name='sla_priority_tiers' AND constraint_name='fk_sla_priority_tiers_priority'"
        )).scalar()
    assert n == 1


def test_vial_keyed_sample_priorities_backfill_into_lims_sub_samples():
    """A sample_priorities row keyed by a VIAL uid must land on
    lims_sub_samples.priority_key (the retired inbox wrote native mk1:// vial
    uids there), with one vial-level migration audit row."""
    tag = uuid.uuid4().hex[:8]
    uid = f"mk1://mig-{tag}"
    sample_pk = vial_pk = None
    try:
        with engine.begin() as c:
            sample_pk = c.execute(text(
                "INSERT INTO lims_samples (sample_id, external_lims_uid, last_synced_at) "
                "VALUES (:sid, :uid, :now) RETURNING id"
            ), {"sid": f"PB-M{tag}", "uid": f"mk1test-{tag}",
                "now": datetime.now(timezone.utc).replace(tzinfo=None)}).scalar()
            vial_pk = c.execute(text(
                "INSERT INTO lims_sub_samples (parent_sample_pk, sample_id, "
                "external_lims_uid, vial_sequence) "
                "VALUES (:pk, :sid, :uid, 1) RETURNING id"
            ), {"pk": sample_pk, "sid": f"PB-M{tag}-S01", "uid": uid}).scalar()
            c.execute(text(
                "INSERT INTO sample_priorities (sample_uid, priority, updated_at) "
                "VALUES (:uid, 'expedited', :now)"
            ), {"uid": uid, "now": datetime.now(timezone.utc)})

        _run_migrations()

        with engine.connect() as c:
            assert c.execute(text(
                "SELECT priority_key FROM lims_sub_samples WHERE id = :id"
            ), {"id": vial_pk}).scalar() == "expedited"
            assert c.execute(text(
                "SELECT count(*) FROM priority_audit WHERE level = 'vial' "
                "AND entity_id = :id AND source = 'migration' AND new_key = 'expedited'"
            ), {"id": str(vial_pk)}).scalar() == 1

        # Idempotent: a second pass adds no duplicate audit row.
        _run_migrations()
        with engine.connect() as c:
            assert c.execute(text(
                "SELECT count(*) FROM priority_audit WHERE level = 'vial' "
                "AND entity_id = :id AND source = 'migration'"
            ), {"id": str(vial_pk)}).scalar() == 1
    finally:
        with engine.begin() as c:
            if vial_pk is not None:
                c.execute(text("DELETE FROM priority_audit WHERE level = 'vial' AND entity_id = :id"),
                          {"id": str(vial_pk)})
            if sample_pk is not None:
                c.execute(text("DELETE FROM priority_audit WHERE level = 'sample' AND entity_id = :id"),
                          {"id": str(sample_pk)})
            c.execute(text("DELETE FROM sample_priorities WHERE sample_uid = :uid"), {"uid": uid})
            if vial_pk is not None:
                c.execute(text("DELETE FROM lims_sub_samples WHERE id = :id"), {"id": vial_pk})
            if sample_pk is not None:
                c.execute(text("DELETE FROM lims_samples WHERE id = :id"), {"id": sample_pk})

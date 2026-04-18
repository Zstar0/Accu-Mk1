import uuid

from backend.mk1_db import (
    ensure_peptide_request_status_log_table,
    ensure_peptide_requests_table,
)
from backend.peptide_request_repo import PeptideRequestRepository
from backend.status_log_repo import StatusLogRepository
from backend.models_peptide_request import PeptideRequestCreate

# The app invokes ensure_*_table() lazily at runtime. In tests we call it
# explicitly so the repo has a real table to INSERT/SELECT against. The DDL
# is idempotent (CREATE TABLE/INDEX IF NOT EXISTS), so this is a no-op on
# subsequent runs. Status-log rows FK to peptide_requests, so the parent
# table must be ensured first.
ensure_peptide_requests_table()
ensure_peptide_request_status_log_table()


def test_append_and_get_history():
    prepo = PeptideRequestRepository()
    lrepo = StatusLogRepository()
    req = prepo.create(
        PeptideRequestCreate(
            compound_kind="peptide", compound_name="X",
            vendor_producer="Y", submitted_by_wp_user_id=1,
            submitted_by_email="a@b.c", submitted_by_name="N",
        ),
        idempotency_key=str(uuid.uuid4()),
        clickup_list_id="list",
    )
    # Unique event id per run — the partial-unique index on clickup_event_id
    # means a literal "evt_1" only inserts once per lifetime of the dev DB, so
    # re-runs hit the dedup path and the history is empty. Use a uuid suffix.
    lrepo.append(
        peptide_request_id=req.id,
        from_status="new", to_status="approved",
        source="clickup", clickup_event_id=f"evt_{uuid.uuid4().hex[:8]}",
        actor_clickup_user_id="cu_1", actor_accumk1_user_id=None,
        note=None,
    )
    history = lrepo.get_for_request(req.id)
    assert len(history) == 1
    assert history[0].to_status == "approved"


def test_append_deduplicates_on_clickup_event_id():
    lrepo = StatusLogRepository()
    prepo = PeptideRequestRepository()
    req = prepo.create(
        PeptideRequestCreate(
            compound_kind="peptide", compound_name="X",
            vendor_producer="Y", submitted_by_wp_user_id=2,
            submitted_by_email="a@b.c", submitted_by_name="N",
        ),
        idempotency_key=str(uuid.uuid4()),
        clickup_list_id="list",
    )
    # Use a unique event id per run so re-running the suite on a polluted dev DB
    # still yields RED → GREEN. Spec used the literal string "evt_dedup_1", but
    # the partial-unique index on clickup_event_id means that value can only be
    # inserted once in the lifetime of the DB. A per-run uuid suffix keeps the
    # spec's dedup semantics while staying idempotent across runs.
    evt_id = f"evt_dedup_{uuid.uuid4().hex[:8]}"
    assert lrepo.append(
        peptide_request_id=req.id, from_status="new", to_status="approved",
        source="clickup", clickup_event_id=evt_id,
        actor_clickup_user_id="cu_1", actor_accumk1_user_id=None, note=None,
    ) is True  # inserted
    assert lrepo.append(
        peptide_request_id=req.id, from_status="new", to_status="approved",
        source="clickup", clickup_event_id=evt_id,
        actor_clickup_user_id="cu_1", actor_accumk1_user_id=None, note=None,
    ) is False  # dedup

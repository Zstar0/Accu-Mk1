import pytest
import uuid
from backend.mk1_db import get_mk1_conn, ensure_peptide_requests_table
from backend.peptide_request_repo import PeptideRequestRepository
from backend.models_peptide_request import PeptideRequestCreate

# The app invokes ensure_*_table() lazily at runtime. In tests we call it
# explicitly so the repo has a real table to INSERT/SELECT against. The DDL
# is idempotent (CREATE TABLE/INDEX IF NOT EXISTS), so this is a no-op on
# subsequent runs. Matches the pattern established in Tasks 1-3 schema tests.
ensure_peptide_requests_table()


@pytest.fixture
def repo():
    return PeptideRequestRepository()


@pytest.fixture
def sample_create():
    return PeptideRequestCreate(
        compound_kind="peptide", compound_name="Retatrutide",
        vendor_producer="PepMart", submitted_by_wp_user_id=42,
        submitted_by_email="a@b.c", submitted_by_name="Jane",
    )


def test_create_inserts_and_returns_row(repo, sample_create):
    idem = str(uuid.uuid4())
    row = repo.create(sample_create, idempotency_key=idem, clickup_list_id="list_abc")
    assert row.compound_name == "Retatrutide"
    assert row.status == "new"
    assert row.clickup_task_id is None


def test_create_is_idempotent_on_replay(repo, sample_create):
    idem = str(uuid.uuid4())
    first = repo.create(sample_create, idempotency_key=idem, clickup_list_id="list_abc")
    second = repo.create(sample_create, idempotency_key=idem, clickup_list_id="list_abc")
    assert first.id == second.id  # same row returned, not a new one


def test_get_by_id_returns_row(repo, sample_create):
    created = repo.create(sample_create, idempotency_key=str(uuid.uuid4()), clickup_list_id="list_abc")
    fetched = repo.get_by_id(created.id)
    assert fetched is not None
    assert fetched.id == created.id


def test_get_by_id_returns_none_for_missing(repo):
    assert repo.get_by_id(uuid.uuid4()) is None

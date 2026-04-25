"""Tests for PeptideRequestRepository.update_fields + the
reverse-mapping helpers on PeptideRequestConfig.

Covers:
  * whitelist enforcement (unknown cols raise ValueError)
  * empty kwargs is a no-op that returns the row
  * parameterized SQL actually mutates the expected columns
  * updated_at bumps
  * row-not-found returns None
  * config.custom_field_id_to_column reverse maps known + unknown ids
  * config.compound_kind_option_to_value reverse maps option UUIDs
"""
import uuid

import pytest

from mk1_db import ensure_peptide_requests_table
from models_peptide_request import PeptideRequestCreate
from peptide_request_config import PeptideRequestConfig
from peptide_request_repo import PeptideRequestRepository


ensure_peptide_requests_table()


def _seed() -> "uuid.UUID":
    repo = PeptideRequestRepository()
    row = repo.create(
        PeptideRequestCreate(
            compound_kind="peptide",
            compound_name="UpdateFieldsFixture",
            vendor_producer="OrigVendor",
            cas_or_reference="CAS-ORIG",
            submitted_by_wp_user_id=50000 + uuid.uuid4().int % 10000,
            submitted_by_email="orig@example.com",
            submitted_by_name="Orig",
        ),
        idempotency_key=str(uuid.uuid4()),
        clickup_list_id="list_update_fields_test",
    )
    return row.id


# ---------------------------------------------------------------------------
# repo.update_fields
# ---------------------------------------------------------------------------


def test_update_fields_single_column_updates_and_returns_row():
    rid = _seed()
    repo = PeptideRequestRepository()

    updated = repo.update_fields(rid, sample_id="S-NEW-001")

    assert updated is not None
    assert updated.sample_id == "S-NEW-001"
    # Other columns untouched.
    assert updated.compound_name == "UpdateFieldsFixture"
    assert updated.vendor_producer == "OrigVendor"


def test_update_fields_multi_column_in_one_call():
    rid = _seed()
    repo = PeptideRequestRepository()

    updated = repo.update_fields(
        rid,
        sample_id="S-MULTI",
        cas_or_reference="CAS-NEW",
        vendor_producer="NewVendor",
        submitted_by_email="multi@example.com",
    )

    assert updated is not None
    assert updated.sample_id == "S-MULTI"
    assert updated.cas_or_reference == "CAS-NEW"
    assert updated.vendor_producer == "NewVendor"
    assert updated.submitted_by_email == "multi@example.com"


def test_update_fields_compound_kind_updates_enum_column():
    rid = _seed()  # seeded as "peptide"
    repo = PeptideRequestRepository()

    updated = repo.update_fields(rid, compound_kind="other")
    assert updated is not None
    assert updated.compound_kind == "other"


def test_update_fields_unknown_column_raises_value_error():
    rid = _seed()
    repo = PeptideRequestRepository()

    # Even a plausible-looking column not in the whitelist must raise.
    with pytest.raises(ValueError) as exc:
        repo.update_fields(rid, status="in_process")
    assert "status" in str(exc.value)

    # A totally bogus key also raises.
    with pytest.raises(ValueError):
        repo.update_fields(rid, definitely_not_a_col="x")

    # Mix of valid + invalid — whole call rejects (no partial writes).
    with pytest.raises(ValueError):
        repo.update_fields(rid, sample_id="S-X", bogus="y")


def test_update_fields_empty_kwargs_is_noop_returns_row():
    rid = _seed()
    repo = PeptideRequestRepository()

    before = repo.get_by_id(rid)
    assert before is not None

    after = repo.update_fields(rid)
    assert after is not None
    assert after.id == before.id
    # No write happened — updated_at unchanged.
    assert after.updated_at == before.updated_at


def test_update_fields_unknown_row_returns_none():
    repo = PeptideRequestRepository()
    missing_id = uuid.uuid4()

    result = repo.update_fields(missing_id, sample_id="S-GHOST")
    assert result is None


def test_update_fields_bumps_updated_at():
    rid = _seed()
    repo = PeptideRequestRepository()

    before = repo.get_by_id(rid)
    assert before is not None

    updated = repo.update_fields(rid, sample_id="S-BUMP")
    assert updated is not None
    assert updated.updated_at >= before.updated_at


# ---------------------------------------------------------------------------
# config reverse-mapping helpers
# ---------------------------------------------------------------------------


def _cfg_with_fields() -> PeptideRequestConfig:
    return PeptideRequestConfig(
        clickup_list_id="list",
        clickup_api_token="tok",
        clickup_webhook_secret="sec",
        clickup_field_sample_id="uuid-sample-id",
        clickup_field_cas="uuid-cas",
        clickup_field_vendor_producer="uuid-vendor",
        clickup_field_customer_email="uuid-email",
        clickup_field_compound_kind="uuid-kind",
        clickup_opt_compound_kind_peptide="opt-peptide",
        clickup_opt_compound_kind_other="opt-other",
    )


def test_custom_field_id_to_column_maps_known_ids():
    cfg = _cfg_with_fields()
    assert cfg.custom_field_id_to_column("uuid-sample-id") == "sample_id"
    assert cfg.custom_field_id_to_column("uuid-cas") == "cas_or_reference"
    assert cfg.custom_field_id_to_column("uuid-vendor") == "vendor_producer"
    assert cfg.custom_field_id_to_column("uuid-email") == "submitted_by_email"
    assert cfg.custom_field_id_to_column("uuid-kind") == "compound_kind"


def test_custom_field_id_to_column_returns_none_for_unknown():
    cfg = _cfg_with_fields()
    assert cfg.custom_field_id_to_column("uuid-not-ours") is None
    assert cfg.custom_field_id_to_column("") is None


def test_custom_field_id_to_column_skips_unconfigured_fields():
    """A config where a field id is empty must NOT match the empty string
    coming from a future lookup (defense against an accidental '' key)."""
    cfg = PeptideRequestConfig(
        clickup_list_id="list",
        clickup_api_token="tok",
        clickup_webhook_secret="sec",
        clickup_field_sample_id="uuid-sample-id",
        # other field ids left as default ""
    )
    assert cfg.custom_field_id_to_column("uuid-sample-id") == "sample_id"
    assert cfg.custom_field_id_to_column("") is None


def test_compound_kind_option_to_value_maps_known_options():
    cfg = _cfg_with_fields()
    assert cfg.compound_kind_option_to_value("opt-peptide") == "peptide"
    assert cfg.compound_kind_option_to_value("opt-other") == "other"


def test_compound_kind_option_to_value_returns_none_for_unknown():
    cfg = _cfg_with_fields()
    assert cfg.compound_kind_option_to_value("opt-bogus") is None
    assert cfg.compound_kind_option_to_value("") is None

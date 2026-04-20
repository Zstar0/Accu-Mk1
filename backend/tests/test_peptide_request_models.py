import pytest
from pydantic import ValidationError
from models_peptide_request import (
    PeptideRequestCreate, PeptideRequest, CompoundKind, Status
)


def test_create_validates_required_fields():
    with pytest.raises(ValidationError):
        PeptideRequestCreate(compound_kind="peptide")  # missing required fields


def test_create_rejects_invalid_kind():
    with pytest.raises(ValidationError):
        PeptideRequestCreate(
            compound_kind="bogus", compound_name="X", vendor_producer="Y",
            submitted_by_wp_user_id=1, submitted_by_email="a@b.c",
            submitted_by_name="Name",
        )


def test_create_accepts_minimal_valid_payload():
    m = PeptideRequestCreate(
        compound_kind="peptide", compound_name="BPC-157",
        vendor_producer="Cayman", submitted_by_wp_user_id=42,
        submitted_by_email="a@b.c", submitted_by_name="Jane",
    )
    assert m.compound_kind == "peptide"


def test_create_enforces_length_limits():
    with pytest.raises(ValidationError):
        PeptideRequestCreate(
            compound_kind="peptide", compound_name="X" * 201,
            vendor_producer="Y", submitted_by_wp_user_id=1,
            submitted_by_email="a@b.c", submitted_by_name="N",
        )


def test_status_enum_values():
    assert set(Status.__args__) == {  # assuming Literal-typed Status
        "new", "approved", "ordering_standard", "sample_prep_created",
        "in_process", "on_hold", "completed", "rejected", "cancelled",
    }

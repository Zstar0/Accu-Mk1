"""_analyte_slots for native-born parents derives titles from
coa.hplc_shim.slot_wires (spec M7) so they match the Title legacy_rows puts
on the identity row, even when the stored registry label diverges. SENAITE-
born parents keep the existing raw-label passthrough, byte-identical."""
import json
import os

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from unittest.mock import patch

from database import Base
from coa.sample_meta import build_sample_meta
from tests.hplc_native_family import native_family

ENV = {"MK1_PUBLIC_BASE_URL": "https://mk1.test"}


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _add_sample_image(db, parent):
    from models import LimsParentAttachment
    img = LimsParentAttachment(
        lims_sample_pk=parent.id, kind="receive_image", filename="img.png",
        content_type="image/png", storage="s3", storage_key="k1",
        render_in_report=True, attachment_type="Sample Image",
        created_by_user_id=None)
    db.add(img); db.flush()
    return img


def test_native_born_analyte_titles_match_shim(db):
    parent, services, peps, _ = native_family(
        db, sample_id="PB-1502", slots=[("BPC-157", "BPC157"), ("TB-500", "TB500")])
    # Stored registry label deliberately does NOT match the peptide name --
    # resolve_slot_peptides keys off the stored peptide_id, not this label.
    slots = json.loads(parent.analytes)
    slots[0]["name"] = "bpc157"
    parent.analytes = json.dumps(slots)
    db.flush()
    _add_sample_image(db, parent)

    with patch.dict(os.environ, ENV):
        meta = build_sample_meta(db, parent)

    assert meta["Analyte1Peptide"] == "BPC-157 - Identity (HPLC)"
    assert meta["Analyte2Peptide"] == "TB-500 - Identity (HPLC)"
    assert "Analyte3Peptide" not in meta


def test_senaite_born_analyte_titles_unchanged(db):
    from models import LimsSample
    parent = LimsSample(
        sample_id="P-0002", external_lims_uid="uid-2", external_lims_system="senaite",
        sample_type_title="Peptide", analytes=json.dumps([
            {"name": "BPC-157 - Identity (HPLC)", "declared_quantity": None},
        ]))
    db.add(parent); db.flush()
    _add_sample_image(db, parent)

    with patch.dict(os.environ, ENV):
        meta = build_sample_meta(db, parent)

    assert meta["Analyte1Peptide"] == "BPC-157 - Identity (HPLC)"

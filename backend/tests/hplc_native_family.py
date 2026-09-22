"""Shared builder for native-born HPLC family fixtures (slice 4 tests).

Not a test module (no test_ prefix). Seeds: Analytical dept, the five native
services (origin='mk1') + their profile via the real boot seeder, peptides, a
native-born parent whose `analytes` JSON carries peptide_id per slot,
per-slot ordered parent placeholders, and N vials seeded through the real
native seeder — the same objects prod creates.
"""
import json

from models import AnalysisService, LimsSample, LimsSubSample, Peptide
from lims_analyses.hplc_native import native_hplc_services, seed_native_hplc_rows
from lims_analyses.parent_placeholders import seed_parent_placeholders


def native_catalog(db) -> dict[str, AnalysisService]:
    from catalog.hplc_native_seed import HPLC_NATIVE_PROFILE_KEY, seed_hplc_native_catalog
    from models import AnalysisProfile

    seed_hplc_native_catalog(db)
    prof = db.query(AnalysisProfile).filter_by(key=HPLC_NATIVE_PROFILE_KEY).one()
    prof.active = True
    db.flush()
    return native_hplc_services(db)


def native_family(db, *, sample_id: str, slots: list[tuple[str, str]], vials: int = 1,
                  services: dict | None = None):
    """slots = [(peptide_name, abbreviation), ...] in slot order. Returns
    (parent, services, peptides_by_slot, vial_rows_by_vial)."""
    from catalog.hplc_native_seed import HPLC_NATIVE_PROFILE_KEY

    services = services or native_catalog(db)
    peps = []
    for name, abbr in slots:
        p = Peptide(name=name, abbreviation=abbr, active=True); db.add(p); db.flush(); peps.append(p)
    analytes = [{"name": p.name, "declared_quantity": None, "peptide_id": p.id} for p in peps]
    parent = LimsSample(sample_id=sample_id, external_lims_system="mk1", external_lims_uid=None,
                        sample_type_title="Peptide Blend" if len(peps) > 1 else "Peptide",
                        analytes=json.dumps(analytes))
    db.add(parent); db.flush()
    # parent placeholders: same `services=`/`package=` shape
    # seed_parent_placeholders takes in
    # tests/test_hplc_native_placeholders.py (profile key -> ordered bool).
    seed_parent_placeholders(db, parent=parent, services={HPLC_NATIVE_PROFILE_KEY: True})
    vial_rows = {}
    for seq in range(1, vials + 1):
        v = LimsSubSample(parent_sample_pk=parent.id, sample_id=f"{sample_id}-S{seq:02d}",
                          external_lims_uid=f"uid-{sample_id}-S{seq:02d}", vial_sequence=seq)
        db.add(v); db.flush()
        rows = seed_native_hplc_rows(db, sub_sample=v, parent=parent, existing_keys=set(),
                                     existing_service_ids=set(), created_by_user_id=None, commit=False)
        vial_rows[v.id] = rows
    db.flush()
    return parent, services, {i + 1: p for i, p in enumerate(peps)}, vial_rows

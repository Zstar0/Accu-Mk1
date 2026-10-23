"""Assembly wrapper: the COA wire document = native sections + (mk1 mode)
the legacy_rows and sample_meta blocks. Single choke point for the
coa_generation toggle so every call site (generate, regular-child,
regen-primary, S2S for IS additionals, per-vial) behaves identically.

Spec: docs/superpowers/specs/2026-08-26-coa-legacy-rows-mk1-source-design.md
      docs/superpowers/specs/2026-08-28-coa-read-independence-design.md
"""
import logging

from coa.legacy_rows import build_legacy_rows
from coa.native_sections import build_native_sections
from coa.sample_meta import build_sample_meta
from coa.source_setting import coa_generation_source

log = logging.getLogger(__name__)


def _legacy_block(db, parent) -> dict:
    return {"source": "mk1", "rows": build_legacy_rows(db, parent)}


def build_coa_wire_document(db, parent) -> dict:
    """The document COABuilder receives as `native_sections`.

    Raises NativeSectionsError (from either builder) — callers keep their
    existing fail-closed handling.
    """
    doc = build_native_sections(db, parent)
    if coa_generation_source(db) == "mk1":
        doc["legacy_rows"] = _legacy_block(db, parent)
        doc["sample_meta"] = build_sample_meta(db, parent)
    return doc


def build_vial_wire_document(db, parent, vial=None, vial_parent_ids=None):
    """Per-vial COA document, or None in senaite mode.

    Per-vial certificates (Handler ruling 2026-10-20): the native sections
    carry only the results promoted from this vial (`vial_parent_ids`, see
    coa.variance_series.vial_parent_row_ids); with no ids the sections stay
    empty, as before. The legacy rows are the parent's: on a native-born lot
    they are the HPLC rows, which COABuilder replaces with the vial's own
    figures, and SENAITE-origin rows carry no vial lineage to scope by.
    `vial` (LimsSubSample) pins the chromatogram and image to that vial's
    rows, fail-closed, never a sibling's (P-2627, P-5324).
    """
    if coa_generation_source(db) != "mk1":
        return None
    if vial_parent_ids:
        doc = build_native_sections(db, parent, vial_parent_ids=set(vial_parent_ids))
    else:
        doc = {"sample_id": parent.sample_id, "ordered_profiles": [], "sections": []}
    doc["legacy_rows"] = _legacy_block(db, parent)
    doc["sample_meta"] = build_sample_meta(db, parent, vial=vial)
    return doc


def warn_if_source_ignored(doc, response_json, sample_id) -> None:
    """Drift detector: the toggle said mk1 but COABuilder didn't use the rows
    (old COABuilder deployed, or the block was dropped en route). Loud, never
    fatal — the certificate already generated from SENAITE lines."""
    if not doc:
        return
    data_sources = (response_json or {}).get("data_sources") or {}
    if "legacy_rows" in doc:
        used = data_sources.get("legacy_rows")
        if used != "mk1":
            log.warning(
                "COA source toggle is mk1 but COABuilder reported legacy_rows "
                "source %r for %s — check the deployed COABuilder version",
                used, sample_id,
            )
    if "sample_meta" in doc:
        used_meta = data_sources.get("sample_meta")
        if used_meta != "mk1":
            log.warning(
                "COA source toggle is mk1 but COABuilder reported sample_meta "
                "source %r for %s — check the deployed COABuilder version",
                used_meta, sample_id,
            )

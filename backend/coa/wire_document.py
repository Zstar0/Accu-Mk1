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
from coa.sample_units import build_sample_units
from coa.source_setting import coa_generation_source

log = logging.getLogger(__name__)


def _legacy_block(db, parent, sections: list | None = None) -> dict:
    rows = build_legacy_rows(db, parent, sections=sections)
    block = {"source": "mk1", "rows": rows}
    if rows == []:
        # A la carte: the only signal COABuilder trusts for an empty page 1.
        block["page1"] = "none"
    return block


def build_coa_wire_document(db, parent, *, trace=None) -> dict:
    """The document COABuilder receives as `native_sections`.

    Raises NativeSectionsError (from either builder) — callers keep their
    existing fail-closed handling. `trace` is build_native_sections' (the
    Variance fingerprint content; never on the wire).
    """
    # Always traced: the unit block reads which Variance profiles printed
    # their runs. A caller's own list is filled exactly as before.
    runs = trace if trace is not None else []
    doc = build_native_sections(db, parent, trace=runs)
    if coa_generation_source(db) == "mk1":
        doc["legacy_rows"] = _legacy_block(db, parent, doc["sections"])
        doc["sample_meta"] = build_sample_meta(db, parent)
    _attach_sample_units(db, parent, doc, variance_keys=[
        t.get("profile_key") for t in runs if isinstance(t, dict) and not t.get("deferred")])
    return doc


def _attach_sample_units(db, parent, doc, *, single_vial: bool = False,
                         variance_keys=()) -> None:
    """Add the header's unit block (form icon, word, count). Best-effort: it
    is cosmetic, so a failure logs and leaves the key off (COABuilder then
    prints the old header row) and never blocks a certificate.

    Read-only, inside a savepoint so a failed query cannot poison the caller's
    session. On success the savepoint is RELEASED, not rolled back: any
    rollback, a savepoint's included, fires the session's after_rollback
    listeners, and flags.service drops staged flag events there.
    """
    sample_id = getattr(parent, "sample_id", "?")
    sp = None
    try:
        sp = db.begin_nested()
        block = build_sample_units(db, parent, doc, single_vial=single_vial,
                                   variance_keys=variance_keys)
        sp.commit()
        doc["sample_units"] = block
    except Exception:  # noqa: BLE001 - see the docstring
        log.warning("sample_units build failed for %s; the certificate keeps the "
                    "old header row", sample_id, exc_info=True)
        try:
            if sp is not None and sp.is_active:
                sp.rollback()
        except Exception:  # noqa: BLE001 - a dead connection must fail the caller's own next query, not this
            log.warning("sample_units savepoint rollback failed for %s", sample_id,
                        exc_info=True)


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
    _attach_sample_units(db, parent, doc, single_vial=True)
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

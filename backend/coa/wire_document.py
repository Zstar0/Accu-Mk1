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


def build_vial_wire_document(db, parent):
    """Legacy-only document for per-vial COA bodies, or None in senaite mode.

    Vial certificates have never rendered native sections and must not start
    now — only their base row sourcing follows the toggle, so sections stay
    empty on purpose.
    """
    if coa_generation_source(db) != "mk1":
        return None
    return {
        "sample_id": parent.sample_id,
        "ordered_profiles": [],
        "sections": [],
        "legacy_rows": _legacy_block(db, parent),
        "sample_meta": build_sample_meta(db, parent),
    }


def deferred_sections_warning(doc) -> str | None:
    """Operator-facing warning for a wire document carrying deferred native
    sections (partial-COA fix, 2026-08-29), or None when there's nothing to
    surface — `doc` is falsy (e.g. a failed/skipped assembly never reached
    this point) or carries no `deferred_sections`. Callers append/set this
    on the response's `warning` field after a successful generation only;
    it does not gate success — the certificate already printed with the
    sections that WERE ready.
    """
    if not doc:
        return None
    deferred = doc.get("deferred_sections")
    if not deferred:
        return None
    return (
        f"Pending section(s) omitted: {', '.join(deferred)} — "
        "regenerate the COA when results land."
    )


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

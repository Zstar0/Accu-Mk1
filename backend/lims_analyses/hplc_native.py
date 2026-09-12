"""Native-born HPLC seeding model (spec 2026-09-10-hplc-native-born-design, M4).

A native-born sample (lims_samples.external_lims_system == 'mk1') has no
SENAITE AR to mirror. Its HPLC content is derived from lims_samples.analytes
(the positional slot list) against the GENERIC native trio: one identity /
purity / quantity row per occupied slot, carrying the slot's peptide_id and a
STAMPED per-row title, plus the two blend aggregates when more than one slot
is occupied. The peptide is data on the row — never part of the catalog key —
which is what removes the SENAITE-era title-string joins (P-1500 / P-1611 /
PB-0469 class).

Resolution order per slot: the signal's Analyte{i}PeptideId (written by the
IS once WordPress carries Mk1 ids) → exact fold of the label (identity suffix
stripped) against peptides.name / abbreviation → hplc_aliases / display_aliases.
Zero matches or 2+ distinct matches never guess: the rows are still seeded,
with peptide_id NULL and reportable_reason 'analyte_unresolved|ambiguous: …'
(Handler ruling 2026-09-10) so the bench sees the slot. `reportable` itself
stays True here (Handler ruling pending) -- gating these rows out of the prep
bridge (M5), out of the COA wire (M7), and restamping them via
relabel_native_slot (M6) are named follow-up requirements, not yet built.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from catalog.hplc_native_seed import HPLC_NATIVE_PROFILE_KEY, HPLC_NATIVE_SERVICES
from models import AnalysisService, LimsAnalysis, LimsSample, LimsSubSample, Peptide

log = logging.getLogger(__name__)

KW_IDENTITY = "HPLC-IDENTITY"
KW_PURITY = "HPLC-PURITY"
KW_QUANTITY = "HPLC-QUANTITY"
KW_BLEND_PURITY = "HPLC-BLEND-PURITY"
KW_BLEND_TOTAL = "HPLC-BLEND-TOTAL"
TRIO = (KW_IDENTITY, KW_PURITY, KW_QUANTITY)
AGGREGATES = (KW_BLEND_PURITY, KW_BLEND_TOTAL)
assert set(TRIO + AGGREGATES) == {kw for kw, *_ in HPLC_NATIVE_SERVICES}

_NATIVE_CATEGORY = {
    KW_IDENTITY: "identity",
    KW_PURITY: "purity",
    KW_QUANTITY: "quantity",
}


def native_category(keyword: Optional[str]) -> Optional[str]:
    """Result category of a NATIVE trio keyword; None for everything else.

    The single source every `_category` mirror (prep_bridge, coa.variance_series,
    coa.identity_verdict) consults first, so the three cannot drift on the
    native keywords. Aggregates (HPLC-BLEND-*) are deliberately None: like
    legacy BLEND-PUR / PEPT-Total they are owned by bridge_blend_aggregates
    and are never a direct bridge/stamp target nor a per-peptide series row.
    """
    return _NATIVE_CATEGORY.get((keyword or "").upper())

# Same rule sub_samples/senaite.py uses to strip SENAITE's identity-service
# title form ("BPC-157 - Identity (HPLC)") back to the bare label.
_IDENTITY_SUFFIX_RE = re.compile(r"\s*-\s*identity\s*\(hplc\)\s*$", re.I)


def is_native_born(parent: LimsSample) -> bool:
    return (getattr(parent, "external_lims_system", None) or "senaite") == "mk1"


def strip_identity_suffix(label: str) -> str:
    return _IDENTITY_SUFFIX_RE.sub("", label or "").strip()


def _fold(s: Optional[str]) -> str:
    """Alphanumeric-only, upper-cased — the same fold the HPLC standard-label
    matcher uses (main.py _normalize_label)."""
    return re.sub(r"[^A-Za-z0-9]", "", s or "").upper()


def identity_title(name: str) -> str:
    return f"{name} - Identity (HPLC)"


def purity_title(name: str) -> str:
    return f"{name} - Purity (HPLC)"


def quantity_title(name: str) -> str:
    return f"{name} - Quantity (HPLC)"


@dataclass
class SlotResolution:
    slot: int                 # 1-based position in lims_samples.analytes
    raw_name: str             # label as stored (title form or bare)
    display_name: str         # peptide.name when resolved, else suffix-stripped raw
    peptide_id: Optional[int]
    reason: Optional[str]     # None | "unresolved" | "ambiguous"


def _parse_slots(parent: LimsSample) -> list[dict]:
    try:
        slots = json.loads(parent.analytes) if parent.analytes else []
    except (TypeError, ValueError):
        return []
    return slots if isinstance(slots, list) else []


def resolve_slot_peptides(db: Session, parent: LimsSample) -> list[SlotResolution]:
    """One SlotResolution per OCCUPIED slot (placeholders with name None are
    skipped but keep their neighbours' slot numbers). Only active peptides
    resolve; a retired peptide is 'unresolved' on purpose."""
    peptides = db.execute(select(Peptide).where(Peptide.active == True)).scalars().all()  # noqa: E712
    by_id = {p.id: p for p in peptides}
    by_exact: dict[str, set[int]] = {}
    by_alias: dict[str, set[int]] = {}
    for p in peptides:
        by_exact.setdefault(_fold(p.name), set()).add(p.id)
        by_exact.setdefault(_fold(p.abbreviation), set()).add(p.id)
        for alias in (p.hplc_aliases or []) + (p.display_aliases or []):
            by_alias.setdefault(_fold(alias), set()).add(p.id)

    out: list[SlotResolution] = []
    for idx, slot in enumerate(_parse_slots(parent), start=1):
        raw = (slot.get("name") or "").strip() if isinstance(slot, dict) else ""
        if not raw:
            continue
        bare = strip_identity_suffix(raw)
        pid = slot.get("peptide_id") if isinstance(slot, dict) else None
        if pid is not None and pid in by_id:
            out.append(SlotResolution(idx, raw, by_id[pid].name, pid, None))
            continue
        hits = by_exact.get(_fold(bare)) or by_alias.get(_fold(bare)) or set()
        if len(hits) == 1:
            p = by_id[next(iter(hits))]
            out.append(SlotResolution(idx, raw, p.name, p.id, None))
        elif not hits:
            out.append(SlotResolution(idx, raw, bare, None, "unresolved"))
        else:
            out.append(SlotResolution(idx, raw, bare, None, "ambiguous"))
    return out


def native_hplc_services(db: Session) -> dict[str, AnalysisService]:
    """The five origin=mk1 services by keyword. Fail-closed: if any is
    missing (seed skipped, collision at boot) return {} and log ERROR so the
    caller seeds nothing rather than a partial trio."""
    rows = db.execute(select(AnalysisService).where(
        AnalysisService.keyword.in_(TRIO + AGGREGATES),
        AnalysisService.origin == "mk1",
    )).scalars().all()
    found = {r.keyword: r for r in rows}
    missing = [kw for kw in TRIO + AGGREGATES if kw not in found]
    if missing:
        log.error("hplc_native.catalog_incomplete missing=%s", missing)
        return {}
    return found


def _title_for(kw: str, name: str) -> str:
    return {KW_IDENTITY: identity_title, KW_PURITY: purity_title, KW_QUANTITY: quantity_title}[kw](name)


def title_for_slot(kw: str, res: "SlotResolution") -> str:
    """The single per-row title rule, shared by seed_native_hplc_rows and
    parent_placeholders.seed_parent_placeholders so the trio and its
    placeholder never drift apart: the peptide's canonical name when
    resolved; for an unresolved identity row, the raw label as stored
    (already title-form from the IS) since the bench must show what the
    customer typed and relabel_native_slot restamps it later."""
    if kw == KW_IDENTITY and not res.peptide_id:
        return res.raw_name
    return _title_for(kw, res.display_name)


def seed_native_hplc_rows(
    db: Session, *, sub_sample: LimsSubSample, parent: LimsSample,
    existing_keys: set, existing_service_ids: set,
    created_by_user_id: Optional[int], commit: bool,
) -> list[LimsAnalysis]:
    """Seed the trio per occupied slot (+ the two aggregates when N>1) on an
    HPLC vial of a native-born parent. Dedupe keys are SLOT-AWARE tuples
    ((keyword, slot or 0) and (service_id, slot or 0)) mirroring the widened
    root indexes; the caller passes the live sets and we add to them."""
    from lims_analyses import service as la_service

    services = native_hplc_services(db)
    if not services:
        return []
    slots = resolve_slot_peptides(db, parent)
    if not slots:
        log.error("seeder.native_hplc.no_analyte_slots sample_id=%s", sub_sample.sample_id)
        return []
    inserted: list[LimsAnalysis] = []

    def _mint(kw: str, *, slot: Optional[int], peptide_id: Optional[int],
              title: str, reason: Optional[str]) -> None:
        svc = services[kw]
        key_kw, key_id = (kw, slot or 0), (svc.id, slot or 0)
        if key_kw in existing_keys or key_id in existing_service_ids:
            return
        row = la_service.create_analysis(
            db, host_kind="sub_sample", host_pk=sub_sample.id,
            analysis_service_id=svc.id, keyword=kw, title=title,
            created_by_user_id=created_by_user_id, commit=commit,
            peptide_id=peptide_id, slot=slot, reportable_reason=reason,
        )
        existing_keys.add(key_kw)
        existing_service_ids.add(key_id)
        inserted.append(row)
        log.info("seeder.native_hplc_seeded sub=%s analysis_id=%s keyword=%s slot=%s peptide_id=%s",
                 sub_sample.sample_id, row.id, kw, slot, peptide_id)

    for res in slots:
        reason = f"analyte_{res.reason}: {res.raw_name}" if res.reason else None
        if res.reason:
            log.warning("seeder.native_hplc.unresolved_slot sub=%s slot=%s raw=%r reason=%s",
                        sub_sample.sample_id, res.slot, res.raw_name, res.reason)
        for kw in TRIO:
            title = title_for_slot(kw, res)
            _mint(kw, slot=res.slot, peptide_id=res.peptide_id, title=title, reason=reason)

    if len(slots) > 1:
        for kw in AGGREGATES:
            _mint(kw, slot=None, peptide_id=None, title=services[kw].title, reason=None)
    return inserted

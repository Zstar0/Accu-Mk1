"""Mk1-native sample IDs (aP-0001, aPB-0001, aBW-0001, …).

Internal-only in the dual-write program: customers keep seeing SENAITE ids
until a testing line goes SENAITE-free (2026-07-06 spec, decision 3).
Forward-only: historical rows keep native_id NULL.

Prefix = "a" + the SENAITE id's own prefix when one exists (zero config for
the SENAITE-attached world); for SENAITE-free callers a sample-type map
applies, falling back to the generic "aS".

Allocation locks the prefix row (SELECT ... FOR UPDATE) — the same
concurrency idiom as vial_sequence assignment. sqlite (tests) treats the
lock as a no-op, which is the established test trade-off in this repo.
"""
from typing import Optional
from sqlalchemy import select
from sqlalchemy.orm import Session
from models import LimsNativeIdSequence

_SAMPLE_TYPE_PREFIXES = {
    "peptide": "aP",
    "peptide blend": "aPB",
    "bacteriostatic water": "aBW",
}
_GENERIC_PREFIX = "aS"
_PAD = 4


def _derive_prefix(senaite_sample_id: Optional[str],
                   sample_type_title: Optional[str]) -> str:
    if senaite_sample_id:
        return "a" + senaite_sample_id.split("-", 1)[0]
    if sample_type_title:
        return _SAMPLE_TYPE_PREFIXES.get(
            sample_type_title.strip().lower(), _GENERIC_PREFIX
        )
    raise ValueError(
        "mint_native_id needs a senaite_sample_id or sample_type_title"
    )


def mint_native_id(db: Session,
                   senaite_sample_id: Optional[str] = None,
                   sample_type_title: Optional[str] = None) -> str:
    prefix = _derive_prefix(senaite_sample_id, sample_type_title)
    seq = db.execute(
        select(LimsNativeIdSequence)
        .where(LimsNativeIdSequence.prefix == prefix)
        .with_for_update()
    ).scalar_one_or_none()
    if seq is None:
        seq = LimsNativeIdSequence(prefix=prefix, next_value=1)
        db.add(seq)
        db.flush()
    value = seq.next_value
    seq.next_value = value + 1
    db.flush()
    return f"{prefix}-{value:0{_PAD}d}"


# ── Customer-facing native ids (spec 2026-09-10, M3) ────────────────────────
# A native-born sample (no SENAITE AR) must still LOOK like every other
# sample to the customer: P-NNNN / PB-NNNN. These counters are seeded by a
# guarded boot migration ABOVE SENAITE's prod maximum (P at 5000, PB at 1000,
# Handler ruling 2026-09-10) so the two authorities cannot collide while the
# legacy drain runs. Bacteriostatic Water is deliberately absent: BW stays
# SENAITE-born in this program. A prefix row that does not exist is an
# operator error (the seed never ran), never auto-created at 1 — that would
# mint P-0001 on prod.
CUSTOMER_PREFIXES = {"peptide": "P", "peptide blend": "PB"}


def mint_customer_sample_id(db: Session, sample_type_title: str) -> str:
    from models import LimsSample

    key = (sample_type_title or "").strip().lower()
    prefix = CUSTOMER_PREFIXES.get(key)
    if prefix is None:
        raise ValueError(
            f"no native customer-facing prefix for sample type {sample_type_title!r} "
            "(only Peptide / Peptide Blend are native-born)"
        )
    seq = db.execute(
        select(LimsNativeIdSequence)
        .where(LimsNativeIdSequence.prefix == prefix)
        .with_for_update()
    ).scalar_one_or_none()
    if seq is None:
        raise ValueError(
            f"customer id counter for prefix {prefix!r} is not seeded "
            "(boot migration lims_native_id_sequences P/PB missing)"
        )
    while True:
        value = seq.next_value
        seq.next_value = value + 1
        candidate = f"{prefix}-{value:0{_PAD}d}"
        taken = db.execute(
            select(LimsSample.id).where(LimsSample.sample_id == candidate)
        ).first()
        if taken is None:
            db.flush()
            return candidate

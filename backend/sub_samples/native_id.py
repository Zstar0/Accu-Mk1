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

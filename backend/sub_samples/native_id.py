"""Mk1-native sample IDs.

Internal-only in the dual-write program: customers keep seeing SENAITE ids
until a testing line goes SENAITE-free (2026-07-06 spec, decision 3;
native-ID minting revised 2026-07-07 to mirror the SENAITE number).

SENAITE-linked samples MIRROR the SENAITE id: native_id = "a" + <full SENAITE
sample id>, retests included (P-1234 -> aP-1234, PB-0216-R01 -> aPB-0216-R01).
Deterministic, no counter draw, unique because SENAITE ids are unique.

SENAITE-free samples (future native-only lines) draw a per-prefix counter:
a{PREFIX}-{NNNN} zero-padded to 4, prefix from a sample-type map (fallback aS).
Allocation locks the prefix row (SELECT ... FOR UPDATE) -- the same
concurrency idiom as vial_sequence assignment. sqlite (tests) treats the
lock as a no-op.

-S\\d+ secondaries are sub-samples, not parents -- never minted (callers
exclude them upstream).
"""
import re
from typing import Optional
from sqlalchemy import select
from sqlalchemy.orm import Session
from models import LimsNativeIdSequence, LimsSample

_SAMPLE_TYPE_PREFIXES = {
    "peptide": "aP",
    "peptide blend": "aPB",
    "bacteriostatic water": "aBW",
}
_GENERIC_PREFIX = "aS"
_PAD = 4

# native_id -> (prefix, base number); the -R\d+ retest suffix is intentionally
# not captured so aPB-0216-R01 seeds from 216, not a parse failure.
_MIRRORED_NUM = re.compile(r"^(a[A-Za-z]+)-(\d+)")


def mint_native_id(db: Session,
                   senaite_sample_id: Optional[str] = None,
                   sample_type_title: Optional[str] = None) -> str:
    """Mint the internal native id for a sample.

    SENAITE-linked (senaite_sample_id given): mirror the whole id -- "a" + id.
    No counter draw, no DB write, deterministic, idempotent.

    SENAITE-free (senaite_sample_id absent): draw the per-prefix counter,
    prefix derived from sample_type_title.
    """
    if senaite_sample_id:
        return "a" + senaite_sample_id

    if not sample_type_title:
        raise ValueError(
            "mint_native_id needs a senaite_sample_id or sample_type_title"
        )
    prefix = _SAMPLE_TYPE_PREFIXES.get(
        sample_type_title.strip().lower(), _GENERIC_PREFIX
    )
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


def seed_native_id_counters(db: Session) -> int:
    """Collision strategy (a): after a COMPLETE retro-mint sweep, seed each
    prefix's counter to max(native number) + 1, so the SENAITE-free counter
    cannot collide with an existing mirrored id once it takes over a prefix at
    SENAITE retirement.

    Idempotent / re-run-safe: never regresses an already-advanced counter.
    Computes maxima from a DB aggregate over lims_samples (not a run's
    in-memory stats), so a --limit / resumed sweep can never seed from partial
    data. The -R\\d+ retest suffix is stripped before parsing the number.
    Returns the number of prefixes seeded or advanced.
    """
    maxes: dict[str, int] = {}
    for nid in db.execute(
        select(LimsSample.native_id).where(LimsSample.native_id.is_not(None))
    ).scalars():
        m = _MIRRORED_NUM.match(nid)
        if not m:
            continue
        prefix, num = m.group(1), int(m.group(2))
        if num > maxes.get(prefix, 0):
            maxes[prefix] = num

    seeded = 0
    for prefix, mx in maxes.items():
        target = mx + 1
        seq = db.execute(
            select(LimsNativeIdSequence)
            .where(LimsNativeIdSequence.prefix == prefix)
            .with_for_update()
        ).scalar_one_or_none()
        if seq is None:
            db.add(LimsNativeIdSequence(prefix=prefix, next_value=target))
            seeded += 1
        elif seq.next_value < target:
            seq.next_value = target
            seeded += 1
    db.flush()
    return seeded

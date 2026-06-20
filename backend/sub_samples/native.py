# backend/sub_samples/native.py
"""Model-D cutover helpers for the Receive-Wizard write path (Phase 5d).

The wizard's CREATE behavior is flag-gated (native_create_enabled). Every
SENAITE call site OUTSIDE create — update, delete, reconcile — branches on
per-row provenance instead (is_native_vial), because legacy SENAITE-backed
vials must keep working after the flag flips on.

The `mk1://` prefix on external_lims_uid is the discriminator. It mirrors
the photo_external_uid = "mk1://{key}" precedent established in Phase 2.5,
keeps the NOT NULL UNIQUE constraint satisfied, and stays greppable.

Spec: docs/superpowers/specs/2026-06-02-mk1-native-analyses-design.md
§"SENAITE integration boundary" line 551, §"Migration" lines 565-569.
"""
from __future__ import annotations

import os
import uuid


_NATIVE_UID_PREFIX = "mk1://"


def native_create_enabled() -> bool:
    """Feature flag. Default ON — native (Mk1-only) sub-samples are the intended
    model post-1.0 cutover. Set SUBSAMPLE_NATIVE_CREATE=0 to opt back into the
    legacy SENAITE-secondary dual-write path. (Prod already sets it explicitly
    in backend/.env; this default is belt-and-suspenders for fresh envs.)"""
    return os.environ.get("SUBSAMPLE_NATIVE_CREATE", "1") != "0"


def is_native_vial(sub) -> bool:
    """True iff this sub-sample was created Mk1-native (no SENAITE AR).

    The single source of truth for provenance. Used at every SENAITE call
    site outside create_sub_sample to decide whether to skip the round-trip.
    """
    uid = getattr(sub, "external_lims_uid", None)
    return bool(uid) and uid.startswith(_NATIVE_UID_PREFIX)


def generate_native_uid() -> str:
    """A Mk1-native external_lims_uid. Format: mk1://{uuid4-hex}.

    Satisfies the column's NOT NULL UNIQUE constraint and self-identifies
    as native via the prefix."""
    return f"{_NATIVE_UID_PREFIX}{uuid.uuid4().hex}"


def next_native_sample_id(parent_sample_id: str, vial_sequence: int) -> str:
    """Mk1-generated vial id, byte-identical to SENAITE's format.

    {parent}-S{NN} with NN zero-padded to 2 digits. vial_sequence is the
    value assigned under the parent row lock by _next_vial_sequence, so this
    is collision-free with existing vials (including legacy SENAITE ones)."""
    return f"{parent_sample_id}-S{vial_sequence:02d}"

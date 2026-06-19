"""COA pre-flight blocker accumulation.

generate_sample_coa runs several pre-flight gates before invoking COABuilder:
unresolved analyte sources, missing required attachments (sample image +
chromatogram), and an unlocked variance set. Each used to `raise` on the first
failure, so a lab clearing one blocker would immediately discover the next —
whack-a-mole. These helpers let the endpoint evaluate every gate, accumulate the
applicable blockers, and surface them in ONE 422 so the user sees everything up
front.

Pure (no DB/network): the endpoint computes each gate's result with its own
fail-open/fail-soft posture and passes the results here for assembly.
"""
from __future__ import annotations

from typing import Optional

# Each gate carries `message` (the full, standalone text — identical to the
# pre-aggregation single-gate 422, so a lone blocker is byte-compatible) and
# `summary` (the prefix-free body used when several blockers are combined).
_GENERIC_PREFIX = "COA can't be generated yet."


def unresolved_blocker(unresolved: list[dict]) -> dict:
    lines = "\n".join(
        f"- {u.get('analyte_name') or u.get('analyte_keyword')}: {u.get('reason')}"
        for u in unresolved
    )
    return {
        "code": "unresolved_sources",
        "message": f"{_GENERIC_PREFIX} These results still need a source:\n{lines}",
        "summary": f"These results still need a source:\n{lines}",
        "unresolved": unresolved,
    }


def attachment_blocker(missing: list[dict]) -> dict:
    lines = "\n".join(f"- {m['message']}" for m in missing)
    return {
        "code": "missing_attachments",
        "message": f"{_GENERIC_PREFIX} The sample is missing required attachments:\n{lines}",
        "summary": f"Missing required attachments:\n{lines}",
        "missing": [m["kind"] for m in missing],
    }


def variance_blocker() -> dict:
    return {
        "code": "variance_not_locked",
        "message": (
            "Lock the variance set before generating the COA. Variance was "
            "purchased for this sample — lock the set (all replicate vials "
            "signed off) first."
        ),
        "summary": (
            "Lock the variance set — variance was purchased and the set isn't "
            "locked (all replicate vials must be signed off first)."
        ),
    }


def collect_preflight_blockers(
    *,
    unresolved: Optional[list[dict]] = None,
    missing_attachments: Optional[list[dict]] = None,
    variance_locked_required: bool = False,
) -> list[dict]:
    """Assemble every applicable blocker. Caller passes the already-computed
    gate results (a falsy/empty value means that gate did not block, whether
    because it passed or could not be evaluated). Order mirrors the original
    gate evaluation order: sources, attachments, variance."""
    blockers: list[dict] = []
    if unresolved:
        blockers.append(unresolved_blocker(unresolved))
    if missing_attachments:
        blockers.append(attachment_blocker(missing_attachments))
    if variance_locked_required:
        blockers.append(variance_blocker())
    return blockers


def build_preflight_error(blockers: list[dict]) -> dict:
    """The HTTPException(422) detail for a set of pre-flight blockers.

    One blocker -> the gate's specific code + its own full message (identical to
    the old single-gate 422). Several -> a generic code and a combined message
    listing every blocker, so nothing is hidden. `blockers` is always included
    for clients that want structured handling.
    """
    if len(blockers) == 1:
        b = blockers[0]
        return {"code": b["code"], "message": b["message"], "blockers": blockers}
    combined = "\n\n".join(b["summary"] for b in blockers)
    return {
        "code": "coa_preflight_blocked",
        "message": (
            f"{_GENERIC_PREFIX} Resolve all of the following before "
            f"generating:\n\n{combined}"
        ),
        "blockers": blockers,
    }

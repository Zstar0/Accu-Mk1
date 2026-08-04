"""Sample-details parity harness (read-flip Layer 4 / Task 5) -- the artifact
the Handler uses to decide the mk1/senaite read-source flip.

Fetches BOTH sample-details reads for the same sample IDs -- the native mk1
path (`build_native_details` / `GET /registry/sample/{id}/details`) and the
SENAITE path (`lookup_senaite_sample` / `GET /wizard/senaite/lookup`) -- and
classifies every field-level difference as one of:

    equal | known_expected | differing | mk1_only | senaite_only

`differing` / `mk1_only` / `senaite_only` (and the analyses-specific
`analyses_mk1_only` / `analyses_senaite_only`) are REAL diffs: something an
operator should look at before flipping the read source. `known_expected`
diffs are real bytes-on-the-wire differences too, but ones this program
already understands and names -- see KNOWN-EXPECTED RULES below. Nothing is
ever silently hidden: every diff, known or not, is a line in the report.

Run modes
---------
HTTP mode (the default; talks to a running backend):

    docker exec -w /app -i <backend-container> python -m \
        scripts.parity_sample_details --samples P-0001,P-0002 \
        --base-url http://localhost:8000 --out /tmp/parity.json

    MK1_PARITY_TOKEN must be set in the environment -- a bearer token for
    both `/registry/sample/{id}/details` (get_current_user) and
    `/wizard/senaite/lookup` (also get_current_user). Same auth model as
    every other authenticated route; no elevated privilege needed (both
    reads are already user-visible sample-detail projections).

In-process mode (stack/UAT; no HTTP round trip, needs SENAITE env):

    docker exec -w /app -i <backend-container> python -m \
        scripts.parity_sample_details --limit 25 --in-process \
        --out /tmp/parity.json

    Calls `build_native_details(db, sample_id)` directly for the mk1 side,
    and `main.lookup_senaite_sample(id=..., no_cache=True, db=db,
    _current_user=None)` directly for the senaite side (via `asyncio.run` --
    it's the real `async def` route function, called outside FastAPI's
    request cycle so its `Depends(...)` defaults are simply overridden by
    the explicit keyword args here).

Sample selection: `--samples P-0001,P-0002` (explicit) OR `--limit N`
(newest N rows from `lims_samples`, ordered by id desc) -- exactly one of
the two. `--limit` needs DB access even in HTTP mode (to pick which IDs to
hit), same as `--in-process`; run this script inside the backend container
either way, matching every sibling script in this directory.

KNOWN-EXPECTED RULES
---------------------
Provenance: 3 classes named by the L4/Task5 brief itself (remarks_native_
both, mi_blank_after_retest, attachment_mk1att_uids), 6 by Task 2's builder
report (`.superpowers/sdd/task-l4-2-report.md` "Notes for downstream tasks":
published_coa_senaite_era, senaite_url_unavailable, profiles_empty_native,
attachment_mk1att_uids [overlapping the brief's], analytes_defaults,
coa_chromatograph_background_url), 3 added at build/review time
(cached_at_timestamps, analyses_uid_shape, attachment_native_download_route),
and 2 added at registry-stack UAT (datetime_serialization,
analyst_attribution) -- each justified where it's defined below:

  published_coa_senaite_era   -- `published_coa` is always None in mk1 mode
                                  (SENAITE-era artifact; coordinator ruling,
                                  Task 2 note 1).
  senaite_url_unavailable     -- `senaite_url` is always None in mk1 mode
                                  (client FOLDER id not stored; Task 2 note 2).
  profiles_empty_native       -- `profiles` is always [] in mk1 mode (no
                                  registry column; Task 2 note 3).
  attachment_mk1att_uids      -- per-attachment `uid` differs in SHAPE
                                  (`mk1att:{id}` vs a SENAITE attachment uid)
                                  where filename+content_type match (Task 2
                                  note 4). `attachment_type` is NOT covered
                                  and surfaces as a real diff; `download_url`
                                  has its own shape-gated rule (see
                                  attachment_native_download_route below).
  attachment_native_download_route -- a paired attachment's `download_url`
                                  differs AND the mk1 side's URL is THIS
                                  sample's native download route
                                  (`/registry/sample/{sample_id}/attachments/
                                  {id}/download`, matched against the actual
                                  sample id). Structural for every s3-frozen
                                  capture: mk1 serves its frozen copy
                                  natively, senaite points at the proxy --
                                  without this rule --strict could never pass
                                  on a post-deploy sample. Gated on the mk1
                                  URL's SHAPE only: NOT on the pairing key
                                  (would blanket-suppress, hiding malformed
                                  URLs) and NOT on the uid rule having fired
                                  (backfill adoption can equalize uids while
                                  download_url still legitimately diverges).
                                  A native-looking URL embedding the WRONG
                                  sample id stays a REAL diff. Reviewer-added
                                  (task-l4-5 review round).
  analytes_defaults           -- per-analyte `matched_peptide_id` /
                                  `matched_peptide_name` are None in mk1 mode
                                  (no fuzzy match at build time), and
                                  `slot_number` may differ from SENAITE's
                                  when SENAITE had gaps in analyte slots
                                  (Task 2 note 5).
  mi_blank_after_retest       -- per-analysis-line `method` / `method_uid` /
                                  `instrument` / `instrument_uid` are None on
                                  the mk1 side (L1 ownership: M/I fields go
                                  blank across a retest on the native side
                                  before the next result capture).
  remarks_native_both         -- DOCUMENTED, NEVER FIRES. Both read paths
                                  have sourced remarks from `lims_sample_
                                  remarks` since L2 (f4d3bcf / 7d1c935) --
                                  remarks are supposed to already be equal.
                                  Listed here so a reviewer knows this class
                                  was considered, not forgotten; a remarks
                                  diff in the report is always REAL.
  coa_chromatograph_background_url -- `coa.chromatograph_background_url` is
                                  always None in mk1 mode (never persisted;
                                  Task 2 note 6).
  cached_at_timestamps         -- `cached_at` always differs (two independent
                                  `datetime.now()` calls); always known-
                                  expected, ignored in the strict gate.
  datetime_serialization       -- both sides are ISO-8601 strings for the
                                  SAME instant, serialized differently: mk1
                                  emits naive UTC (`2026-05-05T01:33:15`),
                                  SENAITE emits an explicit offset
                                  (`2026-05-04T18:33:15-07:00` /
                                  `...+00:00`). Applies at any leaf (fired in
                                  practice by date_received/date_sampled).
                                  Two strings whose instants DIFFER stay a
                                  REAL diff. Discovered at registry-stack UAT
                                  (first live parity run, 2026-07-14): every
                                  sample carried 1-2 of these, which would
                                  have made --strict permanently red.
  analyst_attribution          -- per-analysis-line `analyst` lives in two
                                  attribution spaces that can never agree:
                                  mk1 stamps analyst_user_id from WORKSHEET
                                  membership (2026-06-07 spec) and serves the
                                  user's email; SENAITE records its own
                                  username -- the actual operator ('Forrest')
                                  or the API service account ('admin') that
                                  pushed the result. Same phenomenon class as
                                  analyses_uid_shape: even "the same" person
                                  is 'forrest@...' on one side and 'Forrest'
                                  on the other, and senaite-era rows were
                                  never worksheet-stamped natively (mk1
                                  None). String equality still wins when it
                                  happens (equal short-circuits every rule).
                                  Discovered at registry-stack UAT alongside
                                  datetime_serialization.

  analyses_uid_shape           -- per-analysis-line `uid` differs in SHAPE
                                  (mk1's `mk1:{lims_analyses.id}` vs SENAITE's
                                  opaque hex uid) for a keyword-matched line.
                                  Required by the dispatch's "Analyses
                                  comparison" contract bullet ("uid shape
                                  differences ... = known-expected") but never
                                  given a rule id in any named list -- same
                                  phenomenon as attachment_mk1att_uids,
                                  different list. ALSO applied to
                                  `method_uid` / `instrument_uid` when both
                                  sides are populated but differ: mk1 stores
                                  str(HplcMethod.id) / str(Instrument.id) (an
                                  internal integer PK), senaite stores its
                                  own Zope object uid -- two id spaces that
                                  can never agree even for "the same"
                                  method/instrument. Discovered empirically
                                  while TDD-ing mi_blank_after_retest: a
                                  populated-but-mismatched *_uid pair is NOT
                                  the blank case the brief named, but IS the
                                  exact same shape-mismatch phenomenon as the
                                  line uid, so it rides the same rule rather
                                  than going unclassified on every single run.

Fault isolation: in HTTP / in-process mode, one sample's failed fetch logs a
warning, lands in the report's `fetch_errors` list, and the run CONTINUES to
a partial report -- never a lost run.

Exit code: 0 unless `--strict` is passed AND (at least one REAL (non-
known-expected, non-equal) diff exists anywhere in the run, OR at least one
sample's fetch failed -- a partial run is not a clean run), in which case 1.
Report-only by default -- this script never writes anything, so a nonzero
exit under `--strict` is purely a "go look" signal, not a failure state.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from collections import Counter, deque
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Optional

# Make the /app package root importable when run as a file (python -m from
# /app makes this a no-op) -- same shim as every sibling script.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sub_samples.lookup_models import SenaiteCOAInfo, SenaiteLookupResult

log = logging.getLogger("parity_sample_details")

TRUNCATE_LEN = 500

# ─── Field inventory (driven off the pydantic model, never hand-listed) ────
# RegistrySampleReadResult-only scaffolding fields never appear in the
# senaite payload at all -- they describe the mk1 response's OWN provenance,
# not sample data, so they are not parity subjects.
_META_ONLY_FIELDS = frozenset({"read_source", "registry_missing", "field_sources"})
# Fields with bespoke list/dict comparators below (everything else is
# compared as an opaque scalar value).
LIST_COMPARATOR_FIELDS = frozenset({"analytes", "coa", "remarks", "analyses", "attachments"})
SCALAR_FIELDS = tuple(sorted(
    set(SenaiteLookupResult.model_fields) - LIST_COMPARATOR_FIELDS
))
ALL_COMPARED_FIELDS = frozenset(SCALAR_FIELDS) | LIST_COMPARATOR_FIELDS
_COA_SUBFIELDS = tuple(sorted(SenaiteCOAInfo.model_fields))

REAL_CLASSIFICATIONS = frozenset({
    "differing", "mk1_only", "senaite_only",
    "analyses_mk1_only", "analyses_senaite_only",
})


# ─── Core classification (unit-tested; no I/O) ─────────────────────────────

@dataclass
class FieldDiff:
    path: str
    classification: str
    rule_id: Optional[str] = None
    mk1_value: Any = None
    senaite_value: Any = None

    @property
    def is_real(self) -> bool:
        return self.classification in REAL_CLASSIFICATIONS


def _is_blank(v: Any) -> bool:
    """None or an empty list/dict -- the shape a field takes when the mk1
    side simply never populates it (profiles, published_coa, coa subfields,
    M/I fields, ...)."""
    return v is None or v == [] or v == {}


def _as_utc_instant(v: Any) -> Optional[datetime]:
    """ISO-8601 string -> aware UTC instant, else None. Naive strings are
    UTC by definition here (build_native_details serializes naive-UTC DB
    values); SENAITE serializes the same instant with an explicit offset."""
    if not isinstance(v, str) or len(v) < 10:
        return None
    try:
        dt = datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def classify_raw(mk1v: Any, senaitev: Any) -> str:
    """The four-way base classification, before any known-expected rule is
    consulted: equal / differing / mk1_only / senaite_only."""
    if mk1v == senaitev:
        return "equal"
    mk1_blank = _is_blank(mk1v)
    senaite_blank = _is_blank(senaitev)
    if mk1_blank and not senaite_blank:
        return "senaite_only"
    if senaite_blank and not mk1_blank:
        return "mk1_only"
    return "differing"


# path -> (mk1v, senaitev) -> rule_id | None. Only consulted when the raw
# classification is NOT already "equal".
_TOP_LEVEL_RULES: dict[str, Callable[[Any, Any], Optional[str]]] = {
    "published_coa": lambda mk1v, sv: "published_coa_senaite_era" if _is_blank(mk1v) else None,
    "senaite_url": lambda mk1v, sv: "senaite_url_unavailable" if _is_blank(mk1v) else None,
    "profiles": lambda mk1v, sv: "profiles_empty_native" if _is_blank(mk1v) else None,
    "cached_at": lambda mk1v, sv: "cached_at_timestamps",
    # contact_fullname_senaite_doubling: SENAITE stores the Contacts IS creates
    # with Firstname == Lastname == the COA company name, so its Fullname
    # getter returns "X X" while mk1 holds the clean single value from the IS
    # creation signal (and collapses it on refresh -- see
    # sub_samples.service._collapse_self_doubled). mk1 is AUTHORITATIVE here;
    # the two sides can never agree. Gated on an EXACT doubling of the mk1
    # value, never on "contact differs" -- a genuinely wrong contact must stay
    # a REAL diff.
    "contact": lambda mk1v, sv: (
        "contact_fullname_senaite_doubling"
        if isinstance(mk1v, str) and isinstance(sv, str)
        and mk1v.strip() and sv.strip() == f"{mk1v.strip()} {mk1v.strip()}"
        else None
    ),
}

_COA_RULES: dict[str, Callable[[Any, Any], Optional[str]]] = {
    "chromatograph_background_url": lambda mk1v, sv: (
        "coa_chromatograph_background_url" if _is_blank(mk1v) else None
    ),
}

# slot_number is ALWAYS an int (never blank) so it needs an unconditional
# rule -- gating on _is_blank would never fire. matched_peptide_id/name are
# ALWAYS None on the mk1 side (no fuzzy match at build time, Task 2 note 5)
# so they're gated on mk1-blank, matching the documented "=None" semantic.
_ANALYTE_UNCONDITIONAL_SUBFIELDS = frozenset({"slot_number"})
_ANALYTE_BLANK_GATED_SUBFIELDS = frozenset({"matched_peptide_id", "matched_peptide_name"})
# method/instrument are human-readable TITLE strings -- blank on mk1 (post-
# retest, L1 ownership) is known-expected, but a genuine title MISMATCH
# between two populated values is a real data-integrity concern, not swept
# away.
_ANALYSIS_MI_TITLE_SUBFIELDS = frozenset({"method", "instrument"})
# method_uid/instrument_uid are ID references, but the two sides live in
# DIFFERENT id spaces even when both are populated: mk1 stores
# str(HplcMethod.id) / str(Instrument.id) (an internal integer PK), senaite
# stores its own Zope object uid (opaque hex) -- see lims_analyses/service.py
# ~2139/2142. Blank-on-mk1 is mi_blank_after_retest; POPULATED-but-different
# is the same "mk1: vs SENAITE hex" shape mismatch as the analysis line's
# own `uid` field (analyses_uid_shape) -- never a real diff, the two sides
# fundamentally cannot agree on a shared id space for the same method.
_ANALYSIS_MI_UID_SUBFIELDS = frozenset({"method_uid", "instrument_uid"})
# SENAITE-side values that are PLACEHOLDERS rather than a real method or
# instrument. When SENAITE carries one of these and mk1 carries a real
# catalog-backed value, mk1 is strictly richer and the two can never agree
# (L1 ownership: method_id/instrument_id are Mk1-owned).
#
# Deliberately a placeholder ALLOWLIST, not "any populated mismatch". Measured
# on the prod published cohort 2026-07-25, the 93 populated M/I mismatches were
# NOT one phenomenon:
#   71  senaite='Manual'              -> placeholder, mk1 richer      (ruled here)
#   17  senaite='MET-HPLC-ID-1290A'   -> a REAL competing method      (stays REAL)
#    5  mk1='HPLC 1290b' vs senaite='HPLC 1290a' -> two REAL instruments
#                                        in conflict                 (stays REAL)
# Blanket-suppressing "populated mismatch" would have buried those last 22 --
# genuine data-integrity questions about which method/instrument actually ran.
_SENAITE_MI_PLACEHOLDERS = frozenset({"Manual"})


def _diff_leaf(path: str, mk1v: Any, senaitev: Any,
               rule_fn: Optional[Callable[[Any, Any], Optional[str]]] = None) -> FieldDiff:
    """Shared leaf-field classify: raw class, then an optional known-expected
    override. `rule_fn` is only invoked when the raw class isn't already
    equal."""
    raw = classify_raw(mk1v, senaitev)
    if raw == "equal":
        return FieldDiff(path, "equal")
    mk1_instant = _as_utc_instant(mk1v)
    if mk1_instant is not None and mk1_instant == _as_utc_instant(senaitev):
        return FieldDiff(path, "known_expected", "datetime_serialization", mk1v, senaitev)
    rule_id = rule_fn(mk1v, senaitev) if rule_fn else None
    if rule_id:
        return FieldDiff(path, "known_expected", rule_id, mk1v, senaitev)
    return FieldDiff(path, raw, None, mk1v, senaitev)


def diff_scalar_field(path: str, mk1v: Any, senaitev: Any) -> FieldDiff:
    return _diff_leaf(path, mk1v, senaitev, _TOP_LEVEL_RULES.get(path))


def diff_coa(mk1_coa: dict, senaite_coa: dict) -> list[FieldDiff]:
    mk1_coa = mk1_coa or {}
    senaite_coa = senaite_coa or {}
    return [
        _diff_leaf(f"coa.{sub}", mk1_coa.get(sub), senaite_coa.get(sub), _COA_RULES.get(sub))
        for sub in _COA_SUBFIELDS
    ]


def _strip_method_suffix_local(name: str) -> str:
    """Mirrors main.py's `_strip_method_suffix` regex exactly (kept local so
    this module doesn't need to import all of main.py just for a 2-line
    regex -- see module docstring on lazy in-process imports)."""
    import re
    return re.sub(r"\s*-\s*[^-]+\([^)]+\)\s*$", "", name or "").strip()


def _normalize_analyte_key(raw_name: Optional[str]) -> str:
    """mk1's raw_name is the registry's bare stored label; senaite's raw_name
    is the UNSTRIPPED SENAITE analyte string (e.g. 'BPC-157 - Identity
    (HPLC)') -- match on the stripped, case-folded form so a suffixed
    senaite name still pairs with its mk1 counterpart."""
    return _strip_method_suffix_local(raw_name or "").casefold()


def _pair_lists(mk1_list: list[dict], senaite_list: list[dict],
                 key_fn: Callable[[dict], Any]) -> tuple[list[tuple[dict, dict]], list[dict], list[dict]]:
    """Order-insensitive pairing by key_fn. Duplicate keys are matched
    first-come/first-served (a multiset match, not a perfect one) -- good
    enough for a parity harness; true duplicate-key collisions are rare and
    would show up as extra one-side-only entries if the counts don't align."""
    senaite_by_key: dict[Any, deque] = {}
    for item in senaite_list:
        senaite_by_key.setdefault(key_fn(item), deque()).append(item)
    pairs: list[tuple[dict, dict]] = []
    mk1_only: list[dict] = []
    for item in mk1_list:
        bucket = senaite_by_key.get(key_fn(item))
        if bucket:
            pairs.append((item, bucket.popleft()))
        else:
            mk1_only.append(item)
    senaite_only = [item for bucket in senaite_by_key.values() for item in bucket]
    return pairs, mk1_only, senaite_only


def diff_analytes(mk1_list: list[dict], senaite_list: list[dict]) -> list[FieldDiff]:
    pairs, mk1_only, senaite_only = _pair_lists(
        mk1_list or [], senaite_list or [],
        key_fn=lambda a: _normalize_analyte_key(a.get("raw_name")),
    )
    out: list[FieldDiff] = []
    for mk1_item, sen_item in pairs:
        label = mk1_item.get("raw_name") or "?"
        for sub in ("slot_number", "matched_peptide_id", "matched_peptide_name", "declared_quantity"):
            if sub in _ANALYTE_UNCONDITIONAL_SUBFIELDS:
                rule_fn = lambda mk1v, sv: "analytes_defaults"
            elif sub in _ANALYTE_BLANK_GATED_SUBFIELDS:
                rule_fn = lambda mk1v, sv: "analytes_defaults" if _is_blank(mk1v) else None
            else:
                rule_fn = None
            out.append(_diff_leaf(f"analytes[{label}].{sub}", mk1_item.get(sub), sen_item.get(sub), rule_fn))
    for item in mk1_only:
        out.append(FieldDiff(f"analytes[{item.get('raw_name')}]", "mk1_only", None, item, None))
    for item in senaite_only:
        out.append(FieldDiff(f"analytes[{item.get('raw_name')}]", "senaite_only", None, None, item))
    return out


def _native_download_route_rule(sample_id: str) -> Callable[[Any, Any], Optional[str]]:
    """attachment_native_download_route: a paired attachment's download_url
    diff is known-expected IFF the mk1 side's URL is THIS sample's native
    download route (`/registry/sample/{sample_id}/attachments/{id}/download`
    -- the exact sample id, not just any). That divergence is structural for
    every s3-frozen capture post-deploy: mk1 serves its frozen copy natively
    while senaite points at the proxy, so without this rule --strict could
    never pass on a post-deploy sample.

    Deliberately gated on the mk1 URL's SHAPE, not on the pairing key
    (filename+content_type -- that would blanket-suppress and hide a
    malformed/mispointed URL) and not on the uid-shape rule having fired
    (backfill adoption can equalize uids while download_url still
    legitimately diverges). A native-looking URL embedding the WRONG sample
    id does NOT match and stays a REAL diff."""
    import re
    pattern = re.compile(
        rf"^/registry/sample/{re.escape(sample_id)}/attachments/\d+/download$"
    )
    def rule(mk1v: Any, sv: Any) -> Optional[str]:
        if isinstance(mk1v, str) and pattern.match(mk1v):
            return "attachment_native_download_route"
        return None
    return rule


# SENAITE serializes CSVs as the legacy 'text/comma-separated-values' while
# native capture stores the modern 'text/csv' — same actual type, so pairing
# on the raw string splits one dual-written chromatogram into a false
# mk1_only + senaite_only pair (UAT catch, P-0143 chromatogram push).
_CONTENT_TYPE_SYNONYMS = {"text/comma-separated-values": "text/csv"}


def _normalize_content_type(ct: Optional[str]) -> Optional[str]:
    if ct is None:
        return None
    ct = ct.strip().casefold()
    return _CONTENT_TYPE_SYNONYMS.get(ct, ct)


# mk1 emits this prefix for a capture-time row SENAITE has not adopted yet
# (registry_details.py: `uid=a.senaite_attachment_uid or f"mk1att:{a.id}"`).
_MK1ATT_UID_PREFIX = "mk1att:"


def _senaite_attachment_uid(a: dict) -> Optional[str]:
    """The SENAITE attachment uid carried by an attachment dict, or None.

    None means "this side has no SENAITE uid to join on" — either the field is
    absent/blank, or mk1 emitted its `mk1att:{id}` placeholder because
    senaite_attachment_uid is still NULL on that row (capture-time rows stay
    uid-less until the backfill sweep adopts them)."""
    uid = a.get("uid")
    if not isinstance(uid, str):
        return None
    uid = uid.strip()
    if not uid or uid.startswith(_MK1ATT_UID_PREFIX):
        return None
    return uid


def _pair_attachments(mk1_list: list[dict], senaite_list: list[dict],
                      ) -> tuple[list[tuple[dict, dict]], list[dict], list[dict]]:
    """Pair attachments on the SENAITE uid FIRST, then fall back to
    (filename, content_type).

    Filename is NOT unique: vial-photo retakes are frozen snapshots by design,
    so one parent AR legitimately holds several attachments sharing a filename
    AND content_type. The plain first-come/first-served fallback then CROSSES
    them — each side's attachment compared against a different one. Live case
    P-1522 (2026-07-25): two `P-1522-S01-vial-photo.jpg` rows produced a
    phantom `download_url` diff (both URLs real, just swapped) while the
    equally-crossed `uid` diffs were absorbed by the blanket
    attachment_mk1att_uids rule and never surfaced.

    The uid is an exact join, so it runs first and only where BOTH sides carry
    one. The filename fallback still covers capture-time rows whose
    senaite_attachment_uid is NULL — which is the majority — so this strictly
    improves pairing rather than replacing it."""
    senaite_by_uid: dict[str, deque] = {}
    for idx, item in enumerate(senaite_list):
        uid = _senaite_attachment_uid(item)
        if uid is not None:
            senaite_by_uid.setdefault(uid, deque()).append(idx)

    pairs: list[tuple[dict, dict]] = []
    consumed: set[int] = set()
    mk1_rest: list[dict] = []
    for item in mk1_list:
        uid = _senaite_attachment_uid(item)
        bucket = senaite_by_uid.get(uid) if uid is not None else None
        if bucket:
            idx = bucket.popleft()
            consumed.add(idx)
            pairs.append((item, senaite_list[idx]))
        else:
            mk1_rest.append(item)

    senaite_rest = [item for i, item in enumerate(senaite_list)
                    if i not in consumed]

    fallback_pairs, mk1_only, senaite_only = _pair_lists(
        mk1_rest, senaite_rest,
        key_fn=lambda a: ((a.get("filename") or "").strip().casefold(),
                          _normalize_content_type(a.get("content_type"))),
    )
    return pairs + fallback_pairs, mk1_only, senaite_only


def diff_attachments(mk1_list: list[dict], senaite_list: list[dict],
                     sample_id: str) -> list[FieldDiff]:
    pairs, mk1_only, senaite_only = _pair_attachments(
        mk1_list or [], senaite_list or [])
    download_url_rule = _native_download_route_rule(sample_id)
    out: list[FieldDiff] = []
    for mk1_item, sen_item in pairs:
        label = mk1_item.get("filename") or "?"
        for sub in ("uid", "attachment_type", "download_url"):
            if sub == "uid":
                rule_fn = lambda mk1v, sv: "attachment_mk1att_uids"
            elif sub == "download_url":
                rule_fn = download_url_rule
            elif sub == "attachment_type":
                # attachment_type_native_only: mk1 records the capture's type
                # ('HPLC Graph', 'Sample Image') while SENAITE leaves the paired
                # attachment's type BLANK. mk1 is strictly richer here and
                # SENAITE offers no competing value, so the two can never agree.
                # Gated on the SENAITE side being blank -- if SENAITE ever does
                # carry a type and the two DISAGREE, that is a real diff and
                # stays one.
                rule_fn = lambda mk1v, sv: (
                    "attachment_type_native_only" if _is_blank(sv) else None
                )
            else:
                rule_fn = None
            out.append(_diff_leaf(f"attachments[{label}].{sub}", mk1_item.get(sub), sen_item.get(sub), rule_fn))
    for item in mk1_only:
        out.append(FieldDiff(f"attachments[{item.get('filename')}]", "mk1_only", None, item, None))
    for item in senaite_only:
        out.append(FieldDiff(f"attachments[{item.get('filename')}]", "senaite_only", None, None, item))
    return out


def _canonical_publish_rule(sample_published: bool) -> Callable[[Any, Any], Optional[str]]:
    """canonical_verified_vs_senaite_published: on a PUBLISHED sample, a
    canonical parent line reads 'verified' in mk1 where SENAITE reads
    'published'.

    That is by design, not lag. Publishing a sample flips the SENAITE-mirror
    SHADOW rows to mirror_review_state='published' (mark_parent_shadows_
    published), while the CANONICAL row -- the one the native builder surfaces
    -- keeps its own state. Measured on prod 2026-07-25, analyses of published
    samples were 7577 shadow / 2832 canonical-'verified' / 28 retracted:
    ZERO canonical rows have ever reached 'published', so 'verified' IS the
    canonical terminal state and surfacing it is correct.

    GATED on the mk1 sample itself already being published. That gate is the
    whole point: an analysis still sitting at 'verified' while its sample is
    NOT yet published is genuine publish lag, and stays a REAL diff. Only the
    exact by-design pair is suppressed -- any other state combination
    ('unassigned' vs 'published', 'retracted' vs 'published', ...) is
    untouched.

    canonical_parent_to_verify_vs_senaite_verified (Task 8 / R1,
    2026-08-04): a native promote (Task 3) mints the canonical parent-tier
    row directly into 'parent_to_verify' -- submission, not sign-off; the
    Mk1-side verify action is a SEPARATE explicit step. When the source
    result being promoted was itself already verified on the SENAITE side, a
    SENAITE-origin promote yields SENAITE line 'verified' while the freshly-
    minted mk1 canonical row awaits that separate sign-off.

    GATED on the mk1 sample NOT yet being published -- the mirror image of
    the gate above. An in-flight parent line awaiting its own Mk1-side
    verify sign-off is unremarkable (structural consequence of Task 3's
    submit/verify split; the shadow engine's all_analyses_in_state gates
    already collapse 'parent_to_verify' to 'to_be_verified' for the SAME
    reason, see workflow/engine.py _live_parent_line_states). But a line
    still sitting in 'parent_to_verify' on an ALREADY-published sample is a
    genuinely open question, not swept: parent_to_verify rows never resolve
    as a COA source (test_coa_source_resolver_integration.py::test_resolve_
    sources_mk1_parent_to_verify_row_does_not_resolve), so an already-
    published sample carrying one for a keyword the COA cites is exactly the
    kind of thing the read-flip Handler needs to see, not a by-design
    non-diff. Only this EXACT pair is suppressed, and only pre-publish --
    'parent_to_verify' against any other SENAITE state, or against
    'verified' post-publish, stays a REAL diff.
    """
    def rule(mk1v: Any, sv: Any) -> Optional[str]:
        if sample_published:
            if mk1v == "verified" and sv == "published":
                return "canonical_verified_vs_senaite_published"
            return None
        if mk1v == "parent_to_verify" and sv == "verified":
            return "canonical_parent_to_verify_vs_senaite_verified"
        return None
    return rule


def diff_analyses(mk1_list: list[dict], senaite_list: list[dict], *,
                  sample_published: bool = False) -> list[FieldDiff]:
    """Match lines by keyword (order-insensitive). Lines present on only one
    side are REAL diffs classified `analyses_mk1_only` / `analyses_senaite_
    only` (not the generic mk1_only/senaite_only -- brief-mandated naming so
    the human summary reads unambiguously)."""
    pairs, mk1_only, senaite_only = _pair_lists(
        mk1_list or [], senaite_list or [],
        key_fn=lambda a: (a.get("keyword") or "").strip().casefold(),
    )
    publish_rule = _canonical_publish_rule(sample_published)
    out: list[FieldDiff] = []
    for mk1_item, sen_item in pairs:
        label = mk1_item.get("keyword") or "?"
        for sub in ("uid", "result", "unit", "review_state", "analyst",
                    "method", "method_uid", "instrument", "instrument_uid"):
            if sub == "uid":
                rule_fn = lambda mk1v, sv: "analyses_uid_shape"
            elif sub in _ANALYSIS_MI_UID_SUBFIELDS:
                rule_fn = lambda mk1v, sv: (
                    "mi_blank_after_retest" if _is_blank(mk1v) else "analyses_uid_shape"
                )
            elif sub in _ANALYSIS_MI_TITLE_SUBFIELDS:
                # Populated-vs-populated title conflicts are gated known-
                # expected BY HANDLER DECISION (2026-07-25: accepted as a
                # known ISO-traceability finding to repair later; 2026-07-28:
                # "mark green — nothing reads these mk1-side yet, right
                # values get established later"). This DELIBERATELY swallows
                # real competing values (e.g. mk1 'Method 7' vs SENAITE
                # 'MET-HPLC-ID-1290A', 'HPLC 1290b' vs 'HPLC 1290a') — the
                # deferred worklist lives in the vault (2026-07-28 session
                # log) and in /tmp/p_pub_0728.json. Remove this fallback when
                # the catalog-driven M/I repair lands.
                rule_fn = lambda mk1v, sv: (
                    "mi_blank_after_retest" if _is_blank(mk1v)
                    else "mi_senaite_placeholder"
                    if isinstance(sv, str) and sv.strip() in _SENAITE_MI_PLACEHOLDERS
                    else "mi_populated_conflict_accepted"
                )
            elif sub == "review_state":
                rule_fn = publish_rule
            elif sub == "analyst":
                rule_fn = lambda mk1v, sv: "analyst_attribution"
            else:
                rule_fn = None
            out.append(_diff_leaf(f"analyses[{label}].{sub}", mk1_item.get(sub), sen_item.get(sub), rule_fn))
    for item in mk1_only:
        out.append(FieldDiff(f"analyses[{item.get('keyword')}]", "analyses_mk1_only", None, item, None))
    for item in senaite_only:
        out.append(FieldDiff(f"analyses[{item.get('keyword')}]", "analyses_senaite_only", None, None, item))
    return out


def diff_remarks(mk1_list: list[dict], senaite_list: list[dict]) -> list[FieldDiff]:
    """Both read paths source remarks from `lims_sample_remarks` since L2 --
    they SHOULD already be identical. No known-expected rule ever fires here
    (remarks_native_both is documented-but-inert, see module docstring): a
    difference is always REAL."""
    mk1_list = mk1_list or []
    senaite_list = senaite_list or []
    raw = classify_raw(mk1_list, senaite_list)
    if raw == "equal":
        return [FieldDiff("remarks", "equal")]
    return [FieldDiff("remarks", raw, None, mk1_list, senaite_list)]


def compare_sample(mk1: dict, senaite: dict) -> list[FieldDiff]:
    """The full per-sample diff: every field in SenaiteLookupResult (minus
    the mk1-only scaffolding fields), classified."""
    out: list[FieldDiff] = []
    for path in SCALAR_FIELDS:
        out.append(diff_scalar_field(path, mk1.get(path), senaite.get(path)))
    out.extend(diff_coa(mk1.get("coa"), senaite.get("coa")))
    out.extend(diff_analytes(mk1.get("analytes"), senaite.get("analytes")))
    # sample_id for the native-download-route rule: the mk1 payload's own
    # sample_id (falling back to senaite's -- they're the same sample).
    out.extend(diff_attachments(
        mk1.get("attachments"), senaite.get("attachments"),
        sample_id=str(mk1.get("sample_id") or senaite.get("sample_id") or ""),
    ))
    out.extend(diff_analyses(
        mk1.get("analyses"), senaite.get("analyses"),
        # The gate for canonical_verified_vs_senaite_published -- mk1's OWN
        # view of whether this sample is published.
        sample_published=(mk1.get("review_state") == "published"),
    ))
    out.extend(diff_remarks(mk1.get("remarks"), senaite.get("remarks")))
    return out


# ─── Report assembly ────────────────────────────────────────────────────────

def _truncate(value: Any) -> Any:
    s = str(value)
    return s if len(s) <= TRUNCATE_LEN else s[:TRUNCATE_LEN] + "...(truncated)"


def build_report(pairs: list[tuple[str, dict, dict]],
                 fetch_errors: Optional[list[dict]] = None) -> dict:
    """pairs: [(sample_id, mk1_payload, senaite_payload), ...]. Pure function
    of already-fetched data -- no I/O here, so it's directly unit-testable.
    fetch_errors: [{"sample_id": ..., "error": ...}] for samples whose fetch
    failed -- carried into the report so a partial run is visibly partial."""
    fetch_errors = fetch_errors or []
    samples = []
    field_counts: Counter = Counter()
    rule_counts: Counter = Counter()
    real_diff_sample_count = 0

    for sample_id, mk1, senaite in pairs:
        diffs = compare_sample(mk1 or {}, senaite or {})
        sample_fields = []
        real_diffs_here = 0
        for d in diffs:
            field_counts[d.classification] += 1
            if d.rule_id:
                rule_counts[d.rule_id] += 1
            entry = {"path": d.path, "classification": d.classification}
            if d.rule_id:
                entry["rule_id"] = d.rule_id
            if d.is_real:
                real_diffs_here += 1
                entry["mk1_value"] = _truncate(d.mk1_value)
                entry["senaite_value"] = _truncate(d.senaite_value)
            sample_fields.append(entry)
        if real_diffs_here:
            real_diff_sample_count += 1
        samples.append({
            "sample_id": sample_id,
            "real_diff_count": real_diffs_here,
            "fields": sample_fields,
        })

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "sample_count": len(pairs),
        "real_diff_sample_count": real_diff_sample_count,
        "fetch_error_count": len(fetch_errors),
        "fetch_errors": fetch_errors,
        "field_classification_counts": dict(sorted(field_counts.items())),
        "known_expected_rule_counts": dict(sorted(rule_counts.items())),
        "samples": samples,
    }


def print_summary(report: dict) -> None:
    print(f"parity run: {report['sample_count']} sample(s), "
          f"{report['real_diff_sample_count']} with REAL (unclassified) diffs, "
          f"{report['fetch_error_count']} fetch error(s)")
    for fe in report["fetch_errors"]:
        print(f"  FETCH ERROR {fe['sample_id']}: {fe['error']}")
    print(f"  field classifications: {report['field_classification_counts']}")
    if report["known_expected_rule_counts"]:
        print(f"  known-expected rules fired: {report['known_expected_rule_counts']}")
    for sample in report["samples"]:
        if sample["real_diff_count"] == 0:
            continue
        print(f"  {sample['sample_id']}: {sample['real_diff_count']} REAL diff(s)")
        for entry in sample["fields"]:
            if entry["classification"] not in REAL_CLASSIFICATIONS:
                continue
            print(f"    [{entry['classification']}] {entry['path']}: "
                  f"mk1={entry.get('mk1_value')!r} senaite={entry.get('senaite_value')!r}")


# ─── Fetch modes (I/O; not exercised by the unit tests) ────────────────────

def resolve_sample_ids(db_factory, *, samples: Optional[str], limit: Optional[int]) -> list[str]:
    if samples:
        return [s.strip() for s in samples.split(",") if s.strip()]
    from sqlalchemy import select
    from models import LimsSample
    db = db_factory()
    try:
        rows = db.execute(
            select(LimsSample.sample_id).order_by(LimsSample.id.desc()).limit(limit)
        ).all()
    finally:
        db.close()
    return [r.sample_id for r in rows]


def fetch_pair_http(sample_id: str, *, base_url: str, token: str) -> tuple[dict, dict]:
    import requests
    headers = {"Authorization": f"Bearer {token}"}
    mk1_resp = requests.get(
        f"{base_url.rstrip('/')}/registry/sample/{sample_id}/details",
        headers=headers, timeout=30,
    )
    mk1_resp.raise_for_status()
    senaite_resp = requests.get(
        f"{base_url.rstrip('/')}/wizard/senaite/lookup",
        params={"id": sample_id, "no_cache": "true"},
        headers=headers, timeout=30,
    )
    senaite_resp.raise_for_status()
    return mk1_resp.json(), senaite_resp.json()


def fetch_pair_in_process(sample_id: str, db_factory) -> tuple[dict, dict]:
    """Stack/UAT mode: call the builder + the lookup route function
    directly, bypassing HTTP entirely. Requires SENAITE env (the senaite
    side makes real SENAITE calls)."""
    import asyncio
    import main as main_module  # lazy: avoid paying main.py's import cost for HTTP-mode / test-only runs
    from sub_samples.registry_details import build_native_details

    db = db_factory()
    try:
        mk1_result = build_native_details(db, sample_id)
        senaite_result = asyncio.run(
            main_module.lookup_senaite_sample(id=sample_id, no_cache=True, db=db, _current_user=None)
        )
    finally:
        db.close()
    return mk1_result.model_dump(), senaite_result.model_dump()


def _load_fixture_pairs(path: str) -> list[tuple[str, dict, dict]]:
    """Hidden `--fixtures` mode: a JSON file shaped
    `[{"sample_id": "...", "mk1": {...}, "senaite": {...}}, ...]`. Used ONLY
    by tests to drive `main(argv)` end-to-end (including the --strict exit
    code path) without any live HTTP or SENAITE dependency."""
    with open(path) as f:
        raw = json.load(f)
    return [(item["sample_id"], item.get("mk1") or {}, item.get("senaite") or {}) for item in raw]


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(
        description="Sample-details parity harness (mk1 vs senaite read paths) "
                    "-- the read-flip go/no-go artifact. Report-only by default.",
        epilog="Exit codes: 0 = ran clean OR --strict not passed. 1 = --strict "
               "passed and at least one REAL (unclassified) diff OR per-sample "
               "fetch error exists anywhere in the run.")
    ap.add_argument("--samples", help="comma-separated sample IDs, e.g. P-0001,P-0002")
    ap.add_argument("--limit", type=int, help="newest N samples from lims_samples (id desc)")
    ap.add_argument("--base-url", help="backend base URL for HTTP mode (bearer token via env MK1_PARITY_TOKEN)")
    ap.add_argument("--in-process", action="store_true",
                    help="call build_native_details + lookup_senaite_sample directly (stack/UAT mode; needs SENAITE env)")
    ap.add_argument("--out", help="write the JSON report to this path")
    ap.add_argument("--strict", action="store_true",
                    help="exit 1 if any REAL (unclassified) diff or per-sample "
                         "fetch error exists anywhere in the run")
    ap.add_argument("--fixtures", help=argparse.SUPPRESS)  # test-only: bypass fetch entirely
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

    fetch_errors: list[dict] = []
    if args.fixtures:
        pairs = _load_fixture_pairs(args.fixtures)
    else:
        if bool(args.samples) == bool(args.limit):
            ap.error("specify exactly one of --samples or --limit")
        if bool(args.base_url) == bool(args.in_process):
            ap.error("specify exactly one of --base-url or --in-process")

        from database import SessionLocal
        sample_ids = resolve_sample_ids(SessionLocal, samples=args.samples, limit=args.limit)

        token = None
        if args.base_url:
            token = os.environ.get("MK1_PARITY_TOKEN")
            if not token:
                ap.error("--base-url mode needs a bearer token in env MK1_PARITY_TOKEN")

        # Per-sample fault isolation: one failing fetch (SENAITE hiccup, a
        # sample deleted mid-run, a 404) logs + counts, and the run continues
        # to a PARTIAL report -- never a lost run. fetch_errors ride the
        # report and trip the --strict gate: a partial run is not a clean run.
        pairs = []
        for sid in sample_ids:
            try:
                if args.base_url:
                    mk1, senaite = fetch_pair_http(sid, base_url=args.base_url, token=token)
                else:
                    mk1, senaite = fetch_pair_in_process(sid, SessionLocal)
                pairs.append((sid, mk1, senaite))
            except Exception as e:
                log.warning("fetch failed sample=%s err=%s", sid, e, exc_info=True)
                fetch_errors.append({"sample_id": sid, "error": f"{type(e).__name__}: {e}"})

    report = build_report(pairs, fetch_errors=fetch_errors)
    print_summary(report)

    if args.out:
        with open(args.out, "w") as f:
            json.dump(report, f, indent=2, default=str)
        log.info("report written to %s", args.out)

    if args.strict and (report["real_diff_sample_count"] > 0
                        or report["fetch_error_count"] > 0):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

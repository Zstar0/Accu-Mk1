"""Sample-details parity harness -- classifier + CLI-shell tests (read-flip
Layer 4 / Task 5).

No live HTTP and no SENAITE dependency anywhere in this file: the diff/
classification logic is pure-function tested directly on fixture payload
dicts (`compare_sample`), and the CLI shell's `--strict` exit-code contract
is tested end-to-end through `main(argv)` via the hidden `--fixtures` flag,
which reads a JSON file instead of fetching over HTTP or in-process.
"""
from __future__ import annotations

import copy
import json

from scripts.parity_sample_details import (
    ALL_COMPARED_FIELDS,
    REAL_CLASSIFICATIONS,
    compare_sample,
    main,
)
from sub_samples.lookup_models import RegistrySampleReadResult, SenaiteLookupResult


# ─── Fixture payload builders ───────────────────────────────────────────────

def _mk1_payload(**overrides) -> dict:
    """A native (mk1-mode) sample-details payload -- the shapes/defaults
    documented in the L4/Task2 builder report."""
    base = {
        "sample_id": "P-0001",
        # external_lims_uid captured at receive time -- the SAME SENAITE
        # uid the senaite side fetches live, so this matches by default
        # (registry_details.py:324, `sample_uid=row.external_lims_uid`).
        "sample_uid": "abcd1234ef",
        "client": "Acme Labs",
        "contact": "Jane Doe",
        "sample_type": "Peptide",
        "date_received": "2026-07-01T00:00:00",
        "date_sampled": "2026-07-01T00:00:00",
        "profiles": [],
        "client_order_number": "WP-100",
        "client_sample_id": "CS-1",
        "client_lot": "LOT-1",
        "review_state": "sample_received",
        "declared_weight_mg": 10.0,
        "analytes": [
            {"raw_name": "BPC-157", "slot_number": 1, "matched_peptide_id": None,
             "matched_peptide_name": None, "declared_quantity": 5.0},
        ],
        "coa": {
            "company_logo_url": "https://accumark.test/logo.png",
            "chromatograph_background_url": None,
            "company_name": "Accumark",
            "email": "lab@accumark.test",
            "website": "https://accumark.test",
            "address": "1 Lab Way",
            "verification_code": "ABCD-1234",
        },
        "remarks": [
            {"content": "note one", "user_id": "jdoe", "created": "2026-07-01T00:00:00"},
        ],
        "analyses": [
            {"uid": "mk1:501", "keyword": "BPC157_ID", "title": "BPC-157 - Identity (HPLC)",
             "result": "Pass", "result_options": [], "unit": None, "method": "HPLC Method A",
             "method_uid": "7", "method_options": [], "instrument": "HPLC-1",
             "instrument_uid": "3", "instrument_options": [], "analyst": "jdoe",
             "due_date": None, "review_state": "verified", "sort_key": 1.0,
             "captured": "2026-07-02T00:00:00", "retested": False,
             "service_group_id": None, "service_group_name": None},
        ],
        "attachments": [
            {"uid": "mk1att:9001", "filename": "chrom.csv", "content_type": "text/csv",
             "attachment_type": "HPLC Graph",
             "download_url": "/registry/sample/P-0001/attachments/9001/download"},
        ],
        "published_coa": None,
        "senaite_url": None,
        "cached_at": "2026-07-14T10:00:00+00:00",
    }
    base.update(overrides)
    return base


def _senaite_payload(**overrides) -> dict:
    """A senaite-mode sample-details payload with realistic SENAITE-native
    values in every slot the mk1 side leaves blank/defaulted."""
    base = {
        "sample_id": "P-0001",
        "sample_uid": "abcd1234ef",
        "client": "Acme Labs",
        "contact": "Jane Doe",
        "sample_type": "Peptide",
        "date_received": "2026-07-01T00:00:00",
        "date_sampled": "2026-07-01T00:00:00",
        "profiles": ["General Panel"],
        "client_order_number": "WP-100",
        "client_sample_id": "CS-1",
        "client_lot": "LOT-1",
        "review_state": "sample_received",
        "declared_weight_mg": 10.0,
        "analytes": [
            {"raw_name": "BPC-157 - Identity (HPLC)", "slot_number": 2,
             "matched_peptide_id": 42, "matched_peptide_name": "BPC-157",
             "declared_quantity": 5.0},
        ],
        "coa": {
            "company_logo_url": "https://accumark.test/logo.png",
            "chromatograph_background_url": "https://accumark.test/bg.png",
            "company_name": "Accumark",
            "email": "lab@accumark.test",
            "website": "https://accumark.test",
            "address": "1 Lab Way",
            "verification_code": "ABCD-1234",
        },
        "remarks": [
            {"content": "note one", "user_id": "jdoe", "created": "2026-07-01T00:00:00"},
        ],
        "analyses": [
            {"uid": "9f8e7d6c5b4a", "keyword": "BPC157_ID", "title": "BPC-157 - Identity (HPLC)",
             "result": "Pass", "result_options": [], "unit": None, "method": "HPLC Method A",
             "method_uid": "senaite-method-uid", "method_options": [], "instrument": "HPLC-1",
             "instrument_uid": "senaite-instrument-uid", "instrument_options": [],
             "analyst": "jdoe", "due_date": None, "review_state": "verified",
             "sort_key": 1.0, "captured": "2026-07-02T00:00:00", "retested": False,
             "service_group_id": None, "service_group_name": None},
        ],
        "attachments": [
            {"uid": "senaite-att-uid-1", "filename": "chrom.csv", "content_type": "text/csv",
             "attachment_type": "HPLC Graph",
             "download_url": "/wizard/senaite/attachment/senaite-att-uid-1"},
        ],
        "published_coa": {
            "report_uid": "rpt-1", "filename": "COA.pdf", "file_size_bytes": 1024,
            "published_date": "2026-07-03T00:00:00", "published_by": "labtech",
            "download_url": "/wizard/senaite/report/rpt-1",
        },
        "senaite_url": "/clients/client-8/P-0001",
        "cached_at": "2026-07-14T10:00:05+00:00",
    }
    base.update(overrides)
    return base


def _diffs_by_path(diffs, path):
    return [d for d in diffs if d.path == path]


def _one(diffs, path):
    matches = _diffs_by_path(diffs, path)
    assert len(matches) == 1, f"expected exactly one diff at {path!r}, got {matches}"
    return matches[0]


# ─── Field coverage guard ───────────────────────────────────────────────────

def test_field_coverage_matches_model():
    """The comparator's field inventory is DERIVED from the pydantic model,
    not hand-listed -- this test is the tripwire: if SenaiteLookupResult
    gains/loses a field and the comparator's LIST_COMPARATOR_FIELDS constant
    isn't updated to match, this fails loudly instead of the harness
    silently skipping (or crashing on) the new field."""
    assert ALL_COMPARED_FIELDS == set(SenaiteLookupResult.model_fields)
    # RegistrySampleReadResult's extra scaffolding fields are exactly the
    # excluded meta-only set -- verified against the real model, not assumed.
    from scripts.parity_sample_details import _META_ONLY_FIELDS
    assert _META_ONLY_FIELDS == (
        set(RegistrySampleReadResult.model_fields) - set(SenaiteLookupResult.model_fields)
    )


# ─── Core classification ────────────────────────────────────────────────────

def test_fully_equal_sample_all_equal():
    mk1 = _mk1_payload()
    senaite = copy.deepcopy(mk1)  # byte-identical by construction
    diffs = compare_sample(mk1, senaite)
    assert diffs, "expected at least one field to be compared"
    for d in diffs:
        assert d.classification == "equal", d
        assert d.rule_id is None
        assert not d.is_real


def test_published_coa_senaite_era_known_expected():
    diffs = compare_sample(_mk1_payload(), _senaite_payload())
    d = _one(diffs, "published_coa")
    assert d.classification == "known_expected"
    assert d.rule_id == "published_coa_senaite_era"
    assert not d.is_real


def test_senaite_url_unavailable_known_expected():
    diffs = compare_sample(_mk1_payload(), _senaite_payload())
    d = _one(diffs, "senaite_url")
    assert d.classification == "known_expected"
    assert d.rule_id == "senaite_url_unavailable"


def test_profiles_empty_native_known_expected():
    diffs = compare_sample(_mk1_payload(), _senaite_payload())
    d = _one(diffs, "profiles")
    assert d.classification == "known_expected"
    assert d.rule_id == "profiles_empty_native"


def test_coa_chromatograph_background_url_known_expected():
    diffs = compare_sample(_mk1_payload(), _senaite_payload())
    d = _one(diffs, "coa.chromatograph_background_url")
    assert d.classification == "known_expected"
    assert d.rule_id == "coa_chromatograph_background_url"
    # sibling coa subfields that DO match stay equal, not swept into the rule
    assert _one(diffs, "coa.company_name").classification == "equal"


def test_cached_at_always_known_expected():
    diffs = compare_sample(_mk1_payload(), _senaite_payload())
    d = _one(diffs, "cached_at")
    assert d.classification == "known_expected"
    assert d.rule_id == "cached_at_timestamps"


def test_attachment_uid_known_expected_but_download_url_stays_real():
    """The uid shape difference (mk1att: vs a senaite uid) is known-expected,
    but the download_url actually routes to two different places for an
    s3-frozen attachment -- that difference must NOT be hidden."""
    diffs = compare_sample(_mk1_payload(), _senaite_payload())
    uid_diff = _one(diffs, "attachments[chrom.csv].uid")
    assert uid_diff.classification == "known_expected"
    assert uid_diff.rule_id == "attachment_mk1att_uids"

    url_diff = _one(diffs, "attachments[chrom.csv].download_url")
    assert url_diff.classification == "differing"
    assert url_diff.is_real
    assert url_diff.rule_id is None
    # REAL diffs carry the raw pair so the Handler can eyeball without refetching
    assert url_diff.mk1_value == "/registry/sample/P-0001/attachments/9001/download"
    assert url_diff.senaite_value == "/wizard/senaite/attachment/senaite-att-uid-1"

    # attachment_type matches on both sides -> plain equal
    assert _one(diffs, "attachments[chrom.csv].attachment_type").classification == "equal"


def test_analytes_defaults_matched_peptide_and_slot_known_expected():
    """Covers both analytes_defaults sub-cases: matched_peptide_* (mk1
    always None) and slot_number (may legitimately differ when SENAITE had
    a gap in analyte slots) -- and proves the suffix-stripped, case-folded
    match key pairs 'BPC-157' with SENAITE's 'BPC-157 - Identity (HPLC)'."""
    diffs = compare_sample(_mk1_payload(), _senaite_payload())

    slot_diff = _one(diffs, "analytes[BPC-157].slot_number")
    assert slot_diff.classification == "known_expected"
    assert slot_diff.rule_id == "analytes_defaults"

    pid_diff = _one(diffs, "analytes[BPC-157].matched_peptide_id")
    assert pid_diff.classification == "known_expected"
    assert pid_diff.rule_id == "analytes_defaults"

    pname_diff = _one(diffs, "analytes[BPC-157].matched_peptide_name")
    assert pname_diff.classification == "known_expected"
    assert pname_diff.rule_id == "analytes_defaults"

    # matching numeric quantity -> equal, and crucially NOT mk1_only/senaite_only
    # anywhere -- the suffix-stripped key found the pair.
    assert _one(diffs, "analytes[BPC-157].declared_quantity").classification == "equal"
    assert not any(d.classification in ("mk1_only", "senaite_only") for d in diffs
                   if d.path.startswith("analytes["))


def test_mi_blank_after_retest_known_expected_and_uid_shape_known_expected():
    """M/I fields go blank on the mk1 side across a retest (L1 ownership) --
    override the baseline's normally-populated method/instrument to model
    that specific post-retest state."""
    blanked_mk1_analysis = {
        **_mk1_payload()["analyses"][0],
        "method": None, "method_uid": None,
        "instrument": None, "instrument_uid": None,
    }
    mk1 = _mk1_payload(analyses=[blanked_mk1_analysis])
    diffs = compare_sample(mk1, _senaite_payload())

    for sub in ("method", "method_uid", "instrument", "instrument_uid"):
        d = _one(diffs, f"analyses[BPC157_ID].{sub}")
        assert d.classification == "known_expected", (sub, d)
        assert d.rule_id == "mi_blank_after_retest"

    uid_diff = _one(diffs, "analyses[BPC157_ID].uid")
    assert uid_diff.classification == "known_expected"
    assert uid_diff.rule_id == "analyses_uid_shape"

    # matching result/unit/review_state/analyst -> plain equal
    for sub in ("result", "unit", "review_state", "analyst"):
        assert _one(diffs, f"analyses[BPC157_ID].{sub}").classification == "equal", sub


def test_method_instrument_uid_namespace_mismatch_known_expected_when_populated():
    """method_uid/instrument_uid live in different id spaces on the two
    sides (mk1 internal PK vs SENAITE Zope uid) even when BOTH are
    populated -- the baseline fixture's '7'/'senaite-method-uid' pairing
    must classify as known-expected (analyses_uid_shape), not as a real
    diff, or every single parity run would report a false positive here."""
    diffs = compare_sample(_mk1_payload(), _senaite_payload())

    method_uid_diff = _one(diffs, "analyses[BPC157_ID].method_uid")
    assert method_uid_diff.classification == "known_expected"
    assert method_uid_diff.rule_id == "analyses_uid_shape"

    instrument_uid_diff = _one(diffs, "analyses[BPC157_ID].instrument_uid")
    assert instrument_uid_diff.classification == "known_expected"
    assert instrument_uid_diff.rule_id == "analyses_uid_shape"

    # the human-readable TITLE fields still match plainly (equal) -- only
    # the id-space fields get the shape-mismatch treatment.
    assert _one(diffs, "analyses[BPC157_ID].method").classification == "equal"
    assert _one(diffs, "analyses[BPC157_ID].instrument").classification == "equal"


def test_method_title_mismatch_when_populated_stays_real():
    """A genuine title mismatch between two POPULATED method names is a
    real data-integrity concern -- not the blank-after-retest case, and not
    an id-space mismatch (titles are plain display strings). Must not be
    swept away."""
    mk1_analysis = {**_mk1_payload()["analyses"][0], "method": "HPLC Method A"}
    senaite_analysis = {**_senaite_payload()["analyses"][0], "method": "GC Method B"}
    diffs = compare_sample(
        _mk1_payload(analyses=[mk1_analysis]),
        _senaite_payload(analyses=[senaite_analysis]),
    )
    d = _one(diffs, "analyses[BPC157_ID].method")
    assert d.classification == "differing"
    assert d.is_real
    assert d.rule_id is None


def test_remarks_native_both_never_fires_real_diff_stays_real():
    mk1 = _mk1_payload(remarks=[{"content": "note one", "user_id": "jdoe",
                                  "created": "2026-07-01T00:00:00"}])
    senaite = _senaite_payload(remarks=[{"content": "DIFFERENT", "user_id": "jdoe",
                                          "created": "2026-07-01T00:00:00"}])
    diffs = compare_sample(mk1, senaite)
    d = _one(diffs, "remarks")
    assert d.classification == "differing"
    assert d.is_real
    assert d.rule_id is None  # remarks_native_both documented but never auto-fires


def test_real_diff_differing_analysis_result_value():
    mk1 = _mk1_payload()
    senaite = _senaite_payload(analyses=[
        {**_senaite_payload()["analyses"][0], "result": "Fail"},
    ])
    diffs = compare_sample(mk1, senaite)
    d = _one(diffs, "analyses[BPC157_ID].result")
    assert d.classification == "differing"
    assert d.is_real
    assert d.mk1_value == "Pass"
    assert d.senaite_value == "Fail"


def test_analyses_order_insensitive_matching_no_false_diffs():
    """Two lines, opposite order on each side, identical content -> every
    field equal, nothing lands in mk1_only/senaite_only."""
    line_a_mk1 = {**_mk1_payload()["analyses"][0], "keyword": "AAA", "uid": "mk1:1"}
    line_b_mk1 = {**_mk1_payload()["analyses"][0], "keyword": "BBB", "uid": "mk1:2"}
    line_a_sen = {**_senaite_payload()["analyses"][0], "keyword": "AAA", "uid": "senaite-a"}
    line_b_sen = {**_senaite_payload()["analyses"][0], "keyword": "BBB", "uid": "senaite-b"}

    mk1 = _mk1_payload(analyses=[line_a_mk1, line_b_mk1])
    # senaite list in the OPPOSITE order
    senaite = _senaite_payload(analyses=[line_b_sen, line_a_sen])

    diffs = compare_sample(mk1, senaite)
    analyses_diffs = [d for d in diffs if d.path.startswith("analyses[")]
    assert analyses_diffs, "expected analyses diffs to be present"
    assert not any(d.classification in ("analyses_mk1_only", "analyses_senaite_only")
                   for d in analyses_diffs)
    # result/unit/review_state/analyst identical on both matched pairs -> equal
    assert _one(diffs, "analyses[AAA].result").classification == "equal"
    assert _one(diffs, "analyses[BBB].result").classification == "equal"


def test_analyses_one_side_missing_line_is_real():
    mk1 = _mk1_payload(analyses=[
        {**_mk1_payload()["analyses"][0], "keyword": "ONLY_MK1"},
    ])
    senaite = _senaite_payload(analyses=[
        {**_senaite_payload()["analyses"][0], "keyword": "ONLY_SENAITE"},
    ])
    diffs = compare_sample(mk1, senaite)

    mk1_only = _one(diffs, "analyses[ONLY_MK1]")
    assert mk1_only.classification == "analyses_mk1_only"
    assert mk1_only.is_real

    senaite_only = _one(diffs, "analyses[ONLY_SENAITE]")
    assert senaite_only.classification == "analyses_senaite_only"
    assert senaite_only.is_real


# ─── CLI shell: --fixtures + --strict exit-code contract ───────────────────

def _write_fixtures(tmp_path, pairs):
    path = tmp_path / "fixtures.json"
    path.write_text(json.dumps(pairs))
    return str(path)


def test_main_strict_exits_1_on_real_diff(tmp_path, capsys):
    senaite_analyses = _senaite_payload()["analyses"]
    fixtures = [{
        "sample_id": "P-0001",
        "mk1": _mk1_payload(),
        "senaite": _senaite_payload(analyses=[{**senaite_analyses[0], "result": "Fail"}]),
    }]
    fixtures_path = _write_fixtures(tmp_path, fixtures)
    out_path = tmp_path / "report.json"

    rc = main(["--fixtures", fixtures_path, "--out", str(out_path), "--strict"])

    assert rc == 1
    report = json.loads(out_path.read_text())
    assert report["sample_count"] == 1
    assert report["real_diff_sample_count"] == 1


def test_main_default_exits_0_even_with_real_diff(tmp_path):
    """Report-only by default: a real diff exists but --strict wasn't
    passed, so the run still exits 0."""
    senaite_analyses = _senaite_payload()["analyses"]
    fixtures = [{
        "sample_id": "P-0001",
        "mk1": _mk1_payload(),
        "senaite": _senaite_payload(analyses=[{**senaite_analyses[0], "result": "Fail"}]),
    }]
    fixtures_path = _write_fixtures(tmp_path, fixtures)

    rc = main(["--fixtures", fixtures_path])

    assert rc == 0


def test_main_strict_exits_0_when_clean(tmp_path):
    """Only known-expected/equal diffs (a realistic mk1-vs-senaite pair,
    no injected real diff) -> --strict still exits 0.

    Uses a senaite-uid-backed attachment (not an s3-frozen capture): per
    the Task 2 builder report, when `senaite_attachment_uid` is set, mk1's
    OWN download_url also becomes `/wizard/senaite/attachment/{uid}` --
    identical to senaite's, so this attachment is genuinely equal on both
    sides (the s3-frozen download_url REAL-diff case is covered separately
    by test_attachment_uid_known_expected_but_download_url_stays_real)."""
    senaite_backed_attachment = {
        "uid": "senaite-att-uid-1", "filename": "chrom.csv", "content_type": "text/csv",
        "attachment_type": "HPLC Graph", "download_url": "/wizard/senaite/attachment/senaite-att-uid-1",
    }
    fixtures = [{
        "sample_id": "P-0001",
        "mk1": _mk1_payload(attachments=[senaite_backed_attachment]),
        "senaite": _senaite_payload(attachments=[senaite_backed_attachment]),
    }]
    fixtures_path = _write_fixtures(tmp_path, fixtures)
    out_path = tmp_path / "report.json"

    rc = main(["--fixtures", fixtures_path, "--out", str(out_path), "--strict"])

    assert rc == 0
    report = json.loads(out_path.read_text())
    assert report["real_diff_sample_count"] == 0
    # known-expected rules actually fired and are visible in the report,
    # not hidden -- the "never hidden" contract, verified end-to-end.
    assert report["known_expected_rule_counts"]["published_coa_senaite_era"] == 1
    assert report["known_expected_rule_counts"]["analyses_uid_shape"] == 3


def test_main_requires_exactly_one_of_samples_or_limit():
    import pytest
    with pytest.raises(SystemExit):
        main(["--in-process"])  # neither --samples nor --limit


def test_main_requires_exactly_one_of_base_url_or_in_process():
    import pytest
    with pytest.raises(SystemExit):
        main(["--samples", "P-0001"])  # neither --base-url nor --in-process

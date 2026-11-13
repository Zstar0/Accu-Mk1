"""a_la_carte_verdict: the one decision whether a sample is a la carte
(no-HPLC order). Plan 4 Task 1; spec "The one decision", six conditions."""
import pytest

from catalog.bw_keys import BW_PRIMARY_KEYS
from catalog.hplc_keys import HPLC_PRIMARY_KEYS
from coa.a_la_carte import ALaCarteVerdict, a_la_carte_verdict
from tests.test_native_sections import _mk_native_profile, _mk_parent_with_rows

ELIGIBLE = [
    ("endotoxin-usp85-lal", "ENDOTOXIN-USP85LAL"),
    ("rapid-sterility-pcr", "STER-PCR"),
    ("sterility-usp71", "BACTERIA"),
    ("heavy_metals", "HM-PB"),
    ("fentanyl", "FENTANYL"),
    ("vial-vacuum-test", "PRESSURE-VC"),
    ("ph-profile", "PH-MEASURE"),
]
SECTION = [{"profile_key": "x"}]


def _alc(db, monkeypatch, key="fentanyl", keyword="FENTANYL", *, services=None,
         package="alacarte", matrix="Peptide", members=None, **parent_over):
    _prof, svcs = _mk_native_profile(db, key=key, services=members or [(keyword, "mk1")])
    # Rows only for mk1 members: a SENAITE-origin row on the parent is its own
    # c2 case, so the mixed-origin profile test must reach c5 with it absent.
    parent = _mk_parent_with_rows(db, [s for s in svcs if s.origin == "mk1"])
    parent.external_lims_system = "mk1"
    parent.sample_type_title = matrix
    for k, v in parent_over.items():
        setattr(parent, k, v)
    db.flush()
    payload = {"services": services or {key: True}, "package": package}
    monkeypatch.setattr("coa.native_sections.fetch_sample_services",
                        lambda sample_id: payload)
    return parent


def _add_row(db, parent, keyword, origin, **row_over):
    from models import AnalysisService, LimsAnalysis
    svc = AnalysisService(title=keyword.title(), keyword=keyword, origin=origin, unit="ppm")
    db.add(svc); db.flush()
    fields = dict(lims_sample_pk=parent.id, analysis_service_id=svc.id,
                  keyword=keyword, title=svc.title, result_value="1",
                  result_unit="ppm", review_state="verified")
    fields.update(row_over)
    db.add(LimsAnalysis(**fields)); db.flush()
    return svc


def _profile(db, key):
    from models import AnalysisProfile
    return db.query(AnalysisProfile).filter_by(key=key).one()


def _verdict(db, parent, **kw):
    kw.setdefault("sections", SECTION)
    return a_la_carte_verdict(db, parent, **kw)


@pytest.mark.parametrize("key,keyword", ELIGIBLE)
def test_each_eligible_key_alone_is_eligible(db_session, monkeypatch, key, keyword):
    parent = _alc(db_session, monkeypatch, key, keyword)
    v = _verdict(db_session, parent)
    assert v == ALaCarteVerdict(True, "eligible")


def test_senaite_born_not_eligible(db_session, monkeypatch):
    parent = _alc(db_session, monkeypatch, external_lims_system="senaite")
    assert _verdict(db_session, parent).reason.startswith("c1")


def test_senaite_origin_row_blocks(db_session, monkeypatch):
    parent = _alc(db_session, monkeypatch)
    _add_row(db_session, parent, "FENT-S", "senaite")
    assert _verdict(db_session, parent).reason.startswith("c2")


def test_rejected_native_hplc_row_still_blocks(db_session, monkeypatch):
    # A placeholder the lab rejected in Manage Analyses: the shaped read keeps
    # ordered rows whatever their state, and c2 applies no skip-state filter.
    parent = _alc(db_session, monkeypatch)
    _add_row(db_session, parent, "HPLC-PURITY", "mk1",
             review_state="rejected", provenance="ordered")
    assert _verdict(db_session, parent).reason.startswith("c2")


def test_native_bw_row_blocks(db_session, monkeypatch):
    parent = _alc(db_session, monkeypatch)
    _add_row(db_session, parent, "PH-BW", "mk1")
    assert _verdict(db_session, parent).reason.startswith("c2")


def test_lookup_failure_aborts(db_session, monkeypatch):
    parent = _alc(db_session, monkeypatch)

    def boom(sample_id):
        raise RuntimeError("IS down")
    monkeypatch.setattr("coa.native_sections.fetch_sample_services", boom)
    # The reason names the exception type only: raw exception text can carry
    # SQL and bound parameters, and callers log the reason.
    assert _verdict(db_session, parent).reason == "c3: order lookup failed: RuntimeError"


def test_lookup_404_aborts(db_session, monkeypatch):
    parent = _alc(db_session, monkeypatch)
    monkeypatch.setattr("coa.native_sections.fetch_sample_services", lambda sample_id: None)
    assert _verdict(db_session, parent).reason.startswith("c3")


def test_all_false_services_abort_even_with_lab_added_key(db_session, monkeypatch):
    parent = _alc(db_session, monkeypatch, services={"fentanyl": False})
    from models import LimsAnalysis
    assert db_session.query(LimsAnalysis).filter_by(
        lims_sample_pk=parent.id, provenance="canonical").count() == 1
    assert _verdict(db_session, parent).reason.startswith("c3")


@pytest.mark.parametrize("k", sorted(HPLC_PRIMARY_KEYS))
def test_hplc_key_aborts(db_session, monkeypatch, k):
    parent = _alc(db_session, monkeypatch, services={"fentanyl": True, k: True})
    assert _verdict(db_session, parent).reason.startswith("c3")


@pytest.mark.parametrize("k", sorted(BW_PRIMARY_KEYS))
def test_bw_key_aborts(db_session, monkeypatch, k):
    parent = _alc(db_session, monkeypatch, services={"fentanyl": True, k: True})
    assert _verdict(db_session, parent).reason.startswith("c3")


@pytest.mark.parametrize("p", ["core", "accushield"])
def test_hplc_tier_package_aborts(db_session, monkeypatch, p):
    parent = _alc(db_session, monkeypatch, package=p)
    assert _verdict(db_session, parent).reason.startswith("c3")


@pytest.mark.parametrize("p", ["alacarte", None])
def test_alacarte_or_no_package_passes(db_session, monkeypatch, p):
    parent = _alc(db_session, monkeypatch, package=p)
    assert _verdict(db_session, parent).eligible


def test_unknown_key_aborts(db_session, monkeypatch):
    parent = _alc(db_session, monkeypatch, services={"fentanyl": True, "acoa_line": True})
    assert _verdict(db_session, parent).reason.startswith("c5")


def test_variance_key_aborts(db_session, monkeypatch):
    parent = _alc(db_session, monkeypatch, services={"fentanyl": True, "variance": True})
    assert _verdict(db_session, parent).reason.startswith("c5")


def test_inactive_profile_aborts(db_session, monkeypatch):
    parent = _alc(db_session, monkeypatch)
    _profile(db_session, "fentanyl").active = False
    db_session.flush()
    assert _verdict(db_session, parent).reason.startswith("c5")


@pytest.mark.parametrize("a", [None, "legacy_hplc", "legacy_bw"])
def test_non_limit_table_archetype_aborts(db_session, monkeypatch, a):
    parent = _alc(db_session, monkeypatch)
    _profile(db_session, "fentanyl").coa_archetype = a
    db_session.flush()
    assert _verdict(db_session, parent).reason.startswith("c5")


def test_mixed_origin_profile_aborts(db_session, monkeypatch):
    parent = _alc(db_session, monkeypatch,
                  members=[("FENTANYL", "mk1"), ("FENT-S", "senaite")])
    assert _verdict(db_session, parent).reason.startswith("c5")


def test_shared_member_with_non_limit_table_profile_aborts(db_session, monkeypatch):
    from models import AnalysisProfile, analysis_profile_members
    parent = _alc(db_session, monkeypatch)
    fent = _profile(db_session, "fentanyl").analysis_services[0]
    bundle = AnalysisProfile(key="bundle_x", name="Bundle X", is_addon=True,
                             coa_archetype=None, coa_sort_order=20)
    db_session.add(bundle); db_session.flush()
    db_session.execute(analysis_profile_members.insert().values(
        analysis_profile_id=bundle.id, analysis_service_id=fent.id, sort_order=0))
    db_session.flush()
    assert _verdict(db_session, parent).reason.startswith("c5")


def test_no_section_aborts(db_session, monkeypatch):
    parent = _alc(db_session, monkeypatch)
    assert _verdict(db_session, parent, sections=[]).reason.startswith("c4")


def test_sections_none_skips_c4(db_session, monkeypatch):
    parent = _alc(db_session, monkeypatch)
    assert _verdict(db_session, parent, sections=None).eligible


def test_peptide_retest_aborts(db_session, monkeypatch):
    parent = _alc(db_session, monkeypatch, is_retest=True, retest_of_sample_id="P-0001")
    assert _verdict(db_session, parent).reason.startswith("c6")


def test_panel_drop_bw_retest_eligible_when_is_still_lists_bw(db_session, monkeypatch):
    parent = _alc(
        db_session, monkeypatch, "endotoxin-usp85-lal", "ENDOTOXIN-USP85LAL",
        matrix="Bacteriostatic Water",
        services={"endotoxin-usp85-lal": True, "bacteriostatic-water-panel": True},
        is_retest=True, retest_of_sample_id="BW-0001",
        catalog_snapshot={"retest": {
            "retest": ["endotoxin-usp85-lal"], "carry": [], "missing": [],
            "drop": ["bacteriostatic-water-panel"],
            "add": {"profiles": [], "variance_points": 0}}},
    )
    v = _verdict(db_session, parent)
    assert v.eligible, v.reason


def test_verdict_never_raises(db_session, monkeypatch):
    parent = _alc(db_session, monkeypatch)
    v = _verdict(db_session, parent, shaped=[object()])
    assert v == ALaCarteVerdict(False, "error: AttributeError")


def test_verdict_error_reason_carries_no_exception_text(db_session, monkeypatch):
    parent = _alc(db_session, monkeypatch)

    def failing_query(db, pk):
        raise RuntimeError("SELECT secret FROM t WHERE x = 'bound-param'")
    monkeypatch.setattr("coa.native_sections._lab_added_profile_keys", failing_query)
    assert _verdict(db_session, parent) == ALaCarteVerdict(False, "error: RuntimeError")


def test_bw_retest_rider_carry_of_bw_panel_aborts_at_c3(db_session, monkeypatch):
    # The rider carry (minus missing) feeds the key set, so a carried BW panel
    # is an ordered BW primary even when the IS services no longer list it.
    parent = _alc(
        db_session, monkeypatch, "endotoxin-usp85-lal", "ENDOTOXIN-USP85LAL",
        matrix="Bacteriostatic Water",
        services={"endotoxin-usp85-lal": True},
        is_retest=True, retest_of_sample_id="BW-0001",
        catalog_snapshot={"retest": {
            "retest": ["endotoxin-usp85-lal"], "carry": ["bacteriostatic-water-panel"],
            "missing": [], "drop": [],
            "add": {"profiles": [], "variance_points": 0}}},
    )
    assert _verdict(db_session, parent).reason == "c3: ordered ['bacteriostatic-water-panel']"

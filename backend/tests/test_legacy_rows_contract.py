"""Twin contract test — coab side: tests/test_legacy_rows_contract.py in the
coabuilder repo pins the same FIELD_CONTRACT tuple and row shapes. Move them
together."""
from types import SimpleNamespace

import pytest

import coa.legacy_rows as lr
from coa.legacy_rows import FIELD_CONTRACT, SKIP_STATES, build_legacy_rows
from coa.native_sections import NativeSectionsError


def _shaped(**over):
    base = dict(
        uid="mk1:144", keyword="HPLC-PUR", title="Peptide Purity (HPLC)",
        result="12", unit="%", review_state="published",
        captured="2026-08-25T04:26:00+00:00", service_origin="senaite",
        peptide_id=None, slot=None, analysis_service_id=None,
    )
    base.update(over)
    return SimpleNamespace(**base)


_PARENT = SimpleNamespace(sample_id="P-0161")


def test_field_contract_pinned():
    assert FIELD_CONTRACT == (
        "uid", "Keyword", "Title", "ServiceTitle",
        "Result", "Unit", "review_state", "ResultCaptureDate",
    )


def test_projection_recases_and_duplicates_title(monkeypatch):
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [_shaped()])
    rows = build_legacy_rows(None, _PARENT)
    assert rows == [{
        "uid": "mk1:144", "Keyword": "HPLC-PUR",
        "Title": "Peptide Purity (HPLC)", "ServiceTitle": "Peptide Purity (HPLC)",
        "Result": "12", "Unit": "%", "review_state": "published",
        "ResultCaptureDate": "2026-08-25T04:26:00+00:00",
    }]
    assert set(rows[0].keys()) == set(FIELD_CONTRACT)


def test_native_family_rows_filtered_out(monkeypatch):
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [
        _shaped(),
        _shaped(uid="mk1:200", keyword="STERILITY_USP71", service_origin="mk1"),
    ])
    rows = build_legacy_rows(None, _PARENT)
    assert [r["Keyword"] for r in rows] == ["HPLC-PUR"]


def test_pending_row_survives_with_empty_result(monkeypatch):
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [
        _shaped(keyword="ENDO-LAL", result=None, review_state="unassigned"),
    ])
    assert build_legacy_rows(None, _PARENT)[0]["Result"] is None


def test_zero_legacy_rows_aborts(monkeypatch):
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [
        _shaped(service_origin="mk1"),
    ])
    with pytest.raises(NativeSectionsError):
        build_legacy_rows(None, _PARENT)


def test_row_without_keyword_aborts(monkeypatch):
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [_shaped(keyword=None)])
    with pytest.raises(NativeSectionsError):
        build_legacy_rows(None, _PARENT)


def test_empty_string_keyword_aborts(monkeypatch):
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [_shaped(keyword="")])
    with pytest.raises(NativeSectionsError):
        build_legacy_rows(None, _PARENT)


def test_whitespace_only_keyword_aborts(monkeypatch):
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [_shaped(keyword="   ")])
    with pytest.raises(NativeSectionsError):
        build_legacy_rows(None, _PARENT)


def test_unresolvable_service_origin_aborts(monkeypatch):
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [
        _shaped(),
        _shaped(uid="mk1:300", keyword="HEAVY-METALS", service_origin=None),
    ])
    with pytest.raises(NativeSectionsError):
        build_legacy_rows(None, _PARENT)


def test_skip_states_pinned():
    assert SKIP_STATES == frozenset({"retracted", "rejected", "cancelled"})


@pytest.mark.parametrize("skip_state", sorted(SKIP_STATES))
def test_skip_state_row_excluded_from_output(monkeypatch, skip_state):
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [
        _shaped(),
        _shaped(uid="mk1:200", keyword="ENDO-LAL", review_state=skip_state),
    ])
    rows = build_legacy_rows(None, _PARENT)
    assert [r["Keyword"] for r in rows] == ["HPLC-PUR"]


def test_all_skip_state_rows_aborts_as_zero_rows(monkeypatch):
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [
        _shaped(review_state="retracted"),
        _shaped(uid="mk1:200", keyword="ENDO-LAL", review_state="rejected"),
        _shaped(uid="mk1:300", keyword="STER-PCR", review_state="cancelled"),
    ])
    with pytest.raises(NativeSectionsError):
        build_legacy_rows(None, _PARENT)


def test_review_state_none_aborts_naming_uid_and_sample_id(monkeypatch):
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [
        _shaped(uid="mk1:144", review_state=None),
    ])
    with pytest.raises(NativeSectionsError) as excinfo:
        build_legacy_rows(None, _PARENT)
    assert "mk1:144" in str(excinfo.value)
    assert "P-0161" in str(excinfo.value)


# --- Identity verdict on the wire (coa/identity_verdict.py, P-1986 class) ---

def test_conforming_identity_row_emits_conforms_token(monkeypatch):
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [
        _shaped(uid="mk1:39931", keyword="ID_Somatropin",
                title="Somatropin - Identity (HPLC)", result="HGH (Somatropin)",
                unit=None, analysis_service_id=264),
    ])
    seen = {}

    def fake_verdict(db, *, keyword, result, analysis_service_id):
        seen.update(keyword=keyword, result=result, svc=analysis_service_id)
        return "Conforms"

    monkeypatch.setattr(lr, "identity_wire_result", fake_verdict)
    rows = build_legacy_rows(None, _PARENT)
    assert rows[0]["Result"] == "Conforms"
    assert seen == {"keyword": "ID_Somatropin", "result": "HGH (Somatropin)", "svc": 264}
    assert set(rows[0].keys()) == set(FIELD_CONTRACT)


def test_non_identity_rows_bypass_verdict(monkeypatch):
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [_shaped()])
    monkeypatch.setattr(lr, "identity_wire_result",
                        lambda db, **kw: kw["result"] if kw["keyword"] != "ID_X" else "Conforms")
    assert build_legacy_rows(None, _PARENT)[0]["Result"] == "12"


def test_identity_verdict_wired_end_to_end_for_p1986_shape(monkeypatch):
    """Real verdict function, shaped row without a resolvable service (db
    None): only token rules apply, so the raw name rides raw — proving the
    hook never fabricates a pass when the catalog can't be consulted."""
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [
        _shaped(keyword="ID_Somatropin", title="Somatropin - Identity (HPLC)",
                result="HGH (Somatropin)", analysis_service_id=None),
        _shaped(uid="mk1:2", keyword="ID_BPC157", title="BPC-157 - Identity (HPLC)",
                result="Conforms", analysis_service_id=None),
    ])
    rows = build_legacy_rows(None, _PARENT)
    assert [r["Result"] for r in rows] == ["HGH (Somatropin)", "Conforms"]


# --- Native-born HPLC rows ride the wire in the shim vocabulary ---

def _native_parent(**over):
    base = dict(sample_id="P-5001", external_lims_system="mk1")
    base.update(over)
    return SimpleNamespace(**base)


def _wires(*names):
    from coa.hplc_shim import SlotWire
    return [SlotWire(i, n, 100 + i, None) for i, n in enumerate(names, start=1)]


def test_native_single_rows_ride_in_legacy_vocabulary(monkeypatch):
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [
        _shaped(uid="mk1:1", keyword="HPLC-IDENTITY", title="BPC-157 - Identity (HPLC)", result="Conforms",
                unit=None, service_origin="mk1", peptide_id=101, slot=1, analysis_service_id=901),
        _shaped(uid="mk1:2", keyword="HPLC-PURITY", title="BPC-157 - Purity (HPLC)", result="98.5",
                unit="%", service_origin="mk1", peptide_id=101, slot=1, analysis_service_id=902),
        _shaped(uid="mk1:3", keyword="HPLC-QUANTITY", title="BPC-157 - Quantity (HPLC)", result="4.9",
                unit="mg", service_origin="mk1", peptide_id=101, slot=1, analysis_service_id=903),
    ])
    monkeypatch.setattr(lr, "slot_wires", lambda db, parent: _wires("BPC-157"))
    rows = build_legacy_rows(None, _native_parent())
    assert [(r["Keyword"], r["Title"], r["Result"], r["Unit"]) for r in rows] == [
        ("ANALYTE-1-ID", "BPC-157 - Identity (HPLC)", "Conforms", None),
        ("HPLC-PUR", "BPC-157 - Purity (HPLC)", "98.5", "%"),
        ("PEPT-Total", "BPC-157 - Quantity (HPLC)", "4.9", "mg"),
    ]
    assert all(set(r.keys()) == set(FIELD_CONTRACT) for r in rows)
    assert all(r["Title"] == r["ServiceTitle"] for r in rows)


def test_native_blend_rows_are_per_slot_and_aggregates_map(monkeypatch):
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [
        _shaped(uid="mk1:1", keyword="HPLC-PURITY", title="x", result="98", unit="%", service_origin="mk1",
                peptide_id=101, slot=1, analysis_service_id=902),
        _shaped(uid="mk1:2", keyword="HPLC-PURITY", title="x", result="96", unit="%", service_origin="mk1",
                peptide_id=102, slot=2, analysis_service_id=902),
        _shaped(uid="mk1:3", keyword="HPLC-BLEND-PURITY", title="HPLC Blend Purity (mass-weighted)", result="97.6",
                unit="%", service_origin="mk1", peptide_id=None, slot=None, analysis_service_id=904),
        _shaped(uid="mk1:4", keyword="HPLC-BLEND-TOTAL", title="HPLC Blend Total Quantity", result="5",
                unit="mg", service_origin="mk1", peptide_id=None, slot=None, analysis_service_id=905),
    ])
    monkeypatch.setattr(lr, "slot_wires", lambda db, parent: _wires("BPC-157", "TB-500"))
    rows = build_legacy_rows(None, _native_parent(sample_id="PB-1001"))
    assert [(r["Keyword"], r["Title"]) for r in rows] == [
        ("ANALYTE-1-PUR", "BPC-157 - Purity (HPLC)"),
        ("ANALYTE-2-PUR", "TB-500 - Purity (HPLC)"),
        ("BLEND-PUR", "HPLC Blend Purity (mass-weighted)"),
        ("PEPT-Total", "HPLC Blend Total Quantity"),
    ]
    assert len({r["Keyword"] for r in rows}) == 4     # no keyword collision on the wire


def test_native_title_comes_from_slot_wires_not_row_title(monkeypatch):
    """The engine compares Title to Analyte{N}Peptide; both must come from slot_wires."""
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [
        _shaped(uid="mk1:1", keyword="HPLC-IDENTITY", title="bpc157 - Identity (HPLC)", result="Conforms",
                unit=None, service_origin="mk1", peptide_id=101, slot=1, analysis_service_id=901)])
    monkeypatch.setattr(lr, "slot_wires", lambda db, parent: _wires("BPC-157"))
    assert build_legacy_rows(None, _native_parent())[0]["Title"] == "BPC-157 - Identity (HPLC)"


def test_native_unresolved_slot_aborts(monkeypatch):
    from coa.hplc_shim import SlotWire, UnresolvedNativeSlotError
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [
        _shaped(uid="mk1:1", keyword="HPLC-PURITY", title="Mystery - Purity (HPLC)", result="98", unit="%",
                service_origin="mk1", peptide_id=None, slot=1, analysis_service_id=902)])
    monkeypatch.setattr(lr, "slot_wires", lambda db, parent: [SlotWire(1, "Mystery", None, "unresolved")])
    with pytest.raises(UnresolvedNativeSlotError) as ei:
        build_legacy_rows(None, _native_parent())
    assert "slot 1" in ei.value.detail


def test_native_row_without_wire_slot_aborts(monkeypatch):
    """A trio row whose slot has no entry in slot_wires (registry/rows drift) aborts loudly."""
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [
        _shaped(uid="mk1:1", keyword="HPLC-PURITY", title="x", result="98", unit="%", service_origin="mk1",
                peptide_id=101, slot=3, analysis_service_id=902)])
    monkeypatch.setattr(lr, "slot_wires", lambda db, parent: _wires("BPC-157"))
    with pytest.raises(NativeSectionsError):
        build_legacy_rows(None, _native_parent())


def test_other_mk1_families_still_filtered_on_native_parent(monkeypatch):
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [
        _shaped(uid="mk1:1", keyword="HPLC-PURITY", title="x", result="98", unit="%", service_origin="mk1",
                peptide_id=101, slot=1, analysis_service_id=902),
        _shaped(uid="mk1:200", keyword="STERILITY-USP71", service_origin="mk1"),
    ])
    monkeypatch.setattr(lr, "slot_wires", lambda db, parent: _wires("BPC-157"))
    assert [r["Keyword"] for r in build_legacy_rows(None, _native_parent())] == ["HPLC-PUR"]


def test_native_registry_peptide_drift_aborts(monkeypatch):
    """F1: row peptide_id != registry (slot_wires) peptide_id — relabel drift, never
    silently ride the registry's title over the row's verdict (P-1611/P-1500 class)."""
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [
        _shaped(uid="mk1:1", keyword="HPLC-IDENTITY", title="Old - Identity (HPLC)", result="Conforms",
                unit=None, service_origin="mk1", peptide_id=101, slot=1, analysis_service_id=901)])
    from coa.hplc_shim import SlotWire
    monkeypatch.setattr(lr, "slot_wires", lambda db, parent: [SlotWire(1, "New", 102, None)])
    with pytest.raises(NativeSectionsError) as ei:
        build_legacy_rows(None, _native_parent())
    msg = str(ei.value)
    assert "101" in msg and "102" in msg and "slot 1" in msg


def test_native_registry_slot_without_rows_aborts(monkeypatch):
    """F3: a blend with a registry slot (2) that has no admitted trio rows aborts —
    the drift guard must run both directions."""
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [
        _shaped(uid="mk1:1", keyword="HPLC-PURITY", title="x", result="98", unit="%", service_origin="mk1",
                peptide_id=101, slot=1, analysis_service_id=902),
    ])
    monkeypatch.setattr(lr, "slot_wires", lambda db, parent: _wires("BPC-157", "TB-500"))
    with pytest.raises(NativeSectionsError) as ei:
        build_legacy_rows(None, _native_parent(sample_id="PB-1002"))
    assert "slot 2" in str(ei.value) or "registry slot 2" in str(ei.value)

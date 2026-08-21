"""Service-level tests for worksheet→analyst stamping (spec 2026-06-07)."""
from sqlalchemy import insert, select

from models import (
    AnalysisService,
    Department,
    LimsAnalysis,
    LimsSample,
    LimsSubSample,
    LimsSubSampleEvent,
    ServiceGroup,
    User,
    VialRole,
    service_group_members,
)
from lims_analyses.worksheet_analyst import (
    clear_for_item,
    restamp_for_worksheet,
    stamp_for_item,
)


def _mk_parent(db, sample_id="P-T-001"):
    p = LimsSample(sample_id=sample_id, external_lims_uid=f"SEN-{sample_id}")
    db.add(p)
    db.flush()
    return p


def _mk_sub(db, parent, sample_id="P-T-001-S01", uid="mk1://sub-1", role="ster"):
    s = LimsSubSample(
        sample_id=sample_id,
        parent_sample_pk=parent.id,
        vial_sequence=1,
        external_lims_uid=uid,
        assignment_role=role,
    )
    db.add(s)
    db.flush()
    return s


def _mk_group(db, name):
    g = ServiceGroup(name=name)
    db.add(g)
    db.flush()
    return g


def _mk_service(db, keyword, title, group=None, department=None):
    svc = AnalysisService(keyword=keyword, title=title)
    if department is not None:
        svc.department_id = department.id
    db.add(svc)
    db.flush()
    if group is not None:
        db.execute(insert(service_group_members).values(
            analysis_service_id=svc.id, service_group_id=group.id,
        ))
    return svc


def _mk_department(db, name):
    d = Department(name=name)
    db.add(d)
    db.flush()
    return d


def _mk_vial_role(db, code, department):
    r = VialRole(code=code, label=code, department_id=department.id if department else None)
    db.add(r)
    db.flush()
    return r


def _mk_analysis(db, sub, svc, state="unassigned"):
    a = LimsAnalysis(
        lims_sub_sample_pk=sub.id,
        analysis_service_id=svc.id,
        keyword=svc.keyword,
        title=svc.title,
        review_state=state,
    )
    db.add(a)
    db.flush()
    return a


def _mk_user(db, email):
    u = User(email=email, hashed_password="x")
    db.add(u)
    db.flush()
    return u


def _events(db, sub):
    return db.query(LimsSubSampleEvent).filter_by(sub_sample_pk=sub.id).all()


def test_stamp_matching_group_only(db_session):
    """HPLC analyses on a ster vial (the P-0142-S02 shape): an Analytics-group
    item stamps only Analytics analyses; Microbiology rows untouched."""
    parent = _mk_parent(db_session)
    sub = _mk_sub(db_session, parent)
    analytics = _mk_group(db_session, "Analytics")
    micro = _mk_group(db_session, "Microbiology")
    svc_hplc = _mk_service(db_session, "HPLC-PUR", "Peptide Purity (HPLC)", analytics)
    svc_ster = _mk_service(db_session, "STER-PCR", "Rapid Sterility (PCR)", micro)
    a_hplc = _mk_analysis(db_session, sub, svc_hplc)
    a_ster = _mk_analysis(db_session, sub, svc_ster)
    tech = _mk_user(db_session, "tech@lab.test")
    actor = _mk_user(db_session, "lead@lab.test")

    n = stamp_for_item(
        db_session,
        sample_uid="mk1://sub-1",
        service_group_id=analytics.id,
        analyst_user_id=tech.id,
        acting_user_id=actor.id,
        worksheet_id=7,
        worksheet_title="HPLC Bench A",
    )

    assert n == 1
    db_session.refresh(a_hplc); db_session.refresh(a_ster)
    assert a_hplc.analyst_user_id == tech.id
    assert a_ster.analyst_user_id is None
    evs = _events(db_session, sub)
    assert len(evs) == 1
    ev = evs[0]
    assert ev.event == "worksheet_assigned"
    assert ev.user_id == actor.id
    assert ev.details["worksheet_id"] == 7
    assert ev.details["analyst_email"] == "tech@lab.test"
    assert ev.details["keywords"] == ["HPLC-PUR"]


def test_stamp_null_group_stamps_all_live(db_session):
    """Item with service_group_id None stamps all live analyses on the vial."""
    parent = _mk_parent(db_session)
    sub = _mk_sub(db_session, parent)
    g = _mk_group(db_session, "Analytics")
    a1 = _mk_analysis(db_session, sub, _mk_service(db_session, "K1", "T1", g))
    a2 = _mk_analysis(db_session, sub, _mk_service(db_session, "K2", "T2", None))
    tech = _mk_user(db_session, "tech@lab.test")

    n = stamp_for_item(
        db_session, sample_uid="mk1://sub-1", service_group_id=None,
        analyst_user_id=tech.id, acting_user_id=None, worksheet_id=1,
    )
    assert n == 2
    db_session.refresh(a1); db_session.refresh(a2)
    assert a1.analyst_user_id == tech.id and a2.analyst_user_id == tech.id


def test_dead_states_never_stamped(db_session):
    parent = _mk_parent(db_session)
    sub = _mk_sub(db_session, parent)
    g = _mk_group(db_session, "Analytics")
    svc = _mk_service(db_session, "K1", "T1", g)
    dead = _mk_analysis(db_session, sub, svc, state="retracted")
    tech = _mk_user(db_session, "tech@lab.test")

    n = stamp_for_item(
        db_session, sample_uid="mk1://sub-1", service_group_id=g.id,
        analyst_user_id=tech.id, acting_user_id=None, worksheet_id=1,
    )
    assert n == 0
    db_session.refresh(dead)
    assert dead.analyst_user_id is None
    # the add still happened — event recorded with empty keywords
    assert _events(db_session, sub)[0].details["keywords"] == []


def test_parent_ar_uid_noops(db_session):
    """A SENAITE parent-AR uid matches no lims_sub_samples row → no-op, no event."""
    parent = _mk_parent(db_session)
    sub = _mk_sub(db_session, parent)
    n = stamp_for_item(
        db_session, sample_uid="SEN-P-T-001", service_group_id=None,
        analyst_user_id=None, acting_user_id=None, worksheet_id=1,
    )
    assert n == 0
    assert _events(db_session, sub) == []


def test_clear_for_item(db_session):
    parent = _mk_parent(db_session)
    sub = _mk_sub(db_session, parent)
    g = _mk_group(db_session, "Analytics")
    a = _mk_analysis(db_session, sub, _mk_service(db_session, "K1", "T1", g))
    tech = _mk_user(db_session, "tech@lab.test")
    a.analyst_user_id = tech.id
    db_session.flush()

    n = clear_for_item(
        db_session, sample_uid="mk1://sub-1", service_group_id=g.id,
        acting_user_id=tech.id, worksheet_id=3,
    )
    assert n == 1
    db_session.refresh(a)
    assert a.analyst_user_id is None
    evs = _events(db_session, sub)
    assert evs[-1].event == "worksheet_removed"
    assert evs[-1].details["worksheet_id"] == 3


def test_restamp_emits_changed_only_when_values_change(db_session):
    """restamp updates rows + emits worksheet_analyst_changed per affected vial;
    re-running with the same analyst is a no-op (no duplicate events)."""
    from models import Worksheet, WorksheetItem

    parent = _mk_parent(db_session)
    sub = _mk_sub(db_session, parent)
    g = _mk_group(db_session, "Analytics")
    a = _mk_analysis(db_session, sub, _mk_service(db_session, "K1", "T1", g))
    old = _mk_user(db_session, "old@lab.test")
    new = _mk_user(db_session, "new@lab.test")
    a.analyst_user_id = old.id

    ws = Worksheet(title="Bench", assigned_analyst_id=new.id)
    db_session.add(ws); db_session.flush()
    db_session.add(WorksheetItem(
        worksheet_id=ws.id, sample_uid="mk1://sub-1", sample_id=sub.sample_id,
        service_group_id=g.id,
    ))
    db_session.flush()

    n = restamp_for_worksheet(db_session, worksheet=ws, acting_user_id=new.id)
    assert n == 1
    db_session.refresh(a)
    assert a.analyst_user_id == new.id
    evs = [e for e in _events(db_session, sub) if e.event == "worksheet_analyst_changed"]
    assert len(evs) == 1
    assert evs[0].details["from_email"] == "old@lab.test"
    assert evs[0].details["to_email"] == "new@lab.test"

    # idempotent re-run: values unchanged → no new event
    n2 = restamp_for_worksheet(db_session, worksheet=ws, acting_user_id=new.id)
    assert n2 == 0
    evs2 = [e for e in _events(db_session, sub) if e.event == "worksheet_analyst_changed"]
    assert len(evs2) == 1


def test_restamp_falls_back_to_item_analyst(db_session):
    """Worksheet with no worksheet-level analyst → restamp uses the item's
    own assigned_analyst_id (the `or` fallback branch)."""
    from models import Worksheet, WorksheetItem

    parent = _mk_parent(db_session)
    sub = _mk_sub(db_session, parent)
    g = _mk_group(db_session, "Analytics")
    a = _mk_analysis(db_session, sub, _mk_service(db_session, "K1", "T1", g))
    tech = _mk_user(db_session, "tech@lab.test")

    ws = Worksheet(title="Bench", assigned_analyst_id=None)
    db_session.add(ws); db_session.flush()
    db_session.add(WorksheetItem(
        worksheet_id=ws.id, sample_uid="mk1://sub-1", sample_id=sub.sample_id,
        service_group_id=g.id, assigned_analyst_id=tech.id,
    ))
    db_session.flush()

    n = restamp_for_worksheet(db_session, worksheet=ws, acting_user_id=tech.id)
    assert n == 1
    db_session.refresh(a)
    assert a.analyst_user_id == tech.id
    evs = [e for e in _events(db_session, sub) if e.event == "worksheet_analyst_changed"]
    assert len(evs) == 1
    assert evs[0].details["to_email"] == "tech@lab.test"


def test_senaite_shape_surfaces_analyst_email(db_session):
    """Nameless analyst → display name falls back to email; unstamped rows → None.
    (Locks the email-fallback branch of user_display_name through the serializer.)"""
    from lims_analyses.service import list_analyses_in_senaite_shape

    parent = _mk_parent(db_session)
    sub = _mk_sub(db_session, parent)
    g = _mk_group(db_session, "Analytics")
    a1 = _mk_analysis(db_session, sub, _mk_service(db_session, "K1", "T1", g))
    a2 = _mk_analysis(db_session, sub, _mk_service(db_session, "K2", "T2", g))
    tech = _mk_user(db_session, "tech@lab.test")
    a1.analyst_user_id = tech.id
    db_session.flush()

    shaped = list_analyses_in_senaite_shape(
        db_session, host_kind="sub_sample", host_pk=sub.id
    )
    by_kw = {s.keyword: s for s in shaped}
    assert by_kw["K1"].analyst == "tech@lab.test"
    assert by_kw["K2"].analyst is None


def test_hooks_import(db_session):
    """The main.py hooks import the module lazily — lock the import path."""
    from lims_analyses.worksheet_analyst import (  # noqa: F401
        clear_for_item,
        restamp_for_worksheet,
        stamp_for_item,
    )


def test_restamp_unassign_clears_stamp(db_session):
    """Unassigning the worksheet analyst (effective None) clears the vial stamp
    and emits a worksheet_analyst_changed event with to_email None — the
    semantics update_worksheet's `0 → None` coercion now relies on."""
    from models import Worksheet, WorksheetItem

    parent = _mk_parent(db_session)
    sub = _mk_sub(db_session, parent)
    g = _mk_group(db_session, "Analytics")
    a = _mk_analysis(db_session, sub, _mk_service(db_session, "K1", "T1", g))
    tech = _mk_user(db_session, "tech@lab.test")
    a.analyst_user_id = tech.id

    ws = Worksheet(title="Bench", assigned_analyst_id=tech.id)
    db_session.add(ws); db_session.flush()
    item = WorksheetItem(
        worksheet_id=ws.id, sample_uid="mk1://sub-1", sample_id=sub.sample_id,
        service_group_id=g.id, assigned_analyst_id=tech.id,
    )
    db_session.add(item)
    db_session.flush()

    # Simulate the endpoint's unassign: both worksheet- and item-level → None.
    ws.assigned_analyst_id = None
    item.assigned_analyst_id = None
    db_session.flush()

    n = restamp_for_worksheet(db_session, worksheet=ws, acting_user_id=tech.id)
    assert n == 1
    db_session.refresh(a)
    assert a.analyst_user_id is None
    evs = [e for e in _events(db_session, sub) if e.event == "worksheet_analyst_changed"]
    assert len(evs) == 1
    assert evs[0].details["to_email"] is None
    assert evs[0].details["from_email"] == "tech@lab.test"


def test_senaite_shape_analyst_uses_display_name(db_session):
    """Analyst column shows 'First Last' when set, single name with one, email when none."""
    from lims_analyses.service import list_analyses_in_senaite_shape

    parent = _mk_parent(db_session)
    sub = _mk_sub(db_session, parent)
    g = _mk_group(db_session, "Analytics")
    a_full = _mk_analysis(db_session, sub, _mk_service(db_session, "K1", "T1", g))
    a_first = _mk_analysis(db_session, sub, _mk_service(db_session, "K2", "T2", g))
    a_none = _mk_analysis(db_session, sub, _mk_service(db_session, "K3", "T3", g))

    full = _mk_user(db_session, "full@lab.test")
    full.first_name = "Ada"; full.last_name = "Lovelace"
    first_only = _mk_user(db_session, "first@lab.test")
    first_only.first_name = "Grace"
    nameless = _mk_user(db_session, "nameless@lab.test")
    db_session.flush()

    a_full.analyst_user_id = full.id
    a_first.analyst_user_id = first_only.id
    a_none.analyst_user_id = nameless.id
    db_session.flush()

    by_kw = {s.keyword: s for s in list_analyses_in_senaite_shape(
        db_session, host_kind="sub_sample", host_pk=sub.id)}
    assert by_kw["K1"].analyst == "Ada Lovelace"
    assert by_kw["K2"].analyst == "Grace"
    assert by_kw["K3"].analyst == "nameless@lab.test"


# ── department precedence + vial-role fallback (S2 Task 4) ─────────────────


def test_stamp_department_scoped(db_session):
    """Department-keyed twin of the group-scoped stamp case: only analyses whose
    service belongs to the department get the analyst."""
    parent = _mk_parent(db_session)
    sub = _mk_sub(db_session, parent)
    analytical = _mk_department(db_session, "Analytical")
    micro = _mk_department(db_session, "Microbiology")
    svc_hplc = _mk_service(db_session, "HPLC-PUR", "Peptide Purity (HPLC)", department=analytical)
    svc_ster = _mk_service(db_session, "STER-PCR", "Rapid Sterility (PCR)", department=micro)
    a_hplc = _mk_analysis(db_session, sub, svc_hplc)
    a_ster = _mk_analysis(db_session, sub, svc_ster)
    tech = _mk_user(db_session, "tech@lab.test")

    n = stamp_for_item(
        db_session,
        sample_uid="mk1://sub-1",
        service_group_id=None,
        department_id=analytical.id,
        analyst_user_id=tech.id,
        acting_user_id=None,
        worksheet_id=1,
    )

    assert n == 1
    db_session.refresh(a_hplc); db_session.refresh(a_ster)
    assert a_hplc.analyst_user_id == tech.id
    assert a_ster.analyst_user_id is None


def test_stamp_department_wins_over_group(db_session):
    """Both provided → department filter is used (group join not consulted)."""
    parent = _mk_parent(db_session)
    sub = _mk_sub(db_session, parent)
    analytical = _mk_department(db_session, "Analytical")
    micro = _mk_department(db_session, "Microbiology")
    analytics_group = _mk_group(db_session, "Analytics")
    # In the passed GROUP but department is Microbiology — the group join
    # would stamp this row; the department filter must NOT.
    svc_in_group_wrong_dept = _mk_service(
        db_session, "HPLC-PUR", "Peptide Purity (HPLC)", group=analytics_group, department=micro,
    )
    # In the passed DEPARTMENT but not in any group — the department filter
    # must stamp this row even though the group join wouldn't find it.
    svc_in_dept_no_group = _mk_service(
        db_session, "ID_GHKCU", "GHK-Cu Identity (HPLC)", department=analytical,
    )
    a_group = _mk_analysis(db_session, sub, svc_in_group_wrong_dept)
    a_dept = _mk_analysis(db_session, sub, svc_in_dept_no_group)
    tech = _mk_user(db_session, "tech@lab.test")

    n = stamp_for_item(
        db_session,
        sample_uid="mk1://sub-1",
        service_group_id=analytics_group.id,
        department_id=analytical.id,
        analyst_user_id=tech.id,
        acting_user_id=None,
        worksheet_id=1,
    )

    assert n == 1
    db_session.refresh(a_group); db_session.refresh(a_dept)
    assert a_group.analyst_user_id is None
    assert a_dept.analyst_user_id == tech.id


def test_stamp_none_none_still_wildcard(db_session):
    """department_id=None + service_group_id=None stamps ALL live analyses
    (historical group-less items keep their wildcard behavior)."""
    parent = _mk_parent(db_session)
    sub = _mk_sub(db_session, parent)
    a1 = _mk_analysis(db_session, sub, _mk_service(db_session, "K1", "T1"))
    a2 = _mk_analysis(db_session, sub, _mk_service(db_session, "K2", "T2"))
    tech = _mk_user(db_session, "tech@lab.test")

    n = stamp_for_item(
        db_session,
        sample_uid="mk1://sub-1",
        service_group_id=None,
        department_id=None,
        analyst_user_id=tech.id,
        acting_user_id=None,
        worksheet_id=1,
    )

    assert n == 2
    db_session.refresh(a1); db_session.refresh(a2)
    assert a1.analyst_user_id == tech.id and a2.analyst_user_id == tech.id


def test_stamp_department_role_fallback_usp71(db_session):
    """The incident regression: a 'ster' vial whose STERILITY_USP71 service has
    department_id=NULL (department join yields zero rows). Because the vial's
    assignment_role 'ster' maps to the Microbiology department, stamping with
    the Microbiology department stamps ALL live analyses instead of no-oping."""
    parent = _mk_parent(db_session)
    sub = _mk_sub(db_session, parent, role="ster")
    micro = _mk_department(db_session, "Microbiology")
    _mk_vial_role(db_session, "ster", micro)
    svc = _mk_service(db_session, "STERILITY_USP71", "Sterility (USP71)")  # no department, no group
    a = _mk_analysis(db_session, sub, svc)
    tech = _mk_user(db_session, "tech@lab.test")

    n = stamp_for_item(
        db_session,
        sample_uid="mk1://sub-1",
        service_group_id=None,
        department_id=micro.id,
        analyst_user_id=tech.id,
        acting_user_id=None,
        worksheet_id=1,
    )

    assert n == 1
    db_session.refresh(a)
    assert a.analyst_user_id == tech.id


def test_stamp_department_no_fallback_when_role_mismatch(db_session):
    """Same zero-row department join, but the vial's role maps to a DIFFERENT
    department → no stamp (fallback must not fire cross-department)."""
    parent = _mk_parent(db_session)
    sub = _mk_sub(db_session, parent, role="ster")
    analytical = _mk_department(db_session, "Analytical")
    micro = _mk_department(db_session, "Microbiology")
    _mk_vial_role(db_session, "ster", analytical)  # role maps to Analytical, not Microbiology
    svc = _mk_service(db_session, "STERILITY_USP71", "Sterility (USP71)")
    a = _mk_analysis(db_session, sub, svc)
    tech = _mk_user(db_session, "tech@lab.test")

    n = stamp_for_item(
        db_session,
        sample_uid="mk1://sub-1",
        service_group_id=None,
        department_id=micro.id,
        analyst_user_id=tech.id,
        acting_user_id=None,
        worksheet_id=1,
    )

    assert n == 0
    db_session.refresh(a)
    assert a.analyst_user_id is None


def test_clear_department_role_fallback(db_session):
    """The clear-side mirror of the fallback regression: a vial stamped via the
    role fallback must be clearable via the same fallback, or removal from a
    worksheet leaves an orphaned analyst stamp forever."""
    parent = _mk_parent(db_session)
    sub = _mk_sub(db_session, parent, role="ster")
    micro = _mk_department(db_session, "Microbiology")
    _mk_vial_role(db_session, "ster", micro)
    svc = _mk_service(db_session, "STERILITY_USP71", "Sterility (USP71)")
    a = _mk_analysis(db_session, sub, svc)
    tech = _mk_user(db_session, "tech@lab.test")
    a.analyst_user_id = tech.id
    db_session.flush()

    n = clear_for_item(
        db_session,
        sample_uid="mk1://sub-1",
        service_group_id=None,
        department_id=micro.id,
        acting_user_id=tech.id,
        worksheet_id=3,
    )

    assert n == 1
    db_session.refresh(a)
    assert a.analyst_user_id is None


def test_restamp_uses_item_department_id(db_session):
    """restamp_for_worksheet reads item.department_id (Task 1's column) and
    passes it through to _resolve — the department path is reachable from the
    worksheet-level entry point, not just stamp_for_item directly."""
    from models import Worksheet, WorksheetItem

    parent = _mk_parent(db_session)
    sub = _mk_sub(db_session, parent)
    analytical = _mk_department(db_session, "Analytical")
    micro = _mk_department(db_session, "Microbiology")
    svc_hplc = _mk_service(db_session, "HPLC-PUR", "Peptide Purity (HPLC)", department=analytical)
    svc_ster = _mk_service(db_session, "STER-PCR", "Rapid Sterility (PCR)", department=micro)
    a_hplc = _mk_analysis(db_session, sub, svc_hplc)
    a_ster = _mk_analysis(db_session, sub, svc_ster)
    new = _mk_user(db_session, "new@lab.test")

    ws = Worksheet(title="Bench", assigned_analyst_id=new.id)
    db_session.add(ws); db_session.flush()
    db_session.add(WorksheetItem(
        worksheet_id=ws.id, sample_uid="mk1://sub-1", sample_id=sub.sample_id,
        service_group_id=None, department_id=analytical.id,
    ))
    db_session.flush()

    n = restamp_for_worksheet(db_session, worksheet=ws, acting_user_id=new.id)

    assert n == 1
    db_session.refresh(a_hplc); db_session.refresh(a_ster)
    assert a_hplc.analyst_user_id == new.id
    assert a_ster.analyst_user_id is None

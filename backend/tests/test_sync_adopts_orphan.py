"""sync_analysis_services must adopt an orphaned row when SENAITE recreates a
service under a new id/UID, rather than inserting a duplicate keyword.

Root cause of the TB500 promote 502: SENAITE deleted+recreated the TB500 identity
services (new UIDs); the sync matched only by senaite_id, so it cloned the keyword
and orphaned the original. Adopting the orphan keeps the row id stable (preserving
all lims_analyses / peptide_analytes references).
"""
import asyncio

from sqlalchemy import select

import main
from models import AnalysisService


class _Resp:
    def __init__(self, payload):
        self._p = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self._p


def _fake_get(services):
    def get(url, **kw):
        if kw.get("params", {}).get("portal_type") == "AnalysisService":
            return _Resp({"items": services})
        return _Resp({"items": []})  # AnalysisCategory pull
    return get


def _run(db):
    return asyncio.run(main.sync_analysis_services(db=db, _current_user=None))


def test_recreated_service_adopts_orphan(db_session, monkeypatch):
    # Orphan: keyword exists with a stale senaite_id absent from the SENAITE pull.
    db_session.add(AnalysisService(
        title="TB500 (Thymosin Beta 4) - Identity (HPLC)", keyword="ID_TB500BETA4",
        senaite_id="analysisservice-25", senaite_uid="OLDUID", peptide_id=63))
    db_session.commit()
    orphan_id = db_session.execute(
        select(AnalysisService.id).where(AnalysisService.keyword == "ID_TB500BETA4")
    ).scalar_one()

    monkeypatch.setattr("httpx.get", _fake_get([{
        "id": "analysisservice-30", "uid": "NEWUID",
        "title": "TB500 (Thymosin Beta 4) - Identity (HPLC)",
        "getKeyword": "ID_TB500BETA4",
    }]))
    monkeypatch.setattr(main, "SENAITE_URL", "http://senaite.test")

    _run(db_session)

    rows = db_session.execute(
        select(AnalysisService).where(AnalysisService.keyword == "ID_TB500BETA4")
    ).scalars().all()
    assert len(rows) == 1                       # adopted, NOT cloned
    assert rows[0].id == orphan_id              # same row → references preserved
    assert rows[0].senaite_id == "analysisservice-30"
    assert rows[0].senaite_uid == "NEWUID"


def test_matching_senaite_id_updates_in_place(db_session, monkeypatch):
    db_session.add(AnalysisService(
        title="X - Identity", keyword="ID_X",
        senaite_id="analysisservice-50", senaite_uid="U", peptide_id=1))
    db_session.commit()
    monkeypatch.setattr("httpx.get", _fake_get([{
        "id": "analysisservice-50", "uid": "U", "title": "X - Identity", "getKeyword": "ID_X"}]))
    monkeypatch.setattr(main, "SENAITE_URL", "http://senaite.test")

    _run(db_session)

    rows = db_session.execute(
        select(AnalysisService).where(AnalysisService.keyword == "ID_X")).scalars().all()
    assert len(rows) == 1                       # no clone


def test_genuinely_new_keyword_inserts(db_session, monkeypatch):
    monkeypatch.setattr("httpx.get", _fake_get([{
        "id": "analysisservice-99", "uid": "U99", "title": "New - Identity", "getKeyword": "ID_NEW"}]))
    monkeypatch.setattr(main, "SENAITE_URL", "http://senaite.test")

    _run(db_session)

    rows = db_session.execute(
        select(AnalysisService).where(AnalysisService.keyword == "ID_NEW")).scalars().all()
    assert len(rows) == 1
    assert rows[0].senaite_id == "analysisservice-99"

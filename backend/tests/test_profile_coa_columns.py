"""COA columns on analysis_profiles: nullable archetype gates reportability.

Route-level test against a live DB, mirroring test_api_analysis_profiles.py's
pattern (module-scoped TestClient(app) + auth-override + cleanup) rather than
the ORM-level `db_session` fixture in test_analysis_profiles.py -- these tests
exercise route validation (COA_ARCHETYPES) and the response schema, neither of
which exist at the ORM layer.

Run in container:
    docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_profile_coa_columns.py -q'
"""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import auth
from database import engine
from main import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def _auth_override():
    app.dependency_overrides[auth.get_current_user] = lambda: {"id": 0, "username": "test"}
    try:
        yield
    finally:
        app.dependency_overrides.pop(auth.get_current_user, None)


@pytest.fixture(autouse=True)
def cleanup_profiles():
    with engine.connect() as c:
        before = {r[0] for r in c.execute(text("SELECT id FROM analysis_profiles")).fetchall()}
    yield
    with engine.begin() as c:
        after = {r[0] for r in c.execute(text("SELECT id FROM analysis_profiles")).fetchall()}
        new = list(after - before)
        if new:
            c.execute(text("DELETE FROM analysis_profiles WHERE id = ANY(:i)"), {"i": new})


def test_profile_coa_columns_roundtrip():
    r = client.post("/analysis-profiles", json={
        "key": "heavy_metals_coa_test", "name": "Heavy Metals", "is_addon": True,
    })
    assert r.status_code == 201, r.text
    body = r.json()
    # Defaults: not reported until the lab opts in.
    assert body["coa_archetype"] is None
    assert body["coa_section_title"] is None
    assert body["coa_sort_order"] == 0

    pid = body["id"]
    r = client.patch(f"/analysis-profiles/{pid}", json={
        "coa_archetype": "limit_table",
        "coa_section_title": "Heavy Metals Panel",
        "coa_sort_order": 10,
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["coa_archetype"] == "limit_table"
    assert body["coa_section_title"] == "Heavy Metals Panel"
    assert body["coa_sort_order"] == 10


def test_profile_coa_archetype_rejects_unknown_value():
    r = client.post("/analysis-profiles", json={
        "key": "hm2_coa_test", "name": "HM2", "is_addon": True,
    })
    pid = r.json()["id"]
    r = client.patch(f"/analysis-profiles/{pid}", json={"coa_archetype": "fancy_chart"})
    assert r.status_code == 400
    assert "limit_table" in r.json()["detail"]


def test_profile_coa_archetype_can_be_cleared():
    r = client.post("/analysis-profiles", json={
        "key": "hm3_coa_test", "name": "HM3", "is_addon": True,
    })
    pid = r.json()["id"]
    client.patch(f"/analysis-profiles/{pid}", json={"coa_archetype": "limit_table"})
    r = client.patch(f"/analysis-profiles/{pid}", json={"coa_archetype": None})
    assert r.status_code == 200
    assert r.json()["coa_archetype"] is None

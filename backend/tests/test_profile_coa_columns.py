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


def test_coa_display_fields_settable_at_create():
    # Section title and sort order are inert while coa_archetype is NULL
    # (build_native_sections skips the profile before reading either), so
    # accepting them at create is safe and saves a round-trip: the lab
    # configures the section up front, then arms it with one later PATCH.
    r = client.post("/analysis-profiles", json={
        "key": "hm_create_display_test", "name": "HM Display", "is_addon": True,
        "coa_section_title": "Heavy Metals Analysis", "coa_sort_order": 10,
    })
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["coa_section_title"] == "Heavy Metals Analysis"
    assert body["coa_sort_order"] == 10
    # ...but the profile is still NOT reported until archetype is set.
    assert body["coa_archetype"] is None


def test_coa_archetype_rejected_at_create():
    # Arming is deliberately a separate act: setting coa_archetype applies
    # RETROACTIVELY (fail-closed rule A2 refuses the whole COA for any sample
    # already carrying this profile key without a verified parent-tier row).
    # Silently ignoring it would let a caller believe they had gone live.
    r = client.post("/analysis-profiles", json={
        "key": "hm_create_archetype_test", "name": "HM Arch", "is_addon": True,
        "coa_archetype": "limit_table",
    })
    assert r.status_code == 400, r.text
    assert "coa_archetype" in r.json()["detail"]


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


def test_profile_patch_coa_display_fields():
    r = client.post("/analysis-profiles", json={
        "key": "hm_display_fields_test", "name": "HM Display Fields", "is_addon": True,
    })
    assert r.status_code == 201, r.text
    pid = r.json()["id"]
    r = client.patch(f"/analysis-profiles/{pid}", json={
        "coa_basis_note": "USP <232> Parenteral PDE | MDD 50 mg/day",
        "coa_method_text": "MP-AES", "coa_prep_text": "100 mg / 10 mL digest",
        "coa_footnotes": [{"label": "Reporting.", "text": "µg/g = ppm."}],
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["coa_basis_note"].startswith("USP") and body["coa_footnotes"][0]["label"] == "Reporting."


def test_profile_footnotes_shape_rejected():
    r = client.post("/analysis-profiles", json={
        "key": "hm_footnotes_shape_test", "name": "HM Footnotes Shape", "is_addon": True,
    })
    assert r.status_code == 201, r.text
    pid = r.json()["id"]
    for bad in ("notalist", [{"label": "x"}], [{"label": "", "text": "y"}],
                [{"label": "a", "text": "b", "extra": 1}], [42]):
        r = client.patch(f"/analysis-profiles/{pid}", json={"coa_footnotes": bad})
        assert r.status_code == 400, bad


def test_profile_coa_fields_clear_to_null():
    r = client.post("/analysis-profiles", json={
        "key": "hm_clear_to_null_test", "name": "HM Clear", "is_addon": True,
    })
    assert r.status_code == 201, r.text
    pid = r.json()["id"]
    client.patch(f"/analysis-profiles/{pid}", json={"coa_method_text": "MP-AES"})
    r = client.patch(f"/analysis-profiles/{pid}", json={"coa_method_text": None})
    assert r.status_code == 200
    assert r.json()["coa_method_text"] is None


def test_coa_display_text_fields_settable_at_create():
    # Sibling of test_coa_display_fields_settable_at_create above, for the
    # four Task 3 fields — proves the create route's model_dump ->
    # constructor flow actually carries them (no parallel plumbing), not
    # just the PATCH setattr loop covered by test_profile_patch_coa_display_fields.
    r = client.post("/analysis-profiles", json={
        "key": "hm_create_display_text_test", "name": "HM Text", "is_addon": True,
        "coa_basis_note": "USP <232> Parenteral PDE | MDD 50 mg/day",
        "coa_method_text": "MP-AES", "coa_prep_text": "100 mg / 10 mL digest",
        "coa_footnotes": [{"label": "Reporting.", "text": "µg/g = ppm."}],
    })
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["coa_method_text"] == "MP-AES"
    assert body["coa_footnotes"][0]["text"] == "µg/g = ppm."


def test_coa_footnotes_shape_rejected_at_create():
    # Reachability check for _validate_coa_footnotes on the create route --
    # confirms it 400s (route-level validator) rather than 422 (Pydantic
    # type gate), the same distinction test_profile_footnotes_shape_rejected
    # exercises on PATCH.
    r = client.post("/analysis-profiles", json={
        "key": "hm_create_bad_footnotes_test", "name": "HM Bad", "is_addon": True,
        "coa_footnotes": [{"label": "a", "text": "b", "extra": 1}],
    })
    assert r.status_code == 400, r.text

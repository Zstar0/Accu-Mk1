# COA Read-Independence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With `coa_generation=mk1`, COA generation performs ZERO SENAITE reads — envelope, attachments, pre-flight gate, and resolver all serve from Accu-Mk1 data, fail-closed.

**Architecture:** Mk1's wire document gains a `sample_meta` block (envelope scalars in AR-key spellings + attachment descriptors with explicit roles); coab synthesizes its `sample_json` from it and downloads bytes from a new service-token Mk1 route instead of SENAITE. The COA pre-flight attachments gate and the source resolver swap to native readers in mk1 mode. Same presence-driven, fail-closed, twin-pinned pattern as the shipped `legacy_rows` slice.

**Tech Stack:** FastAPI + SQLAlchemy (Mk1), FastAPI + requests (coab), pytest both sides.

**Spec:** `docs/superpowers/specs/2026-08-28-coa-read-independence-design.md` (committed on this branch — read it first; every task argues from it).

## Global Constraints

- **R1 fail-closed:** in mk1 mode there is NEVER a SENAITE fallback. Missing/malformed `sample_meta` → 422; missing native attachment → blocked generation. The only permitted fallback is watermark → client logo (a WordPress URL).
- **R3:** no SENAITE WRITE path may be touched.
- **Additive only:** senaite mode (`sample_meta` absent) must stay byte-identical. Engines (`conformance.py`, `generic_assay_engine.py`) must NOT be edited.
- **Twin contract:** `SAMPLE_META_SCALARS`, `ATTACHMENT_ROLES`, and abort rules are byte-identical literals in both repos, pinned by `test_sample_meta_contract.py` in each. Move both together.
- **Worktrees:** Mk1 = `C:/tmp/mk1-coa-read-indep` (branch `feat/coa-read-independence`, exists). coab = `C:/tmp/coab-sample-meta` (branch `feat/coa-sample-meta-wire` — Task 7 creates it off `origin/master` from `C:/tmp/coab-deploy`).
- **Test gates:** Mk1 full-suite failures are compared as a SET against master baseline (118 known failures; never expect zero — run `python -m pytest backend/tests -q` and diff `^(FAILED|ERROR) +backend/` lines). coab suite must stay fully green except the one known `test_variance_page_4_analytes_vial1_from_parent` env failure.
- Mk1 tests run from the worktree root: `python -m pytest backend/tests/<file> -q`. coab tests: `python -m pytest tests/<file> -q` (set `SENAITE_URL=http://x SENAITE_USERNAME=x SENAITE_PASSWORD=x` and temporarily move an ignored root `app_settings.json` aside if collection errors appear).

---

### Task 0: Recon probes (read-only; informs Tasks 5, 10, 13 — do first, never blocks builds)

**Files:** none created in-repo. Output = a findings comment posted back to the orchestrator.

**Interfaces:**
- Produces: prod facts: (a) `CoaResultPin` row count, (b) chromatogram-snapshot coverage counts, (c) `coa_meta` watermark-key coverage, (d) IS webhook verbatim-forwarding verdict.

- [ ] **Step 1: Prod probes (read-only, via the sanctioned idiom)**

```bash
cat > /c/tmp/readindep_probe.py <<'EOF'
from database import SessionLocal
from sqlalchemy import text
db = SessionLocal()
print("coa_result_pins:", db.execute(text("SELECT count(*) FROM coa_result_pins")).scalar())
print("samples with hplc chromatogram_data:", db.execute(text(
  "SELECT count(DISTINCT s.id) FROM lims_samples s JOIN lims_sub_samples ss ON ss.parent_sample_pk=s.id "
  "JOIN samples hs ON hs.sub_sample_id=ss.id JOIN hplc_analyses ha ON ha.sample_id=hs.id "
  "WHERE ha.chromatogram_data IS NOT NULL")).scalar())
print("samples WITH native chromatogram row:", db.execute(text(
  "SELECT count(DISTINCT lims_sample_pk) FROM lims_parent_attachments WHERE kind='chromatogram' AND storage='s3'")).scalar())
print("samples WITH native sample image row:", db.execute(text(
  "SELECT count(DISTINCT lims_sample_pk) FROM lims_parent_attachments "
  "WHERE storage='s3' AND (kind='receive_image' OR attachment_type='Sample Image')")).scalar())
print("coa_meta rows containing ChromatographBackgroundUrl:", db.execute(text(
  "SELECT count(*) FROM lims_samples WHERE coa_meta LIKE '%ChromatographBackgroundUrl%'")).scalar())
print("total lims_samples:", db.execute(text("SELECT count(*) FROM lims_samples")).scalar())
db.close()
EOF
ssh root@165.227.241.81 "docker exec -w /app -i accu-mk1-backend python" < /c/tmp/readindep_probe.py
```
NOTE: if the `hplc` join names are wrong (they are best-effort), fix the join by reading `backend/models.py` for `HPLCAnalysis` (`chromatogram_data` column) and its sample-linkage — the number that matters is "parents with chromatogram_data" vs "parents with a native chromatogram attachment row".

- [ ] **Step 2: IS verbatim-forwarding verification**

Locate the integration-service repo: `ls /c/tmp | grep -i integ` and `ls "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace" | grep -i integ`. If absent: `git clone https://github.com/Zstar0/integration-service /c/tmp/is-readcheck` (try `ValenceAnalytical/integration-service` if 404). Read `app/api/webhook.py` around the additional-COA handler (spec 2026-07-28 names lines ~752-782): confirm the document fetched from Mk1 `GET /samples/{id}/coa-sections` is forwarded to coab `/process-additional` as `native_sections` **without filtering keys**. Report: VERBATIM or FILTERED (with the code lines).

- [ ] **Step 3: Report findings** — post all numbers + the IS verdict. If pins > 0, list them (`SELECT * FROM coa_result_pins`).

---

### Task 1: Mk1 — `build_sample_meta` producer

**Files:**
- Create: `backend/coa/sample_meta.py`
- Test: `backend/tests/test_sample_meta_producer.py`

**Interfaces:**
- Consumes: `models.LimsSample` (columns `sample_id, sample_type_title, client_sample_id, date_received, declared_total_quantity, client_lot, analytes, coa_meta, company_logo_url`), `models.LimsParentAttachment`, `coa.native_sections.NativeSectionsError`, `sub_samples.registry_details._resolve_wp_url` (reuse for logo URL absolutization; import inside the function).
- Produces: `build_sample_meta(db, parent) -> dict` (raises `NativeSectionsError`), module constants `SAMPLE_META_SCALARS`, `ATTACHMENT_ROLES`, env name `MK1_PUBLIC_BASE_URL`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_sample_meta_producer.py
"""sample_meta producer (read-independence spec §2): envelope scalars in
AR-key spellings + attachment descriptors with explicit roles. Fail-closed:
empty matrix aborts; missing MK1_PUBLIC_BASE_URL aborts; senaite-storage
rows are invisible."""
import json
import os
import pytest
from unittest.mock import patch

from database import SessionLocal
from models import LimsSample, LimsParentAttachment
from coa.native_sections import NativeSectionsError
from coa.sample_meta import build_sample_meta, SAMPLE_META_SCALARS, ATTACHMENT_ROLES


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.rollback()
    s.close()


@pytest.fixture
def parent(db):
    row = LimsSample(
        sample_id="TEST-SM-01", status="verified",
        sample_type_title="Peptide Blend", client_sample_id="CS-1",
        declared_total_quantity="20.0", client_lot="LOT-9",
        analytes=json.dumps({"1": {"label": "BPC-157"}, "2": {"label": "GHK-Cu"}}),
        coa_meta=json.dumps({"CoaCompanyName": "Acme", "CoaEmail": "a@b.c",
                             "CoaWebsite": "acme.io", "CoaAddress": "1 Way"}),
        company_logo_url="/wp-content/logo.png",
    )
    db.add(row); db.flush()
    img = LimsParentAttachment(
        lims_sample_pk=row.id, kind="receive_image", filename="img.png",
        content_type="image/png", storage="s3", storage_key="k1",
        render_in_report=True, attachment_type="Sample Image",
        created_by_user_id=None)
    csv = LimsParentAttachment(
        lims_sample_pk=row.id, kind="chromatogram", filename="chrom.csv",
        content_type="text/csv", storage="s3", storage_key="k2",
        render_in_report=False, attachment_type="HPLC Graph",
        created_by_user_id=None)
    db.add_all([img, csv]); db.flush()
    yield row, img, csv


ENV = {"MK1_PUBLIC_BASE_URL": "https://mk1.test"}


def test_scalars_use_ar_key_spellings(db, parent):
    row, img, csv = parent
    with patch.dict(os.environ, ENV):
        meta = build_sample_meta(db, row)
    assert meta["source"] == "mk1"
    assert meta["SampleID"] == "TEST-SM-01"
    assert meta["SampleTypeTitle"] == "Peptide Blend"
    assert meta["ClientSampleID"] == "CS-1"
    assert meta["DeclaredTotalQuantity"] == "20.0"
    assert meta["ClientLot"] == "LOT-9"
    assert meta["BatchID"] == "LOT-9"          # peptide-engine alias
    assert meta["Analyte1Peptide"] == "BPC-157"
    assert meta["Analyte2Peptide"] == "GHK-Cu"
    assert "Analyte3Peptide" not in meta        # absent slots omitted
    assert meta["CoaCompanyName"] == "Acme"
    for k in SAMPLE_META_SCALARS:
        assert k in meta or k in ("ChromatographBackgroundUrl",)  # nullable


def test_attachment_descriptors_roles_and_urls(db, parent):
    row, img, csv = parent
    with patch.dict(os.environ, ENV):
        meta = build_sample_meta(db, row)
    by_role = {a["role"]: a for a in meta["attachments"]}
    assert set(by_role) == {"sample_image", "chromatogram_csv"}
    assert set(by_role) <= ATTACHMENT_ROLES
    a = by_role["sample_image"]
    assert a["attachment_id"] == img.id
    assert a["content_type"] == "image/png"
    assert a["url"] == f"https://mk1.test/s2s/samples/TEST-SM-01/attachments/{img.id}"
    assert by_role["chromatogram_csv"]["attachment_id"] == csv.id


def test_newest_eligible_row_wins(db, parent):
    row, img, csv = parent
    newer = LimsParentAttachment(
        lims_sample_pk=row.id, kind="receive_image", filename="img2.png",
        content_type="image/png", storage="s3", storage_key="k3",
        render_in_report=True, attachment_type="Sample Image",
        created_by_user_id=None)
    db.add(newer); db.flush()
    with patch.dict(os.environ, ENV):
        meta = build_sample_meta(db, row)
    by_role = {a["role"]: a for a in meta["attachments"]}
    assert by_role["sample_image"]["attachment_id"] == newer.id


def test_senaite_storage_rows_invisible(db, parent):
    row, img, csv = parent
    img.storage = "senaite"
    db.flush()
    with patch.dict(os.environ, ENV):
        meta = build_sample_meta(db, row)
    roles = {a["role"] for a in meta["attachments"]}
    assert "sample_image" not in roles


def test_empty_matrix_aborts(db, parent):
    row, *_ = parent
    row.sample_type_title = ""
    db.flush()
    with patch.dict(os.environ, ENV), pytest.raises(NativeSectionsError):
        build_sample_meta(db, row)


def test_missing_base_url_aborts(db, parent):
    row, *_ = parent
    with patch.dict(os.environ, {"MK1_PUBLIC_BASE_URL": ""}), \
         pytest.raises(NativeSectionsError):
        build_sample_meta(db, row)
```

- [ ] **Step 2: Run to verify FAIL** — `python -m pytest backend/tests/test_sample_meta_producer.py -q` → import error `No module named 'coa.sample_meta'`.

- [ ] **Step 3: Implement `backend/coa/sample_meta.py`**

```python
"""sample_meta producer (COA read-independence, spec §2).

Envelope scalars carry the AR-blob key SPELLINGS coab's engines read, so the
consumer synthesizes its sample_json without touching the engines. Attachment
descriptors carry explicit roles + absolute S2S download URLs — coab never
walks a SENAITE attachment list. Fail-closed (R1): empty matrix or missing
MK1_PUBLIC_BASE_URL aborts assembly; storage!='s3' rows are invisible.

Twin contract: SAMPLE_META_SCALARS + ATTACHMENT_ROLES are byte-identical in
coabuilder src/coabuilder_core/sample_meta.py and pinned by
test_sample_meta_contract.py in BOTH repos. Move together.
"""
import json
import os

from sqlalchemy import select

from coa.native_sections import NativeSectionsError

SAMPLE_META_SCALARS = (
    "SampleID", "SampleTypeTitle", "ClientSampleID", "DateReceived",
    "DeclaredTotalQuantity", "ClientLot", "BatchID",
    "CoaCompanyName", "CoaEmail", "CoaWebsite", "CoaAddress",
    "CompanyLogoUrl", "ChromatographBackgroundUrl",
)
ATTACHMENT_ROLES = frozenset({"sample_image", "chromatogram_csv"})
BASE_URL_ENV = "MK1_PUBLIC_BASE_URL"


def _coa_meta(parent) -> dict:
    try:
        parsed = json.loads(parent.coa_meta) if parent.coa_meta else {}
        return parsed if isinstance(parsed, dict) else {}
    except (ValueError, TypeError):
        return {}


def _analyte_slots(parent) -> dict:
    """{'Analyte1Peptide': label, ...} for slots 1..4 with a label."""
    try:
        slots = json.loads(parent.analytes) if parent.analytes else {}
    except (ValueError, TypeError):
        return {}
    out = {}
    if isinstance(slots, dict):
        for n in ("1", "2", "3", "4"):
            label = (slots.get(n) or {}).get("label") if isinstance(slots.get(n), dict) else None
            if label:
                out[f"Analyte{n}Peptide"] = label
    return out


def _newest(db, parent_pk: int, *, chromatogram: bool):
    from models import LimsParentAttachment as A
    q = select(A).where(A.lims_sample_pk == parent_pk, A.storage == "s3")
    if chromatogram:
        q = q.where(A.kind == "chromatogram")
    else:
        q = q.where(
            A.render_in_report.is_(True),
            (A.kind == "receive_image") | (A.attachment_type == "Sample Image"),
        )
    return db.execute(q.order_by(A.id.desc()).limit(1)).scalar_one_or_none()


def build_sample_meta(db, parent) -> dict:
    base = (os.environ.get(BASE_URL_ENV) or "").rstrip("/")
    if not base:
        raise NativeSectionsError(
            f"sample_meta: {BASE_URL_ENV} is not configured — cannot mint "
            f"attachment URLs; refusing to assemble (fail-closed)")
    if not (parent.sample_type_title or "").strip():
        raise NativeSectionsError(
            f"sample_meta: {parent.sample_id} has no sample_type_title — the "
            f"matrix selects the rendering engine; aborting")

    from sub_samples.registry_details import _resolve_wp_url
    cm = _coa_meta(parent)
    lot = parent.client_lot or ""
    meta = {
        "source": "mk1",
        "SampleID": parent.sample_id,
        "SampleTypeTitle": parent.sample_type_title,
        "ClientSampleID": parent.client_sample_id or "",
        "DateReceived": parent.date_received.isoformat() if parent.date_received else "",
        "DeclaredTotalQuantity": parent.declared_total_quantity or "",
        "ClientLot": lot,
        "BatchID": lot,
        "CoaCompanyName": cm.get("CoaCompanyName", ""),
        "CoaEmail": cm.get("CoaEmail", ""),
        "CoaWebsite": cm.get("CoaWebsite", ""),
        "CoaAddress": cm.get("CoaAddress", ""),
        "CompanyLogoUrl": _resolve_wp_url(parent.company_logo_url) or "",
        "ChromatographBackgroundUrl": _resolve_wp_url(cm.get("ChromatographBackgroundUrl")) or None,
    }
    meta.update(_analyte_slots(parent))

    attachments = []
    for role, row in (("sample_image", _newest(db, parent.id, chromatogram=False)),
                      ("chromatogram_csv", _newest(db, parent.id, chromatogram=True))):
        if row is not None:
            attachments.append({
                "role": role,
                "attachment_id": row.id,
                "filename": row.filename,
                "content_type": row.content_type,
                "url": f"{base}/s2s/samples/{parent.sample_id}/attachments/{row.id}",
            })
    meta["attachments"] = attachments
    return meta
```
NOTE for implementer: check `_resolve_wp_url`'s real signature in `backend/sub_samples/registry_details.py` (~line 236) — if it needs a db/session or host argument, adapt the two call sites (and the test expectation for `CompanyLogoUrl` accordingly; the test may then patch it). If it returns None for empty input, the `or ""`/`or None` guards above already handle it.

- [ ] **Step 4: Run to verify PASS** — `python -m pytest backend/tests/test_sample_meta_producer.py -q` → all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/coa/sample_meta.py backend/tests/test_sample_meta_producer.py
git commit -m "feat(coa): sample_meta producer — native envelope + attachment descriptors"
```

---

### Task 2: Mk1 — wire `sample_meta` into the wire document + drift detector

**Files:**
- Modify: `backend/coa/wire_document.py`
- Test: `backend/tests/test_wire_document_sample_meta.py`

**Interfaces:**
- Consumes: `coa.sample_meta.build_sample_meta` (Task 1), `coa.source_setting.coa_generation_source`, existing `build_coa_wire_document` / `build_vial_wire_document` / `warn_if_source_ignored`.
- Produces: mk1-mode docs carry `sample_meta`; `warn_if_source_ignored(doc, response_json, sample_id)` warns when the doc carried `sample_meta` but `data_sources.sample_meta != "mk1"`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_wire_document_sample_meta.py
"""mk1-mode wire documents carry sample_meta beside legacy_rows (spec §2),
including the vial doc; senaite mode is untouched; the drift detector warns
when coab ignored the block."""
import logging
from unittest.mock import patch

import pytest

from coa import wire_document


@pytest.fixture
def mk1_mode():
    with patch.object(wire_document, "coa_generation_source", return_value="mk1"):
        yield


@pytest.fixture
def senaite_mode():
    with patch.object(wire_document, "coa_generation_source", return_value="senaite"):
        yield


def test_parent_doc_carries_sample_meta_in_mk1_mode(mk1_mode):
    with patch.object(wire_document, "build_native_sections",
                      return_value={"sample_id": "S", "ordered_profiles": [], "sections": []}), \
         patch.object(wire_document, "build_legacy_rows", return_value=[{"Keyword": "X"}]), \
         patch.object(wire_document, "build_sample_meta",
                      return_value={"source": "mk1", "SampleID": "S", "attachments": []}):
        doc = wire_document.build_coa_wire_document(object(), object())
    assert doc["sample_meta"]["source"] == "mk1"
    assert "legacy_rows" in doc


def test_parent_doc_omits_sample_meta_in_senaite_mode(senaite_mode):
    with patch.object(wire_document, "build_native_sections",
                      return_value={"sample_id": "S", "ordered_profiles": [], "sections": []}):
        doc = wire_document.build_coa_wire_document(object(), object())
    assert "sample_meta" not in doc and "legacy_rows" not in doc


def test_vial_doc_carries_sample_meta_in_mk1_mode(mk1_mode):
    with patch.object(wire_document, "build_legacy_rows", return_value=[{"Keyword": "X"}]), \
         patch.object(wire_document, "build_sample_meta",
                      return_value={"source": "mk1", "SampleID": "S", "attachments": []}):
        class P: sample_id = "S"
        doc = wire_document.build_vial_wire_document(object(), P())
    assert doc["sample_meta"]["source"] == "mk1"


def test_vial_doc_none_in_senaite_mode(senaite_mode):
    assert wire_document.build_vial_wire_document(object(), object()) is None


def test_drift_warns_on_ignored_sample_meta(caplog):
    doc = {"sample_meta": {"source": "mk1"}, "legacy_rows": {"source": "mk1"}}
    resp = {"data_sources": {"legacy_rows": "mk1"}}  # sample_meta missing
    with caplog.at_level(logging.WARNING):
        wire_document.warn_if_source_ignored(doc, resp, "S-1")
    assert any("sample_meta" in r.message for r in caplog.records)


def test_drift_quiet_when_both_honored(caplog):
    doc = {"sample_meta": {"source": "mk1"}, "legacy_rows": {"source": "mk1"}}
    resp = {"data_sources": {"legacy_rows": "mk1", "sample_meta": "mk1"}}
    with caplog.at_level(logging.WARNING):
        wire_document.warn_if_source_ignored(doc, resp, "S-1")
    assert not caplog.records
```

- [ ] **Step 2: Run to verify FAIL** — `python -m pytest backend/tests/test_wire_document_sample_meta.py -q` → fails (`build_sample_meta` not importable from wire_document / `sample_meta` key absent / no warning emitted).

- [ ] **Step 3: Implement in `backend/coa/wire_document.py`**

Add import `from coa.sample_meta import build_sample_meta`. In `build_coa_wire_document`, inside the existing `if coa_generation_source(db) == "mk1":` branch add `doc["sample_meta"] = build_sample_meta(db, parent)` (raises `NativeSectionsError` → existing fail-closed handling). In `build_vial_wire_document`'s mk1 return dict add `"sample_meta": build_sample_meta(db, parent),`. Extend `warn_if_source_ignored`: after the existing legacy_rows check, add the parallel block:

```python
    if doc and "sample_meta" in doc:
        used_meta = ((response_json or {}).get("data_sources") or {}).get("sample_meta")
        if used_meta != "mk1":
            log.warning(
                "COA source toggle is mk1 but COABuilder reported sample_meta "
                "source %r for %s — check the deployed COABuilder version",
                used_meta, sample_id,
            )
```
Also adjust the early-return guard so it no longer returns before this check when only `sample_meta` rides (change `if not doc or "legacy_rows" not in doc: return` into per-block guards).

- [ ] **Step 4: Run to verify PASS** — `python -m pytest backend/tests/test_wire_document_sample_meta.py backend/tests/test_legacy_rows_contract.py -q` → pass (legacy_rows contract untouched).

- [ ] **Step 5: Commit** — `git add backend/coa/wire_document.py backend/tests/test_wire_document_sample_meta.py && git commit -m "feat(coa): wire documents carry sample_meta in mk1 mode; drift detector covers it"`

---

### Task 3: Mk1 — S2S attachment bytes route

**Files:**
- Modify: `backend/main.py` (new route beside the S2S coa-sections route, ~line 21350)
- Test: `backend/tests/test_s2s_attachment_route.py`

**Interfaces:**
- Consumes: `auth.require_internal_service_token` (X-Service-Token header dep), `models.LimsParentAttachment`, `sub_samples.photo_storage.get_storage()` (`.load_photo(storage_key)`-style read — check the real read method name on `FilesystemPhotoStorage`/`S3PhotoStorage` in `backend/sub_samples/photo_storage.py` and mirror the existing user-JWT download route at `GET /registry/sample/{sample_id}/attachments/{attachment_id}/download` (~main.py:22019), which is the authoritative template for byte loading + headers).
- Produces: `GET /s2s/samples/{sample_id}/attachments/{attachment_id}` → bytes, `media_type` = DB row's `content_type` (NEVER the key extension — `.bin` trap), `Content-Disposition` filename from the row. 401/403 without valid token; 404 for unknown id, sample mismatch, or `storage != 's3'`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_s2s_attachment_route.py
"""S2S bytes route (spec §4): service-token gated, DB-row content-type,
storage!='s3' → 404. Modeled on the user-JWT download route's tests — reuse
that test file's fixtures/harness idioms (find them via
grep -rn "attachments.*download" backend/tests/)."""
import pytest
from fastapi.testclient import TestClient
from unittest.mock import patch

import main
from database import SessionLocal
from models import LimsSample, LimsParentAttachment

TOKEN = "test-service-token"


@pytest.fixture
def client():
    with patch.dict("os.environ", {"ACCUMK1_INTERNAL_SERVICE_TOKEN": TOKEN}):
        yield TestClient(main.app)


@pytest.fixture
def sample_with_attachment():
    db = SessionLocal()
    row = LimsSample(sample_id="TEST-S2S-01", status="verified")
    db.add(row); db.flush()
    att = LimsParentAttachment(
        lims_sample_pk=row.id, kind="chromatogram", filename="c.csv",
        content_type="text/csv", storage="s3", storage_key="test/c.bin",
        render_in_report=False, attachment_type="HPLC Graph",
        created_by_user_id=None)
    db.add(att); db.commit()
    yield row, att, db
    db.delete(att); db.delete(row); db.commit(); db.close()


def _get(client, sid, aid, token=TOKEN):
    headers = {"X-Service-Token": token} if token else {}
    return client.get(f"/s2s/samples/{sid}/attachments/{aid}", headers=headers)


def test_token_required(client, sample_with_attachment):
    row, att, _ = sample_with_attachment
    assert _get(client, row.sample_id, att.id, token=None).status_code in (401, 403)
    assert _get(client, row.sample_id, att.id, token="wrong").status_code in (401, 403)


def test_serves_bytes_with_db_row_content_type(client, sample_with_attachment):
    row, att, _ = sample_with_attachment
    with patch("main.get_storage") as gs:  # adjust to the route's actual storage accessor
        gs.return_value.load_photo.return_value = b"a,b\n1,2\n"
        r = _get(client, row.sample_id, att.id)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/csv")
    assert "c.csv" in r.headers.get("content-disposition", "")
    assert r.content == b"a,b\n1,2\n"


def test_404_on_sample_mismatch_and_senaite_storage(client, sample_with_attachment):
    row, att, db = sample_with_attachment
    assert _get(client, "OTHER-01", att.id).status_code == 404
    att.storage = "senaite"; db.commit()
    assert _get(client, row.sample_id, att.id).status_code == 404
```
NOTE: read the existing download route FIRST — mirror its storage read call and header assembly exactly; fix the mocked accessor name (`main.get_storage` vs local import) to match your implementation. If `TestClient(main.app)` needs auth-bypass fixtures used elsewhere, copy the idiom from the existing S2S route tests (`grep -rn "require_internal_service_token" backend/tests/`).

- [ ] **Step 2: Run to verify FAIL** — 404 route-not-found.

- [ ] **Step 3: Implement the route in `backend/main.py`** directly under the `GET /samples/{sample_id}/coa-sections` S2S route. Clone the byte-serving body of the user-JWT download route, with `Depends(require_internal_service_token)`, a `join`-verified `attachment.lims_sample_pk == sample.id` check, `storage != 's3'` → 404, and headers from the DB row.

- [ ] **Step 4: Run to verify PASS** — `python -m pytest backend/tests/test_s2s_attachment_route.py -q`.

- [ ] **Step 5: Commit** — `git add backend/main.py backend/tests/test_s2s_attachment_route.py && git commit -m "feat(s2s): service-token attachment bytes route for COABuilder"`

---

### Task 4: Mk1 — native attachments pre-flight gate

**Files:**
- Modify: `backend/main.py` (`_parent_attachment_kinds`, ~line 11455, and its call site in `generate_sample_coa` ~11672)
- Test: `backend/tests/test_attachment_gate_native.py`

**Interfaces:**
- Consumes: `coa.source_setting.coa_generation_source`, `models.LimsParentAttachment`.
- Produces: `_parent_attachment_kinds_native(db, parent_pk) -> set[str]` returning a subset of `{"image", "chromatogram"}` from native rows (image = `storage='s3'` AND `render_in_report` AND (`kind='receive_image'` OR `attachment_type='Sample Image'`); chromatogram = `storage='s3'` AND `kind='chromatogram'`). The gate call site picks native vs SENAITE by `coa_generation_source(db)`. Blocker wording unchanged.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_attachment_gate_native.py
"""mk1-mode attachments gate reads lims_parent_attachments, never SENAITE
(spec §5). Fail-closed: no native rows → kinds empty → existing blocker."""
import pytest

from database import SessionLocal
from models import LimsSample, LimsParentAttachment
from main import _parent_attachment_kinds_native


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.rollback(); s.close()


def _sample(db, **atts):
    row = LimsSample(sample_id="TEST-GATE-01", status="verified")
    db.add(row); db.flush()
    for kind, extra in atts.items():
        db.add(LimsParentAttachment(
            lims_sample_pk=row.id, kind=extra.get("kind", kind),
            filename="f", content_type=extra.get("ct", "image/png"),
            storage=extra.get("storage", "s3"), storage_key="k",
            render_in_report=extra.get("rir", True),
            attachment_type=extra.get("at", "Sample Image"),
            created_by_user_id=None))
    db.flush()
    return row


def test_both_kinds_detected(db):
    row = _sample(db,
        img={"kind": "receive_image", "at": "Sample Image"},
        chrom={"kind": "chromatogram", "at": "HPLC Graph", "ct": "text/csv", "rir": False})
    assert _parent_attachment_kinds_native(db, row.id) == {"image", "chromatogram"}


def test_empty_without_rows(db):
    row = _sample(db)
    assert _parent_attachment_kinds_native(db, row.id) == set()


def test_senaite_storage_invisible(db):
    row = _sample(db, img={"kind": "receive_image", "storage": "senaite"})
    assert _parent_attachment_kinds_native(db, row.id) == set()
```

- [ ] **Step 2: Run to verify FAIL** — import error on `_parent_attachment_kinds_native`.

- [ ] **Step 3: Implement.** Add `_parent_attachment_kinds_native` beside `_parent_attachment_kinds` (two EXISTS-style queries or one grouped query). At the gate call site in `generate_sample_coa`, branch: `kinds = _parent_attachment_kinds_native(db, parent_pk) if coa_generation_source(db) == "mk1" else await _parent_attachment_kinds(...)` — keep the SENAITE function untouched, keep blocker message text identical, and note the mk1 branch is fail-CLOSED (empty set blocks) while the SENAITE branch keeps its historical fail-open on read error.

- [ ] **Step 4: Run to verify PASS** — `python -m pytest backend/tests/test_attachment_gate_native.py -q`.

- [ ] **Step 5: Commit** — `git commit -am "feat(coa): attachments pre-flight gate reads native rows in mk1 mode"`

---

### Task 5: Mk1 — ShadowAnalysesReader + resolver/family swap

**Files:**
- Create: `backend/coa/shadow_reader.py`
- Modify: `backend/main.py` (reader construction in `generate_sample_coa` ~11613-11618), `backend/families/routes.py` (~26-30), `backend/coa/source_resolver.py` (`_gather_candidates_for` reads optional `reportable`)
- Test: `backend/tests/test_shadow_reader.py`

**Interfaces:**
- Consumes: `lims_analyses.service.list_parent_analyses_senaite_shape(db, sample_id)` (rows expose `.uid` = `mk1:{id}` for canonical / SENAITE hex for shadow, `.keyword`, `.result`, `.unit`, `.review_state`, `.retested`, `.provenance`; underlying `LimsAnalysis.retest_of_id`, `.reportable`).
- Produces: `class ShadowAnalysesReader: def __init__(self, db); async def list_for_sample(self, sample_id) -> List[Dict]` with dict keys `uid, keyword, result, unit, review_state, retest_of_uid, reportable`. Raises `ValueError` on a row with `review_state=None` (resolver pre-flight catches it fail-open — pre-existing semantics, not a SENAITE fallback).

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_shadow_reader.py
"""Shadow-backed resolver reader (spec §5): serves the SenaiteAnalysesReader
Protocol from native rows. Parity pins: retest_of_uid synthesized as mk1:{id};
reportable surfaced; review_state=None aborts; resolver drops superseded
originals exactly as with the HTTP reader."""
import asyncio
import pytest
from unittest.mock import patch

from coa.shadow_reader import ShadowAnalysesReader


def _shape(uid, keyword, result="1", unit="%", state="verified",
           retest_of_id=None, reportable=True):
    class Row:
        pass
    r = Row()
    r.uid, r.keyword, r.result, r.unit = uid, keyword, result, unit
    r.review_state, r.retest_of_id, r.reportable = state, retest_of_id, reportable
    return r


def _run(reader, sid="P-1"):
    return asyncio.get_event_loop().run_until_complete(reader.list_for_sample(sid))


def test_dict_shape_and_retest_link_synthesis():
    rows = [_shape("mk1:10", "HPLC-PUR", retest_of_id=None),
            _shape("mk1:11", "HPLC-PUR", retest_of_id=10)]
    with patch("coa.shadow_reader._shaped_rows", return_value=rows):
        out = _run(ShadowAnalysesReader(db=object()))
    by_uid = {o["uid"]: o for o in out}
    assert by_uid["mk1:11"]["retest_of_uid"] == "mk1:10"
    assert by_uid["mk1:10"]["retest_of_uid"] is None
    assert by_uid["mk1:10"]["reportable"] is True
    assert set(out[0]) >= {"uid", "keyword", "result", "unit", "review_state",
                           "retest_of_uid", "reportable"}


def test_none_review_state_aborts():
    rows = [_shape("mk1:10", "X", state=None)]
    with patch("coa.shadow_reader._shaped_rows", return_value=rows), \
         pytest.raises(ValueError):
        _run(ShadowAnalysesReader(db=object()))


def test_resolver_drops_superseded_original_via_mk1_links():
    from coa.source_resolver import _gather_candidates_for
    payload = {"P-1": [
        {"uid": "mk1:10", "keyword": "HPLC-PUR", "result": "95", "unit": "%",
         "review_state": "verified", "retest_of_uid": None, "reportable": True},
        {"uid": "mk1:11", "keyword": "HPLC-PUR", "result": "97", "unit": "%",
         "review_state": "verified", "retest_of_uid": "mk1:10", "reportable": True},
    ]}
    cands = _gather_candidates_for("P-1", True, payload, False)
    uids = [c.source_analysis_uid for c in cands["HPLC-PUR"]]
    assert uids == ["mk1:11"]


def test_gather_respects_reportable_false():
    from coa.source_resolver import _gather_candidates_for
    payload = {"P-1": [
        {"uid": "mk1:10", "keyword": "X", "result": "1", "unit": "",
         "review_state": "verified", "retest_of_uid": None, "reportable": False},
    ]}
    cands = _gather_candidates_for("P-1", True, payload, False)
    assert cands["X"][0].reportable is False
```

- [ ] **Step 2: Run to verify FAIL** — import error on `coa.shadow_reader`; the `_gather_candidates_for` reportable test fails (defaults True unconditionally today).

- [ ] **Step 3: Implement.**

```python
# backend/coa/shadow_reader.py
"""Shadow-backed SenaiteAnalysesReader (COA read-independence, spec §5).

Serves the resolver's Protocol from list_parent_analyses_senaite_shape —
zero SENAITE HTTP. Canonical-backed keywords never reach a reader
(_resolve_mk1_parent_tier shadows them), so this covers only the
SENAITE-only fall-through keywords, sourced from mirror shadow rows.
retest_of_uid is synthesized as mk1:{retest_of_id} so the resolver's
superseded_uids logic works in the mk1 uid space; reportable comes from the
native column. review_state=None aborts (producer bug) — the resolver
pre-flight's existing fail-open catch handles it upstream.
"""
from typing import Dict, List


def _shaped_rows(db, sample_id):
    from lims_analyses.service import list_parent_analyses_senaite_shape
    return list_parent_analyses_senaite_shape(db, sample_id)


class ShadowAnalysesReader:
    def __init__(self, db):
        self._db = db

    async def list_for_sample(self, sample_id: str) -> List[Dict]:
        out: List[Dict] = []
        for r in _shaped_rows(self._db, sample_id):
            if r.review_state is None:
                raise ValueError(
                    f"shadow reader: {r.uid} on {sample_id} has "
                    f"review_state=None — refusing (producer bug)")
            retest_of = getattr(r, "retest_of_id", None)
            out.append({
                "uid": r.uid,
                "keyword": r.keyword,
                "result": r.result,
                "unit": r.unit,
                "review_state": r.review_state,
                "retest_of_uid": f"mk1:{retest_of}" if retest_of else None,
                "reportable": getattr(r, "reportable", True),
            })
        return out
```
NOTE: check whether `SenaiteShapeAnalysisResponse` exposes `retest_of_id`/`reportable` (backend/lims_analyses/schemas.py:212-278). If not, extend `_serialize_senaite_shape_rows` (service.py ~3201) additively with both fields (defaulting None/True) — additive schema fields are safe for existing consumers; add a serializer test in this same file.

In `backend/coa/source_resolver.py` `_gather_candidates_for`, change the CandidateInfo construction's `reportable=True` to `reportable=an.get("reportable", True)` (dict-payload path only; HTTP-reader dicts lack the key → unchanged).

In `backend/main.py` (`generate_sample_coa`): replace the reader construction with

```python
if coa_generation_source(db) == "mk1":
    from coa.shadow_reader import ShadowAnalysesReader
    reader = ShadowAnalysesReader(db)
    resolver_result = await resolve_sources(sample_id, db, reader)
elif SENAITE_URL:
    reader = SenaiteAnalysesHttpReader(base_url=SENAITE_URL, auth=_get_senaite_auth(current_user))
    resolver_result = await resolve_sources(sample_id, db, reader)
```
(keep the surrounding try/except fail-open exactly as-is). In `backend/families/routes.py`, the reader dep returns `ShadowAnalysesReader(db)` when `coa_generation_source(db) == "mk1"`, else the HTTP reader — read the dep's real shape first and keep its signature.

- [ ] **Step 4: Run to verify PASS** — `python -m pytest backend/tests/test_shadow_reader.py backend/tests/ -q -k "resolver or source_resolver"` → new tests pass, existing resolver suite untouched.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(coa): shadow-backed resolver reader; resolver + family reads native in mk1 mode"`

---

### Task 6: Mk1 — watermark URL native capture + backfill scripts

**Files:**
- Modify: `backend/sub_samples/service.py` (`_COA_META_FIELDS`, ~line 362)
- Create: `backend/scripts/backfill_watermark_urls.py`, `backend/scripts/backfill_chromatogram_snapshots.py`
- Test: `backend/tests/test_coa_meta_watermark_capture.py`

**Interfaces:**
- Consumes: `_populate_basic_info` / `_COA_META_FIELDS` capture set; the CSV builder inside `upload_chromatogram_to_senaite` (main.py ~6447-6455); `HPLCAnalysis.chromatogram_data`.
- Produces: `ChromatographBackgroundUrl` captured into `coa_meta` on registration/edit-mirror; two guarded dry-run/apply scripts (NOT run at build time — the orchestrator runs them in the deploy window).

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_coa_meta_watermark_capture.py
"""ChromatographBackgroundUrl joins the coa_meta capture set (spec §6)."""
from sub_samples.service import _COA_META_FIELDS


def test_watermark_in_capture_set():
    assert "ChromatographBackgroundUrl" in _COA_META_FIELDS
```

- [ ] **Step 2: Run to verify FAIL**, then add the field to `_COA_META_FIELDS`, **run to verify PASS** (also run `python -m pytest backend/tests -q -k "basic_info or coa_meta"` to confirm the capture-path suites absorb the new key).

- [ ] **Step 3: Write `backend/scripts/backfill_watermark_urls.py`** — dry-run default, `APPLY=1` env: for each `lims_samples` row with `external_lims_uid` and `coa_meta` lacking the key, fetch the AR's `ChromatographBackgroundUrl` from SENAITE (this is a WRITE-WINDOW one-time script, exempt from R1 which governs runtime reads — say so in the docstring), merge into `coa_meta` when non-empty, per-row commits, throttle 0.25s, count summary. Model on `backend/scripts/backfill_lims_sample_basic_info.py` for the SENAITE fetch idiom.

- [ ] **Step 4: Write `backend/scripts/backfill_chromatogram_snapshots.py`** — dry-run default, `APPLY=1`: find parents that HAVE `HPLCAnalysis.chromatogram_data` (via the models' real linkage — read `backend/models.py` for the join) but NO `lims_parent_attachments` row `kind='chromatogram'` with `storage='s3'`; rebuild the CSV bytes with the SAME builder the push path uses — extract that builder from `upload_chromatogram_to_senaite` (main.py ~6447-6455) into a module-level pure function `build_chromatogram_csv(analysis) -> bytes` in `backend/hplc_csv.py` (or the file the implementer judges idiomatic), call it from BOTH the existing push path and this script (refactor must keep the push path byte-identical — cover with a unit test comparing old inline output to the extracted function for a fixture analysis) — then `photo_storage.get_storage().save_photo(...)` + mint the `LimsParentAttachment(kind='chromatogram', storage='s3', content_type='text/csv', render_in_report=False, attachment_type='HPLC Graph')` row. Per-row commits; summary.

- [ ] **Step 5: Run the full Mk1 suite failure-set diff** — `python -m pytest backend/tests -q 2>&1 | grep -E "^(FAILED|ERROR) +backend/" | sort > /c/tmp/branch-fails.txt` and diff against the master baseline capture (regenerate baseline from a clean master worktree if `/c/tmp/base-ids.txt` is stale). Expect identical sets.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(coa): watermark URL native capture + chromatogram/watermark backfill scripts"`

---

### Task 7: coab — worktree + twin contract + `sample_meta` extractor

**Files:**
- Create worktree: `cd /c/tmp/coab-deploy && git fetch origin -q && git worktree add /c/tmp/coab-sample-meta -b feat/coa-sample-meta-wire origin/master`
- Create: `src/coabuilder_core/sample_meta.py`
- Test: `tests/test_sample_meta_contract.py`

**Interfaces:**
- Consumes: `coabuilder_core.native_sections.NativeSectionsValidationError` (422 family).
- Produces: `extract_sample_meta(doc: Optional[dict]) -> Optional[dict]` (None = absent → SENAITE path; raises `NativeSectionsValidationError` on malformation), `synthesize_sample_json(meta: dict) -> dict`, twin literals `SAMPLE_META_SCALARS`, `ATTACHMENT_ROLES` (byte-identical to Mk1 Task 1).

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_sample_meta_contract.py
"""Twin contract for the sample_meta wire block (read-independence spec §2/§3).
The literal tuples below are byte-identical twins of Accu-Mk1
backend/coa/sample_meta.py — move both sides together."""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
from coabuilder_core.native_sections import NativeSectionsValidationError
from coabuilder_core.sample_meta import (
    ATTACHMENT_ROLES, SAMPLE_META_SCALARS, extract_sample_meta,
    synthesize_sample_json)

EXPECTED_SCALARS = (
    "SampleID", "SampleTypeTitle", "ClientSampleID", "DateReceived",
    "DeclaredTotalQuantity", "ClientLot", "BatchID",
    "CoaCompanyName", "CoaEmail", "CoaWebsite", "CoaAddress",
    "CompanyLogoUrl", "ChromatographBackgroundUrl",
)


def _meta(**over):
    m = {"source": "mk1", "attachments": []}
    m.update({k: f"v-{k}" for k in EXPECTED_SCALARS})
    m["ChromatographBackgroundUrl"] = None
    m.update(over)
    return m


def test_contract_literals_pinned():
    assert SAMPLE_META_SCALARS == EXPECTED_SCALARS
    assert ATTACHMENT_ROLES == frozenset({"sample_image", "chromatogram_csv"})


def test_absent_doc_or_key_returns_none():
    assert extract_sample_meta(None) is None
    assert extract_sample_meta({}) is None
    assert extract_sample_meta({"legacy_rows": {}}) is None


def test_valid_block_passes_through():
    doc = {"sample_meta": _meta()}
    assert extract_sample_meta(doc)["SampleID"] == "v-SampleID"


def test_malformed_blocks_422():
    with pytest.raises(NativeSectionsValidationError):
        extract_sample_meta({"sample_meta": "not-a-dict"})
    with pytest.raises(NativeSectionsValidationError):
        extract_sample_meta({"sample_meta": _meta(SampleTypeTitle="")})  # empty matrix
    bad_role = _meta(attachments=[{"role": "mystery", "url": "u",
                                   "filename": "f", "content_type": "x",
                                   "attachment_id": 1}])
    with pytest.raises(NativeSectionsValidationError):
        extract_sample_meta({"sample_meta": bad_role})
    missing_url = _meta(attachments=[{"role": "sample_image", "filename": "f",
                                      "content_type": "x", "attachment_id": 1}])
    with pytest.raises(NativeSectionsValidationError):
        extract_sample_meta({"sample_meta": missing_url})


def test_synthesize_sample_json_ar_spellings():
    sj = synthesize_sample_json(_meta())
    assert sj["SampleTypeTitle"] == "v-SampleTypeTitle"
    assert sj["getClientSampleID"] == "v-ClientSampleID"     # peptide engine
    assert sj["ClientSampleID"] == "v-ClientSampleID"        # generic engine
    assert sj["DateReceived"] == "v-DateReceived"
    assert sj["getDateReceived"] == "v-DateReceived"         # generic alias
    assert sj["ClientLot"] == "v-ClientLot"
    assert sj["getBatchID"] == "v-BatchID"
    assert sj["BatchID"] == "v-BatchID"
    assert sj["SampleID"] == "v-SampleID"
    assert sj["id"] == "v-SampleID"
    assert sj["CoaCompanyName"] == "v-CoaCompanyName"
    assert sj["CompanyLogoUrl"] == "v-CompanyLogoUrl"


def test_synthesize_carries_analyte_slots():
    sj = synthesize_sample_json(_meta(Analyte1Peptide="BPC-157"))
    assert sj["Analyte1Peptide"] == "BPC-157"
```

- [ ] **Step 2: Run to verify FAIL** — `python -m pytest tests/test_sample_meta_contract.py -q` → import error.

- [ ] **Step 3: Implement `src/coabuilder_core/sample_meta.py`** — module docstring mirrors legacy_rows.py's (twin-contract note, fail-closed rationale, spec path). `extract_sample_meta`: None when doc falsy or key absent; type-check dict; require every `SAMPLE_META_SCALARS` key present (values may be empty strings EXCEPT `SampleTypeTitle` and `SampleID`, which must be non-empty — matrix selects the engine); `ChromatographBackgroundUrl` may be None; validate each attachment has `role ∈ ATTACHMENT_ROLES`, non-empty `url`, `filename`, `content_type`, int `attachment_id`; duplicate roles → error. `synthesize_sample_json`: copy scalars + emit the alias spellings shown in the test + copy any `Analyte{n}Peptide` keys + set `id` = SampleID. Return a plain dict.

- [ ] **Step 4: Run to verify PASS.**

- [ ] **Step 5: Commit** — `git add src/coabuilder_core/sample_meta.py tests/test_sample_meta_contract.py && git commit -m "feat(sample-meta): wire-block extractor + envelope synthesis (twin contract)"`

---

### Task 8: coab — `fetch_sample_data` consumes `sample_meta` (no AR fetch, native bytes)

**Files:**
- Modify: `src/coabuilder_core/senaite_client.py` (`fetch_sample_data`, ~line 372)
- Test: `tests/test_fetch_sample_meta.py`

**Interfaces:**
- Consumes: Task 7's `synthesize_sample_json`; env `ACCUMK1_SERVICE_TOKEN`.
- Produces: `fetch_sample_data(..., sample_meta: Optional[dict] = None)` — when provided WITH `legacy_rows`: zero calls to `_get`/`self.api_base` URLs; `sample_json` = synthesized; attachments downloaded from descriptor URLs with header `X-Service-Token`; `att_files_map` keyed by role (`sample_image` → `"image"`, `chromatogram_csv` → `"csv"`); download failure raises `NativeSectionsValidationError` (R1 — NO SENAITE retry).

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_fetch_sample_meta.py
"""mk1-mode fetch: sample_meta present → NO SENAITE HTTP at all; envelope
synthesized; bytes from Mk1 descriptor URLs with the service token; download
failure = 422, never a SENAITE fallback (R1)."""
import os
import sys
from unittest.mock import patch, MagicMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
from coabuilder_core.native_sections import NativeSectionsValidationError
from coabuilder_core.senaite_client import SenaiteClient

ROW = {"uid": "mk1:1", "Keyword": "PH-DETERM", "Title": "pH Determination",
       "ServiceTitle": "pH Determination", "Result": "6.5", "Unit": "",
       "review_state": "verified", "ResultCaptureDate": "2026-08-28T00:00:00"}


def _meta(tmp_path, roles=("sample_image", "chromatogram_csv")):
    atts = []
    if "sample_image" in roles:
        atts.append({"role": "sample_image", "attachment_id": 1,
                     "filename": "img.png", "content_type": "image/png",
                     "url": "https://mk1.test/s2s/samples/S/attachments/1"})
    if "chromatogram_csv" in roles:
        atts.append({"role": "chromatogram_csv", "attachment_id": 2,
                     "filename": "c.csv", "content_type": "text/csv",
                     "url": "https://mk1.test/s2s/samples/S/attachments/2"})
    return {"source": "mk1", "SampleID": "BW-TEST-1",
            "SampleTypeTitle": "Bacteriostatic Water", "ClientSampleID": "CS",
            "DateReceived": "2026-08-28T00:00:00", "DeclaredTotalQuantity": "10",
            "ClientLot": "L1", "BatchID": "L1", "CoaCompanyName": "",
            "CoaEmail": "", "CoaWebsite": "", "CoaAddress": "",
            "CompanyLogoUrl": "", "ChromatographBackgroundUrl": None,
            "attachments": atts}


@pytest.fixture
def client(tmp_path):
    c = SenaiteClient()          # match the repo's real constructor — read it
    return c


def test_no_senaite_http_when_sample_meta_present(client, tmp_path, monkeypatch):
    monkeypatch.setenv("ACCUMK1_SERVICE_TOKEN", "tok")
    monkeypatch.chdir(tmp_path)
    with patch.object(client, "_get", side_effect=AssertionError("SENAITE _get called")) as g, \
         patch("coabuilder_core.senaite_client.requests.get") as rg:
        rg.return_value = MagicMock(status_code=200, content=b"bytes",
                                    headers={"content-type": "image/png"})
        data = client.fetch_sample_data("BW-TEST-1", legacy_rows=[ROW],
                                        sample_meta=_meta(tmp_path))
    assert data is not None
    g.assert_not_called()
    # every byte request carried the service token
    for call in rg.call_args_list:
        assert call.kwargs["headers"]["X-Service-Token"] == "tok"


def test_envelope_values_flow_to_coa(client, tmp_path, monkeypatch):
    monkeypatch.setenv("ACCUMK1_SERVICE_TOKEN", "tok")
    monkeypatch.chdir(tmp_path)
    with patch.object(client, "_get", side_effect=AssertionError), \
         patch("coabuilder_core.senaite_client.requests.get") as rg:
        rg.return_value = MagicMock(status_code=200, content=b"x",
                                    headers={"content-type": "image/png"})
        data = client.fetch_sample_data("BW-TEST-1", legacy_rows=[ROW],
                                        sample_meta=_meta(tmp_path))
    assert data.sample_name == "CS"           # ClientSampleID → sample_name
    assert data.lot_code == "L1"
    assert data.sample_code == "BW-TEST-1"


def test_download_failure_is_422_not_fallback(client, tmp_path, monkeypatch):
    monkeypatch.setenv("ACCUMK1_SERVICE_TOKEN", "tok")
    monkeypatch.chdir(tmp_path)
    with patch.object(client, "_get", side_effect=AssertionError), \
         patch("coabuilder_core.senaite_client.requests.get") as rg:
        rg.return_value = MagicMock(status_code=500, content=b"")
        with pytest.raises(NativeSectionsValidationError):
            client.fetch_sample_data("BW-TEST-1", legacy_rows=[ROW],
                                     sample_meta=_meta(tmp_path))
```
NOTE: adapt the constructor/attribute names (`_get`, `api_base`, results-dir handling) to the real class after reading it — the assertions that matter are: `_get` never called, token on every byte request, 422 on download failure, envelope values on the returned CoAData. The BW matrix keeps the test on the generic engine (no chromatogram/peptide-slot requirements); include the chromatogram-csv descriptor so the download loop is exercised.

- [ ] **Step 2: Run to verify FAIL** — unexpected-keyword-argument `sample_meta`.

- [ ] **Step 3: Implement.** Add `sample_meta: Optional[dict] = None` to `fetch_sample_data`. At the top of the fetch flow:

```python
if sample_meta is not None:
    from .sample_meta import synthesize_sample_json
    sample_json = synthesize_sample_json(sample_meta)
    self._download_wire_attachments(sample_meta, sample_id, att_files_map)
else:
    ... existing search + AR fetch + attachment walk ...
```
with a new private helper on the client:

```python
def _download_wire_attachments(self, sample_meta, sample_id, att_files_map):
    """Native bytes (spec §3/§4): Mk1 S2S URLs, service-token header,
    role-driven map. Fail-closed — any failure is a validation error, never
    a SENAITE retry (R1)."""
    import os as _os
    from .native_sections import NativeSectionsValidationError
    token = _os.environ.get("ACCUMK1_SERVICE_TOKEN", "")
    role_to_key = {"sample_image": "image", "chromatogram_csv": "csv"}
    for att in sample_meta.get("attachments", []):
        dest_dir = os.path.join("results", sample_id, "attachments")
        os.makedirs(dest_dir, exist_ok=True)
        dest = os.path.join(dest_dir, att["filename"])
        resp = requests.get(att["url"], headers={"X-Service-Token": token},
                            timeout=30)
        if resp.status_code != 200 or not resp.content:
            raise NativeSectionsValidationError(
                f"sample_meta: attachment {att['role']} "
                f"({att['url']}) download failed with "
                f"{resp.status_code} — aborting (no SENAITE fallback)")
        with open(dest, "wb") as f:
            f.write(resp.content)
        att_files_map[role_to_key[att["role"]]] = dest
```
Keep every downstream step (engine dispatch, CoAData mapping, chromatogram rendering, logo download) untouched — they read `sample_json`/`att_files_map` exactly as before. Match the repo's real results-dir constant instead of the literal `"results"` if one exists.

- [ ] **Step 4: Run to verify PASS** — `python -m pytest tests/test_fetch_sample_meta.py tests/test_fetch_legacy_rows.py -q`.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(sample-meta): fetch_sample_data synthesizes envelope + native bytes, zero SENAITE reads"`

---

### Task 9: coab — server wiring + data_sources echo

**Files:**
- Modify: `scripts/server.py` (`/process` and `/process-additional` handlers)
- Test: `tests/test_server_sample_meta.py`

**Interfaces:**
- Consumes: Task 7 `extract_sample_meta`, Task 8's `fetch_sample_data(sample_meta=...)`.
- Produces: both routes extract `sample_meta` from `body.native_sections`, pass it through, and echo `data_sources.sample_meta = "mk1"` when used (absent otherwise). Malformed block → 422 before any generation work.

- [ ] **Step 1: Write the failing tests** — clone the harness of `tests/test_server_legacy_rows.py` (same app_settings stub + TestClient idiom; read it first). Cases: (a) doc with valid `sample_meta` + `legacy_rows` → `fetch_sample_data` called with both, response `data_sources == {"legacy_rows": "mk1", "sample_meta": "mk1"}`; (b) doc without `sample_meta` → called with `sample_meta=None`, `data_sources` lacks the key; (c) malformed `sample_meta` → 422 and `fetch_sample_data` never called; (d) same three via `/process-additional`.

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement** in both handlers beside the existing `extract_legacy_rows` calls: `meta = extract_sample_meta(native_sections_doc)` (its `NativeSectionsValidationError` already maps to 422 via the legacy_rows precedent — confirm the handler's except clause covers it), pass `sample_meta=meta` to `fetch_sample_data`, and where `data_sources` is assembled add `if meta is not None: data_sources["sample_meta"] = "mk1"`.

- [ ] **Step 4: Run to verify PASS** — `python -m pytest tests/test_server_sample_meta.py tests/test_server_legacy_rows.py -q`, then the full coab suite (`SENAITE_URL=http://x SENAITE_USERNAME=x SENAITE_PASSWORD=x python -m pytest tests/ -q`) — green except the known variance-render env failure.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(sample-meta): /process + /process-additional accept sample_meta, echo data_sources"`

---

### Task 10: Mk1 — generate-flow existence check + Mk1-side full-suite gate

**Files:**
- Modify: `backend/main.py` (`generate_sample_coa` — assert parent exists in `lims_samples` before the coab POST in mk1 mode; it already loads `parent_row` — make the mk1 branch abort with a 404-style blocker naming Mk1, not SENAITE, when absent)
- Test: extend `backend/tests/test_wire_document_sample_meta.py` or the existing generate-endpoint test file (read `grep -rn "generate-coa" backend/tests/` and follow its harness) with: mk1 mode + unknown sample → error message contains "Accu-Mk1" (not "SENAITE").

- [ ] **Step 1: failing test → Step 2: implement → Step 3: pass** (same TDD loop; the change is a message/guard tweak at the existing `parent_row is None` branch).

- [ ] **Step 4: Full Mk1 suite failure-set diff vs baseline** (identical sets required).

- [ ] **Step 5: Commit** — `git commit -am "feat(coa): mk1-mode existence check names Mk1; SENAITE absent from generate-flow errors"`

---

### Task 11: Cross-repo review checkpoint (orchestrator, not a subagent)

- [ ] Re-read the spec top to bottom; walk each § against the diffs (`git diff origin/master` in both worktrees). Confirm: twin literals byte-identical; no engine file touched; senaite-mode paths byte-identical (diff shows no behavior change outside mk1 branches); R1 holds (grep both diffs for any SENAITE URL/fetch inside mk1-mode branches).
- [ ] Run `superpowers:requesting-code-review` guidance: dispatch a code-reviewer subagent per repo diff with the spec attached; triage findings (fix Critical/Important inline with TDD; log Minor).

---

### Task 12: Arcitest deploy + THE definitive UAT (SENAITE stopped)

**Files:** none (ops). Run from the orchestrator (devbox ssh: `forrestparker@100.73.137.3`; stack `accumark-arcitest-*`; Mk1 API `http://localhost:5812/api`, login `e2e@accumark.local` / the e2e password from `/tmp/accept.sh` on the devbox).

- [ ] **Step 1:** Bundle both branches to the devbox worktrees (pattern proven this week): Mk1 → `/home/forrestparker/worktrees/`(find the arcitest Mk1 worktree via `docker inspect accumark-arcitest-accu-mk1-backend --format '{{range .Mounts}}{{.Source}}{{println}}{{end}}'`), coab → `/home/forrestparker/worktrees/coab-arcitest`. `git bundle create` locally → scp → fetch + merge/cherry-pick → restart both containers. Set envs on the arcitest containers: `MK1_PUBLIC_BASE_URL` (the Mk1 backend's own reachable base URL inside the stack network, e.g. `http://accumark-arcitest-accu-mk1-backend:8000` — verify the in-network port with `docker inspect`), `ACCUMK1_SERVICE_TOKEN` on coab == `ACCUMK1_INTERNAL_SERVICE_TOKEN` on Mk1 (generate one, add to both containers' env via the stack compose override; document what you did).
- [ ] **Step 2:** Confirm arcitest `registry_read_source.coa_generation` = mk1 (it is). Generate a peptide sample (PB-0158) and a BW sample (BW-0156) with SENAITE UP; verify success + `data_sources.sample_meta == "mk1"` in coab logs + no drift warnings; download both PDFs' `coa_data` and diff row values/statuses against the pre-slice certs from 08-27 (expect identical verdicts; envelope fields identical).
- [ ] **Step 3: THE test — `docker stop accumark-arcitest-senaite`**, then generate BOTH samples again (primary + regular child + per-vial on the BW). Expect: success, correct certificates, chromatogram present and visually identical (pull both PDFs, compare the chromatogram region), zero SENAITE errors in coab logs. Also run the IS additional path if arcitest has an ACOA fixture (optional — the S2S doc pass-through was verified in Task 0).
- [ ] **Step 4: Negative (R1):** with SENAITE still stopped, delete/rename the sample-image attachment row for one sample (`UPDATE lims_parent_attachments SET storage='senaite' WHERE id=...` on the arcitest DB — reversible), attempt generation → expect the native blocker error, NOT a silent success or a SENAITE attempt. Restore the row after.
- [ ] **Step 5: `docker start accumark-arcitest-senaite`**; restore any UAT mutations; record all verification codes + findings.

---

### Task 13: Backfill dry-runs (prod, read-only) + memory/PR prep

- [ ] Run both Task-6 scripts against prod in DRY-RUN via the sanctioned idiom (`docker exec -w /app -i accu-mk1-backend python < script`); capture counts. Do NOT apply — the apply runs in the deploy window with Handler visibility.
- [ ] Open both PRs (Mk1 `feat/coa-read-independence`, coab `feat/coa-sample-meta-wire`) with spec links, UAT evidence, and the deploy-window checklist: (1) coab deploy first with `ACCUMK1_SERVICE_TOKEN` added to `/root/coabuilder/.env`; (2) Mk1 deploy with `MK1_PUBLIC_BASE_URL` + `ACCUMK1_INTERNAL_SERVICE_TOKEN` added to `/root/accu-mk1/backend/.env` (manual, never overwritten); (3) watermark + chromatogram backfills APPLY; (4) prod smoke generation + drift-warning watch.
- [ ] Update memory (`project_coab_seam4_slice1_legacy_rows.md` successor entry or new file) + session log.

---

## Self-review record

- Spec coverage: §2→T1/T2/T7, §3→T7/T8/T9, §4→T3, §5→T4/T5, §6→T0/T6/T13, §7→every task's tests + T12, §8→T13. Sub-sample parking + slice-3 exclusion: no tasks — correct.
- Placeholders: none; every code step carries real code or names the exact template file to clone.
- Type consistency: `build_sample_meta(db, parent) -> dict` (T1) consumed in T2; `extract_sample_meta`/`synthesize_sample_json` (T7) consumed in T8/T9; `ShadowAnalysesReader.list_for_sample` dict keys match `_gather_candidates_for` reads (T5); twin literals identical in T1/T7.

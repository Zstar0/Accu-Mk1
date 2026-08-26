# COA Legacy-Family Rows from Accu-Mk1 (seam 4, slice 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** COABuilder sources legacy-family result rows (core HPLC, endotoxin, sterility PCR, bac water) from Accu-Mk1 via the native-sections wire document — spec engine and rendering byte-identical — behind a Data Source admin toggle defaulting to SENAITE.

**Architecture:** Mk1 projects its `lims_analyses` parent-tier rows (via the existing `list_parent_analyses_senaite_shape` selection semantics) into SENAITE-cased dicts and attaches them as a `legacy_rows` block inside the `native_sections` document at every COA call site. COABuilder, when the block is present, substitutes those rows for `_Analyses_Detailed` and skips the SENAITE analyses fetch; everything downstream (ConformanceEngine, GenericAssayEngine, addon parsing, templates) is untouched. A `data_sources` echo in the coab response lets Mk1 warn loudly if the toggle was ignored.

**Tech Stack:** Python/FastAPI/SQLAlchemy (both repos), React/TypeScript/vitest (Mk1 FE), pytest.

**Spec:** `docs/superpowers/specs/2026-08-26-coa-legacy-rows-mk1-source-design.md` (Accu-Mk1 repo — read it first; it carries the field contract and fail-closed rules verbatim).

## Global Constraints

- **Two repos, two worktrees.** COABuilder tasks run in `C:\tmp\coabuilder-seam4` (branch `feat/coa-legacy-rows-wire`). Accu-Mk1 tasks run in `C:\tmp\Accu-Mk1-methods` (branch `feat/coa-legacy-rows-source`). Every command below states its working directory. Never touch `C:\tmp\coab-deploy` or the OneDrive `coabuilder` checkout.
- **Field contract (verbatim, both repos):** `("uid", "Keyword", "Title", "ServiceTitle", "Result", "Unit", "review_state", "ResultCaptureDate")`. Twin tests pin it: coab `tests/test_legacy_rows_contract.py` ↔ Mk1 `backend/tests/test_legacy_rows_contract.py`. They must stay identical.
- **Fail-closed:** invalid `legacy_rows` → coab 422 via `NativeSectionsValidationError`; zero legacy rows in mk1 mode → Mk1 `NativeSectionsError` abort. Result may be None/empty (pending micro lines are legal); Keyword may not.
- **Additive only:** absent `legacy_rows` → current SENAITE path byte-for-byte unchanged. Toggle default is `senaite`.
- **Setting:** `Settings` key `registry_read_source`, JSON object, new key `"coa_generation": "senaite"|"mk1"`; absent/malformed/unknown → `senaite`.
- **TDD:** every task writes its failing test first and watches it fail. Mk1 backend: run only the task's own test file(s) (`python -m pytest backend/tests/<file> -q`) — the full suite has a known non-zero baseline; the full-suite failure-set diff is Task 11. coab: `python -m pytest tests/<file> -q` (host python, no container).
- Commit after each task with a conventional message; do not push until Task 11.

---

### Task 1: coab — `extract_legacy_rows` + twin contract test

**Working directory:** `C:\tmp\coabuilder-seam4`

**Files:**
- Create: `src/coabuilder_core/legacy_rows.py`
- Create: `tests/test_legacy_rows_contract.py`

**Interfaces:**
- Consumes: `NativeSectionsValidationError` from `src/coabuilder_core/native_sections.py:29` (existing).
- Produces: `extract_legacy_rows(doc: Optional[dict]) -> Optional[list]` and `FIELD_CONTRACT` tuple. Task 2 passes the returned list to `fetch_sample_data(legacy_rows=...)`; Task 3 calls `extract_legacy_rows` in both server endpoints.

- [ ] **Step 1: Write the failing test**

```python
"""Twin contract test — Mk1 side: backend/tests/test_legacy_rows_contract.py.

The FIELD_CONTRACT tuple and the validation behavior asserted here are pinned
identically in the Accu-Mk1 repo. Editing one side without the other silently
breaks the cross-repo wire. Move them together.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from coabuilder_core.legacy_rows import FIELD_CONTRACT, extract_legacy_rows
from coabuilder_core.native_sections import NativeSectionsValidationError


def _row(**over):
    row = {
        "uid": "mk1:144",
        "Keyword": "HPLC-PUR",
        "Title": "Peptide Purity (HPLC)",
        "ServiceTitle": "Peptide Purity (HPLC)",
        "Result": "12",
        "Unit": "%",
        "review_state": "published",
        "ResultCaptureDate": "2026-08-25T04:26:00+00:00",
    }
    row.update(over)
    return row


def test_field_contract_pinned():
    assert FIELD_CONTRACT == (
        "uid", "Keyword", "Title", "ServiceTitle",
        "Result", "Unit", "review_state", "ResultCaptureDate",
    )


def test_absent_doc_and_absent_block_return_none():
    assert extract_legacy_rows(None) is None
    assert extract_legacy_rows({}) is None
    assert extract_legacy_rows(
        {"sample_id": "P-1", "ordered_profiles": [], "sections": []}
    ) is None


def test_valid_block_returns_rows():
    doc = {"legacy_rows": {"source": "mk1", "rows": [_row()]}}
    rows = extract_legacy_rows(doc)
    assert rows == [_row()]


def test_pending_row_with_empty_result_is_legal():
    # Unlike native-section rows, an unresulted line is legal — micro
    # finishes after the analytical COA and the engines own pending semantics.
    doc = {"legacy_rows": {"rows": [_row(Result=None, review_state="unassigned")]}}
    assert extract_legacy_rows(doc)[0]["Result"] is None


@pytest.mark.parametrize("block", [
    "not-a-dict",
    {},                                   # no rows key
    {"rows": "not-a-list"},
    {"rows": []},                         # empty = producer bug, fail closed
    {"rows": ["not-a-dict"]},
    {"rows": [{"Keyword": "", "review_state": "published"}]},   # empty Keyword
    {"rows": [{"review_state": "published"}]},                  # no Keyword
    {"rows": [{"Keyword": "HPLC-PUR"}]},                        # no review_state
    {"rows": [{"Keyword": "HPLC-PUR", "review_state": None}]},  # non-str state
])
def test_invalid_blocks_fail_closed(block):
    with pytest.raises(NativeSectionsValidationError):
        extract_legacy_rows({"legacy_rows": block})
```

- [ ] **Step 2: Run test to verify it fails**

Run (in `C:\tmp\coabuilder-seam4`): `python -m pytest tests/test_legacy_rows_contract.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'coabuilder_core.legacy_rows'`

- [ ] **Step 3: Write the implementation**

```python
"""Legacy-family result rows from the Mk1 wire document (seam 4, slice 1).

The `legacy_rows` block arrives inside the `native_sections` document from
Mk1 (primary path) or Integration Service (additional path). When present,
COABuilder substitutes these rows for SENAITE's `_Analyses_Detailed` and
never fetches SENAITE analyses; absent means a legacy caller or senaite
mode and the SENAITE path runs unchanged.

Spec: Accu-Mk1 docs/superpowers/specs/2026-08-26-coa-legacy-rows-mk1-source-design.md
"""
from typing import Optional

from .native_sections import NativeSectionsValidationError

# Twin contract: backend/coa/legacy_rows.py + backend/tests/
# test_legacy_rows_contract.py in Accu-Mk1 pin the same tuple and shapes.
# Move both sides together.
FIELD_CONTRACT = (
    "uid", "Keyword", "Title", "ServiceTitle",
    "Result", "Unit", "review_state", "ResultCaptureDate",
)


def extract_legacy_rows(doc: Optional[dict]) -> Optional[list]:
    """Validated `legacy_rows` rows from a wire document, or None.

    None = no document / no block: caller keeps the SENAITE path.
    Fail-closed on any malformation (NativeSectionsValidationError -> 422):
    a half-valid block must never silently fall back to SENAITE, because the
    operator believes the certificate was sourced from Mk1. `Result` may be
    None/empty (pending micro lines are legal); `Keyword` may not.
    """
    if not doc:
        return None
    block = doc.get("legacy_rows")
    if block is None:
        return None
    if not isinstance(block, dict) or not isinstance(block.get("rows"), list):
        raise NativeSectionsValidationError(
            "legacy_rows: block must be a dict with a 'rows' list — aborting")
    rows = block["rows"]
    if not rows:
        raise NativeSectionsValidationError(
            "legacy_rows: rows is empty — an empty results table on a "
            "certificate is never valid; aborting")
    for i, row in enumerate(rows):
        if not isinstance(row, dict):
            raise NativeSectionsValidationError(
                f"legacy_rows: row {i} is not a dict — aborting")
        kw = row.get("Keyword")
        if not isinstance(kw, str) or not kw.strip():
            raise NativeSectionsValidationError(
                f"legacy_rows: row {i} has a missing/empty Keyword — aborting")
        if not isinstance(row.get("review_state"), str):
            raise NativeSectionsValidationError(
                f"legacy_rows: row {kw!r} has a missing/non-string "
                f"review_state — aborting")
    return rows
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_legacy_rows_contract.py -q`
Expected: PASS (all)

- [ ] **Step 5: Commit**

```bash
git add src/coabuilder_core/legacy_rows.py tests/test_legacy_rows_contract.py
git commit -m "feat(seam4): legacy_rows extraction + field-contract twin test"
```

---

### Task 2: coab — `fetch_sample_data` substitution

**Working directory:** `C:\tmp\coabuilder-seam4`

**Files:**
- Modify: `src/coabuilder_core/senaite_client.py` (`fetch_sample_data`, signature at :372 and the `_collect_analyses_details` call at ~:439, plus the analysis-level attachment fallback at ~:515)
- Create: `tests/test_fetch_legacy_rows.py`

**Interfaces:**
- Consumes: nothing from Task 1 (the list arrives pre-validated).
- Produces: `SenaiteClient.fetch_sample_data(..., legacy_rows: Optional[List[Dict]] = None)`. Task 3 passes `legacy_rows=` from both endpoints.

- [ ] **Step 1: Write the failing test**

```python
"""fetch_sample_data substitution: wire rows replace _Analyses_Detailed and
SENAITE's per-analysis fetches are skipped entirely."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from coabuilder_core.senaite_client import SenaiteClient

_AR = {
    "uid": "abc123",
    "id": "P-0161",
    "SampleID": "P-0161",
    "SampleTypeTitle": "Peptide",
    "ClientSampleID": "CJC-1295",
    "DateReceived": "2026-08-25T04:26:00+00:00",
    "CoaCompanyName": "Acme",
    "Analyses": [{"uid": "a1"}],
    "Attachment": [],
    "PEP1": "CJC-1295 (no DAC)",
    "QTY_1": "5",
    "DeclaredTotalQuantity": "5",
}

_WIRE_ROWS = [{
    "uid": "mk1:144", "Keyword": "HPLC-PUR",
    "Title": "Peptide Purity (HPLC)", "ServiceTitle": "Peptide Purity (HPLC)",
    "Result": "12", "Unit": "%", "review_state": "published",
    "ResultCaptureDate": "2026-08-25T04:26:00+00:00",
}]


def _client(monkeypatch, tmp_path, calls):
    c = SenaiteClient(base_url="http://senaite.test", username="u", password="p")
    c.results_dir = str(tmp_path)

    def fake_get(url, params=None):
        calls.append(url)
        if url.endswith("/search"):
            return {"items": [{"uid": "abc123", "id": "P-0161"}]}
        return dict(_AR)

    monkeypatch.setattr(c, "_get", fake_get)
    monkeypatch.setattr(c, "_save_result", lambda *a, **k: None)
    return c


def test_wire_rows_replace_analyses_and_skip_senaite_fetch(monkeypatch, tmp_path):
    calls = []
    c = _client(monkeypatch, tmp_path, calls)
    seen = {}

    def spy_collect(sample_json):
        seen["collected"] = True

    monkeypatch.setattr(c, "_collect_analyses_details", spy_collect)

    from coabuilder_core.conformance import ConformanceEngine
    orig = ConformanceEngine.process

    def spy_process(self, sample_json, **kw):
        seen["analyses"] = sample_json.get("_Analyses_Detailed")
        return orig(self, sample_json, **kw)

    monkeypatch.setattr(ConformanceEngine, "process", spy_process)

    data = c.fetch_sample_data("P-0161", legacy_rows=_WIRE_ROWS)
    assert data is not None
    assert seen.get("collected") is None          # SENAITE analyses never fetched
    assert seen["analyses"] == _WIRE_ROWS         # engines got the wire rows


def test_without_wire_rows_senaite_path_unchanged(monkeypatch, tmp_path):
    calls = []
    c = _client(monkeypatch, tmp_path, calls)
    seen = {}
    monkeypatch.setattr(
        c, "_collect_analyses_details",
        lambda sj: seen.setdefault("collected", True) and None,
    )
    data = c.fetch_sample_data("P-0161")
    assert data is not None
    assert seen.get("collected") is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_fetch_legacy_rows.py -q`
Expected: FAIL — `TypeError: fetch_sample_data() got an unexpected keyword argument 'legacy_rows'`

- [ ] **Step 3: Implement the substitution**

In `src/coabuilder_core/senaite_client.py`:

(a) Add the parameter to the signature (after `published_date_override`):

```python
    def fetch_sample_data(
        self,
        sample_id: str,
        display_name_overrides: Optional[Dict[int, str]] = None,
        variance_replicates: Optional[Dict[str, list]] = None,
        variance_analytes: Optional[Dict[str, dict]] = None,
        vial_figures: Optional[Dict[str, dict]] = None,
        published_date_override: Optional[str] = None,
        legacy_rows: Optional[List[Dict]] = None,
    ) -> Optional[CoAData]:
```

(b) Replace the unconditional `self._collect_analyses_details(sample_json)` call with:

```python
        # Seam 4 (slice 1): Mk1-sourced legacy rows replace SENAITE's analysis
        # lines wholesale — no per-analysis SENAITE round-trips at all. The
        # rows arrive pre-validated (legacy_rows.extract_legacy_rows) in the
        # exact SENAITE casing the engines read.
        if legacy_rows is not None:
            sample_json["_Analyses_Detailed"] = legacy_rows
        else:
            self._collect_analyses_details(sample_json)
```

(c) Guard the analysis-level attachment fallback scan (~:515). Change its condition from
`if not att_files_map.get("image") and "_Analyses_Detailed" in sample_json:` to:

```python
        # Wire rows carry no Attachment links, so the analysis-level image
        # fallback cannot run in mk1 mode — the Mk1 pre-flight gate already
        # guarantees an AR-level sample image before generation.
        if (not att_files_map.get("image") and legacy_rows is None
                and "_Analyses_Detailed" in sample_json):
```

- [ ] **Step 4: Run the new test and the existing engine suites**

Run: `python -m pytest tests/test_fetch_legacy_rows.py tests/test_retest_supersession_dedup.py tests/test_addon_parsing.py -q`
Expected: PASS (all — the two existing suites prove the SENAITE path is untouched)

- [ ] **Step 5: Commit**

```bash
git add src/coabuilder_core/senaite_client.py tests/test_fetch_legacy_rows.py
git commit -m "feat(seam4): fetch_sample_data substitutes Mk1 legacy rows for SENAITE lines"
```

---

### Task 3: coab — server wiring + `data_sources` echo

**Working directory:** `C:\tmp\coabuilder-seam4`

**Files:**
- Modify: `scripts/server.py` (`/process` ~:574-694 and `/process-additional` ~:1024-1101, response dicts at ~:979 and ~:1169)
- Create: `tests/test_server_legacy_rows.py`

**Interfaces:**
- Consumes: `extract_legacy_rows` (Task 1), `fetch_sample_data(legacy_rows=...)` (Task 2).
- Produces: `/process` and `/process-additional` responses gain `"data_sources": {"legacy_rows": "mk1"|"senaite"}`. Mk1 Task 7's drift detector reads it.

- [ ] **Step 1: Write the failing test**

Use the import preamble from `tests/test_native_sections_server.py` verbatim (it neutralizes `validate_startup_config` when `app_settings.json` is absent — copy that whole guarded block including its comment):

```python
"""/process wiring: legacy_rows extracted from body.native_sections, passed to
fetch_sample_data, echoed in data_sources."""
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

_ROOT = Path(__file__).resolve().parent.parent
if not (_ROOT / "app_settings.json").is_file():
    import coabuilder_core.config_validator as _cv
    _cv.validate_startup_config = lambda **kw: None

import pytest
from fastapi.testclient import TestClient

import scripts.server as server
from coabuilder_core.data_model import CoAData

_ROW = {
    "uid": "mk1:144", "Keyword": "HPLC-PUR",
    "Title": "Peptide Purity (HPLC)", "ServiceTitle": "Peptide Purity (HPLC)",
    "Result": "12", "Unit": "%", "review_state": "published",
    "ResultCaptureDate": "2026-08-25T04:26:00+00:00",
}
_DOC = {"sample_id": "P-1", "ordered_profiles": [], "sections": [],
        "legacy_rows": {"source": "mk1", "rows": [_ROW]}}


@pytest.fixture
def client(monkeypatch, tmp_path):
    seen = {}

    def fake_fetch(self, sample_id, **kw):
        seen["legacy_rows"] = kw.get("legacy_rows")
        d = CoAData()
        d.sample_code = sample_id
        d.results = []
        return d

    monkeypatch.setattr(server.SenaiteClient, "fetch_sample_data", fake_fetch)
    monkeypatch.setenv("SENAITE_URL", "http://senaite.test")
    monkeypatch.setenv("SENAITE_USERNAME", "u")
    monkeypatch.setenv("SENAITE_PASSWORD", "p")

    # No verification code / PDF concerns: IntegrationClient failures are
    # non-fatal by design, and the generator is stubbed to write a file.
    from coabuilder_core.generator import FrameBasedPDFGenerator
    def fake_generate(self, data, output_path, templates=None):
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        with open(output_path, "wb") as f:
            f.write(b"%PDF-fake")
    monkeypatch.setattr(FrameBasedPDFGenerator, "generate", fake_generate)

    return TestClient(server.app), seen


def test_process_passes_wire_rows_and_echoes_mk1(client):
    c, seen = client
    resp = c.post("/process/P-1", json={"native_sections": _DOC})
    assert resp.status_code == 200
    assert seen["legacy_rows"] == [_ROW]
    assert resp.json()["data_sources"] == {"legacy_rows": "mk1"}


def test_process_without_block_stays_senaite(client):
    c, seen = client
    resp = c.post("/process/P-1", json={})
    assert resp.status_code == 200
    assert seen["legacy_rows"] is None
    assert resp.json()["data_sources"] == {"legacy_rows": "senaite"}


def test_process_malformed_block_is_422(client):
    c, seen = client
    bad = {"sample_id": "P-1", "ordered_profiles": [], "sections": [],
           "legacy_rows": {"rows": []}}
    resp = c.post("/process/P-1", json={"native_sections": bad})
    assert resp.status_code == 422
    assert "legacy_rows" in resp.json()["detail"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_server_legacy_rows.py -q`
Expected: FAIL — `KeyError: 'data_sources'` (and `seen["legacy_rows"]` is None on the first test)

- [ ] **Step 3: Wire the endpoints**

In `scripts/server.py` `/process` (after the `published_date_override` validation block ~:616, BEFORE the SENAITE client is constructed):

```python
    # Seam 4 (slice 1): Mk1-sourced legacy rows. Validated fail-closed here so
    # a malformed block 422s before any SENAITE call or code mint.
    from coabuilder_core.legacy_rows import extract_legacy_rows
    from coabuilder_core.native_sections import NativeSectionsValidationError
    try:
        wire_legacy_rows = extract_legacy_rows(body.native_sections if body else None)
    except NativeSectionsValidationError as e:
        raise HTTPException(status_code=422, detail=e.detail)
```

Pass it to the fetch (~:665): add `legacy_rows=wire_legacy_rows,` to the existing `client.fetch_sample_data(...)` call.

Add to `response_data` (~:979):

```python
        "data_sources": {"legacy_rows": "mk1" if wire_legacy_rows is not None else "senaite"},
```

In `/process-additional` (~:1067, before its `fetch_sample_data` call): the same
extract block (same four lines, reusing the same imports pattern), then add
`legacy_rows=wire_legacy_rows,` to its `client.fetch_sample_data(...)` call, and add
the same `"data_sources"` entry to its return dict (~:1169).

- [ ] **Step 4: Run the new test + existing server suites**

Run: `python -m pytest tests/test_server_legacy_rows.py tests/test_native_sections_server.py tests/test_published_date_override.py -q`
Expected: PASS (all)

- [ ] **Step 5: Commit**

```bash
git add scripts/server.py tests/test_server_legacy_rows.py
git commit -m "feat(seam4): /process + /process-additional accept legacy_rows, echo data_sources"
```

---

### Task 4: Mk1 — `coa_generation_source` settings reader

**Working directory:** `C:\tmp\Accu-Mk1-methods`

**Files:**
- Create: `backend/coa/source_setting.py`
- Create: `backend/tests/test_coa_source_setting.py`

**Interfaces:**
- Consumes: `models.Settings` (key/value rows, see `backend/main.py:1595-1636`).
- Produces: `coa_generation_source(db) -> str` (`"senaite"` | `"mk1"`), `COA_SOURCE_KEY = "coa_generation"`, `READ_SOURCE_SETTING_KEY = "registry_read_source"`. Task 6 calls it.

- [ ] **Step 1: Write the failing test**

Follow the existing backend test DB conventions — open `backend/tests/test_coa_sections_endpoint.py` and reuse its session/fixture pattern for an in-memory or transactional test DB. The behavioral cases:

```python
"""coa_generation_source: fail-safe reader of the Data Source map's
coa_generation key. Default is ALWAYS senaite."""
import json

import pytest

from coa.source_setting import (COA_SOURCE_KEY, READ_SOURCE_SETTING_KEY,
                                coa_generation_source)
from models import Settings


def _set(db, value):
    row = db.query(Settings).filter(Settings.key == READ_SOURCE_SETTING_KEY).one_or_none()
    if row is None:
        row = Settings(key=READ_SOURCE_SETTING_KEY, value=value)
        db.add(row)
    else:
        row.value = value
    db.commit()


def test_absent_row_defaults_senaite(db_session):
    assert coa_generation_source(db_session) == "senaite"


def test_map_without_key_defaults_senaite(db_session):
    _set(db_session, json.dumps({"sample_details": "mk1"}))
    assert coa_generation_source(db_session) == "senaite"


def test_mk1_value_read(db_session):
    _set(db_session, json.dumps({"sample_details": "mk1", COA_SOURCE_KEY: "mk1"}))
    assert coa_generation_source(db_session) == "mk1"


def test_senaite_value_read(db_session):
    _set(db_session, json.dumps({COA_SOURCE_KEY: "senaite"}))
    assert coa_generation_source(db_session) == "senaite"


@pytest.mark.parametrize("raw", ["not json", "[]", json.dumps({"coa_generation": "bogus"}), ""])
def test_malformed_or_unknown_defaults_senaite(db_session, raw):
    _set(db_session, raw)
    assert coa_generation_source(db_session) == "senaite"
```

(Adapt the `db_session` fixture name to whatever the existing backend conftest provides — check `backend/tests/conftest.py` first and use its idiom.)

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest backend/tests/test_coa_source_setting.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'coa.source_setting'`

- [ ] **Step 3: Write the implementation**

```python
"""Backend reader for the Data Source map's `coa_generation` key.

The `registry_read_source` Settings row is a JSON object owned by the FE
Data Source pane. The page keys (sample_details, ...) are FE-read;
`coa_generation` is the first backend-read key: it decides whether the COA
wire document carries Mk1-sourced legacy rows. Per-session FE page
overrides deliberately do NOT apply here.

Fail-safe: any absence or malformation means "senaite" (the default and
rollback posture).
"""
import json

from sqlalchemy import select
from sqlalchemy.orm import Session

COA_SOURCE_KEY = "coa_generation"
READ_SOURCE_SETTING_KEY = "registry_read_source"


def coa_generation_source(db: Session) -> str:
    from models import Settings

    row = db.execute(
        select(Settings).where(Settings.key == READ_SOURCE_SETTING_KEY)
    ).scalar_one_or_none()
    if row is None or not row.value:
        return "senaite"
    try:
        parsed = json.loads(row.value)
    except (ValueError, TypeError):
        return "senaite"
    val = parsed.get(COA_SOURCE_KEY) if isinstance(parsed, dict) else None
    return val if val in ("senaite", "mk1") else "senaite"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest backend/tests/test_coa_source_setting.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/coa/source_setting.py backend/tests/test_coa_source_setting.py
git commit -m "feat(seam4): backend reader for coa_generation data-source key"
```

---

### Task 5: Mk1 — `build_legacy_rows` projection + twin contract test

**Working directory:** `C:\tmp\Accu-Mk1-methods`

**Files:**
- Create: `backend/coa/legacy_rows.py`
- Create: `backend/tests/test_legacy_rows_contract.py`

**Interfaces:**
- Consumes: `lims_analyses.service.list_parent_analyses_senaite_shape(db, sample_id) -> List[SenaiteShapeAnalysisResponse]` (fields used: `uid`, `keyword`, `title`, `result`, `unit`, `review_state`, `captured`, `service_origin` — see `backend/lims_analyses/schemas.py:212`). `coa.native_sections.NativeSectionsError`.
- Produces: `build_legacy_rows(db, parent) -> list[dict]` and `FIELD_CONTRACT`. Task 6 wraps it.

- [ ] **Step 1: Write the failing test**

Monkeypatch the emitter — its selection semantics are already covered by `backend/tests/test_list_parent_analyses_senaite_shape.py`; this test covers the filter, re-case, and fail-closed rules only:

```python
"""Twin contract test — coab side: tests/test_legacy_rows_contract.py in the
coabuilder repo pins the same FIELD_CONTRACT tuple and row shapes. Move them
together."""
from types import SimpleNamespace

import pytest

import coa.legacy_rows as lr
from coa.legacy_rows import FIELD_CONTRACT, build_legacy_rows
from coa.native_sections import NativeSectionsError


def _shaped(**over):
    base = dict(
        uid="mk1:144", keyword="HPLC-PUR", title="Peptide Purity (HPLC)",
        result="12", unit="%", review_state="published",
        captured="2026-08-25T04:26:00+00:00", service_origin="senaite",
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest backend/tests/test_legacy_rows_contract.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'coa.legacy_rows'`

- [ ] **Step 3: Write the implementation**

```python
"""Legacy-family rows projection for the COA wire document (seam 4, slice 1).

Emits SENAITE-cased dicts matching exactly what COABuilder's engines read
from `_Analyses_Detailed`. Row selection is delegated wholesale to
list_parent_analyses_senaite_shape — current-row resolution, retest
supersession, tier guard, and the cross-provenance canonical-wins keyword
collapse all live there; this module only filters to legacy families
(service_origin == 'senaite') and re-cases.

FAIL-CLOSED (NativeSectionsError): zero legacy rows, or a row without a
keyword. Until pure-native samples exist, an empty legacy set can only mean
a broken mirror, and an empty results table on a certificate is the silent
failure this program exists to prevent. Result may be None (pending micro
lines are legal — the engines own pending semantics).

Spec: docs/superpowers/specs/2026-08-26-coa-legacy-rows-mk1-source-design.md
"""
from coa.native_sections import NativeSectionsError

# Twin contract: src/coabuilder_core/legacy_rows.py + tests/
# test_legacy_rows_contract.py in the coabuilder repo pin the same tuple.
# Move both sides together.
FIELD_CONTRACT = (
    "uid", "Keyword", "Title", "ServiceTitle",
    "Result", "Unit", "review_state", "ResultCaptureDate",
)


def _shaped_rows(db, sample_id):
    from lims_analyses.service import list_parent_analyses_senaite_shape
    return list_parent_analyses_senaite_shape(db, sample_id)


def build_legacy_rows(db, parent) -> list[dict]:
    shaped = _shaped_rows(db, parent.sample_id)
    legacy = [r for r in shaped if r.service_origin == "senaite"]
    if not legacy:
        raise NativeSectionsError(
            f"legacy rows: no legacy-family analyses found for "
            f"{parent.sample_id} — refusing to assemble an empty results "
            f"table (mirror gap?)")
    rows = []
    for r in legacy:
        if not (r.keyword or "").strip():
            raise NativeSectionsError(
                f"legacy rows: analysis {r.uid} on {parent.sample_id} has no "
                f"keyword — aborting")
        rows.append({
            "uid": r.uid,
            "Keyword": r.keyword,
            "Title": r.title,
            "ServiceTitle": r.title,
            "Result": r.result,
            "Unit": r.unit,
            "review_state": r.review_state,
            "ResultCaptureDate": r.captured,
        })
    return rows
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest backend/tests/test_legacy_rows_contract.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/coa/legacy_rows.py backend/tests/test_legacy_rows_contract.py
git commit -m "feat(seam4): SENAITE-cased legacy-rows projection for the COA wire doc"
```

---

### Task 6: Mk1 — wire-document assembly wrapper

**Working directory:** `C:\tmp\Accu-Mk1-methods`

**Files:**
- Create: `backend/coa/wire_document.py`
- Create: `backend/tests/test_coa_wire_document.py`

**Interfaces:**
- Consumes: `build_native_sections(db, parent) -> dict` (`backend/coa/native_sections.py:162`), `build_legacy_rows` (Task 5), `coa_generation_source` (Task 4).
- Produces: `build_coa_wire_document(db, parent) -> dict`, `build_vial_wire_document(db, parent) -> Optional[dict]`, `warn_if_source_ignored(doc, response_json, sample_id) -> None`. Task 7 swaps these into `backend/main.py`.

- [ ] **Step 1: Write the failing test**

```python
"""Assembly wrapper: native_sections + (mk1 mode) legacy_rows block."""
import logging
from types import SimpleNamespace

import coa.wire_document as wd
from coa.wire_document import (build_coa_wire_document,
                               build_vial_wire_document,
                               warn_if_source_ignored)

_PARENT = SimpleNamespace(sample_id="P-0161")
_NATIVE_DOC = {"sample_id": "P-0161", "ordered_profiles": ["heavy_metals"],
               "sections": [{"profile_key": "heavy_metals"}]}
_ROWS = [{"uid": "mk1:1", "Keyword": "HPLC-PUR", "Title": "t",
          "ServiceTitle": "t", "Result": "12", "Unit": "%",
          "review_state": "published", "ResultCaptureDate": None}]


def _patch(monkeypatch, source):
    monkeypatch.setattr(wd, "build_native_sections", lambda db, p: dict(_NATIVE_DOC))
    monkeypatch.setattr(wd, "build_legacy_rows", lambda db, p: list(_ROWS))
    monkeypatch.setattr(wd, "coa_generation_source", lambda db: source)


def test_senaite_mode_doc_unchanged(monkeypatch):
    _patch(monkeypatch, "senaite")
    doc = build_coa_wire_document(None, _PARENT)
    assert doc == _NATIVE_DOC
    assert "legacy_rows" not in doc


def test_mk1_mode_attaches_legacy_block(monkeypatch):
    _patch(monkeypatch, "mk1")
    doc = build_coa_wire_document(None, _PARENT)
    assert doc["legacy_rows"] == {"source": "mk1", "rows": _ROWS}
    assert doc["ordered_profiles"] == ["heavy_metals"]   # native part intact


def test_vial_doc_none_in_senaite_mode(monkeypatch):
    _patch(monkeypatch, "senaite")
    assert build_vial_wire_document(None, _PARENT) is None


def test_vial_doc_is_legacy_only_in_mk1_mode(monkeypatch):
    # Vial certificates have never rendered native sections and must not
    # start now — sections stay empty on purpose.
    _patch(monkeypatch, "mk1")
    doc = build_vial_wire_document(None, _PARENT)
    assert doc == {"sample_id": "P-0161", "ordered_profiles": [],
                   "sections": [], "legacy_rows": {"source": "mk1", "rows": _ROWS}}


def test_warn_fires_on_source_mismatch(caplog):
    doc = {"legacy_rows": {"rows": _ROWS}}
    with caplog.at_level(logging.WARNING):
        warn_if_source_ignored(doc, {"data_sources": {"legacy_rows": "senaite"}}, "P-1")
    assert any("mk1" in r.message for r in caplog.records)


def test_warn_silent_when_honored_or_not_requested(caplog):
    with caplog.at_level(logging.WARNING):
        warn_if_source_ignored({"legacy_rows": {}}, {"data_sources": {"legacy_rows": "mk1"}}, "P-1")
        warn_if_source_ignored({"sections": []}, {}, "P-1")
        warn_if_source_ignored(None, {}, "P-1")
    assert caplog.records == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest backend/tests/test_coa_wire_document.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'coa.wire_document'`

- [ ] **Step 3: Write the implementation**

```python
"""Assembly wrapper: the COA wire document = native sections + (mk1 mode)
the legacy_rows block. Single choke point for the coa_generation toggle so
every call site (generate, regular-child, regen-primary, S2S for IS
additionals, per-vial) behaves identically.

Spec: docs/superpowers/specs/2026-08-26-coa-legacy-rows-mk1-source-design.md
"""
import logging

from coa.legacy_rows import build_legacy_rows
from coa.native_sections import build_native_sections
from coa.source_setting import coa_generation_source

log = logging.getLogger(__name__)


def _legacy_block(db, parent) -> dict:
    return {"source": "mk1", "rows": build_legacy_rows(db, parent)}


def build_coa_wire_document(db, parent) -> dict:
    """The document COABuilder receives as `native_sections`.

    Raises NativeSectionsError (from either builder) — callers keep their
    existing fail-closed handling.
    """
    doc = build_native_sections(db, parent)
    if coa_generation_source(db) == "mk1":
        doc["legacy_rows"] = _legacy_block(db, parent)
    return doc


def build_vial_wire_document(db, parent):
    """Legacy-only document for per-vial COA bodies, or None in senaite mode.

    Vial certificates have never rendered native sections and must not start
    now — only their base row sourcing follows the toggle, so sections stay
    empty on purpose.
    """
    if coa_generation_source(db) != "mk1":
        return None
    return {
        "sample_id": parent.sample_id,
        "ordered_profiles": [],
        "sections": [],
        "legacy_rows": _legacy_block(db, parent),
    }


def warn_if_source_ignored(doc, response_json, sample_id) -> None:
    """Drift detector: the toggle said mk1 but COABuilder didn't use the rows
    (old COABuilder deployed, or the block was dropped en route). Loud, never
    fatal — the certificate already generated from SENAITE lines."""
    if not doc or "legacy_rows" not in doc:
        return
    used = ((response_json or {}).get("data_sources") or {}).get("legacy_rows")
    if used != "mk1":
        log.warning(
            "COA source toggle is mk1 but COABuilder reported legacy_rows "
            "source %r for %s — check the deployed COABuilder version",
            used, sample_id,
        )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest backend/tests/test_coa_wire_document.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/coa/wire_document.py backend/tests/test_coa_wire_document.py
git commit -m "feat(seam4): wire-document assembly wrapper + source drift detector"
```

---

### Task 7: Mk1 — call-site swap in `backend/main.py`

**Working directory:** `C:\tmp\Accu-Mk1-methods`

**Files:**
- Modify: `backend/main.py` — five sites:
  1. `_maybe_emit_regular_coa_child` (~:11527-11529)
  2. `generate_sample_coa` (~:11734-11742, plus after `data = resp.json()` ~:11751)
  3. `generate_vial_coas` (~:11930-11970)
  4. `regen_primary_coa` (~:12303-12311, plus after its response parse)
  5. S2S `get_sample_coa_sections` (~:21159-21161)
- Modify: `backend/tests/test_coa_sections_endpoint.py` (extend)

**Interfaces:**
- Consumes: all three functions from Task 6.
- Produces: every COA path attaches the toggled document; IS additionals inherit via the S2S endpoint.

- [ ] **Step 1: Write the failing test (extend `test_coa_sections_endpoint.py`)**

Read the existing tests in `backend/tests/test_coa_sections_endpoint.py` first and reuse their app/client/db fixtures. Add:

```python
def test_s2s_coa_sections_carries_legacy_rows_in_mk1_mode(client_s2s, db_session, monkeypatch):
    """The S2S document endpoint (IS additional-COA path) must route through
    build_coa_wire_document so IS-driven additionals inherit the toggle."""
    import coa.wire_document as wd
    monkeypatch.setattr(wd, "coa_generation_source", lambda db: "mk1")
    monkeypatch.setattr(
        wd, "build_legacy_rows",
        lambda db, p: [{"uid": "mk1:1", "Keyword": "HPLC-PUR", "Title": "t",
                        "ServiceTitle": "t", "Result": "12", "Unit": "%",
                        "review_state": "published", "ResultCaptureDate": None}],
    )
    resp = client_s2s.get(f"/samples/{SAMPLE_ID}/coa-sections")
    assert resp.status_code == 200
    body = resp.json()
    assert body["legacy_rows"]["source"] == "mk1"
    assert body["legacy_rows"]["rows"][0]["Keyword"] == "HPLC-PUR"


def test_s2s_coa_sections_unchanged_in_senaite_mode(client_s2s, db_session, monkeypatch):
    import coa.wire_document as wd
    monkeypatch.setattr(wd, "coa_generation_source", lambda db: "senaite")
    resp = client_s2s.get(f"/samples/{SAMPLE_ID}/coa-sections")
    assert resp.status_code == 200
    assert "legacy_rows" not in resp.json()
```

(Adapt fixture/sample-id names to the file's existing idiom — `SAMPLE_ID` here stands for whatever seeded sample the existing tests use. IMPORTANT: the monkeypatches must target `coa.wire_document`'s module attributes, which requires main.py to import from that module — that is exactly what this task changes.)

- [ ] **Step 2: Run to verify the new tests fail**

Run: `python -m pytest backend/tests/test_coa_sections_endpoint.py -q`
Expected: the two new tests FAIL (`legacy_rows` absent — endpoint still calls `build_native_sections` directly); existing tests PASS.

- [ ] **Step 3: Swap the call sites**

All five edits. `NativeSectionsError` handling stays exactly where it is — `build_coa_wire_document` raises the same exception type.

1. `_maybe_emit_regular_coa_child` — replace:
```python
    from coa.native_sections import NativeSectionsError, build_native_sections
    try:
        body["native_sections"] = build_native_sections(db, parent_row)
```
with:
```python
    from coa.native_sections import NativeSectionsError
    from coa.wire_document import build_coa_wire_document
    try:
        body["native_sections"] = build_coa_wire_document(db, parent_row)
```

2. `generate_sample_coa` — same substitution pattern for the `_native_doc = build_native_sections(db, _parent_row)` block (import `build_coa_wire_document` + `warn_if_source_ignored` from `coa.wire_document`, keep the `NativeSectionsError` import from `coa.native_sections`). Then, immediately after `data = resp.json()` (~:11751), add:
```python
    # Drift detector (seam 4): loud warning if the mk1 toggle was ignored
    # downstream (old COABuilder, or the block dropped en route).
    if not is_sub:
        warn_if_source_ignored(alias_body.get("native_sections"), data, sample_id)
```

3. `generate_vial_coas` — after the `vials`/`existing` setup and before the loop (~:11953), add:
```python
    # Seam 4: vial COAs follow the coa_generation toggle for their BASE row
    # sourcing, via a legacy-only document (vial certs never render native
    # sections). Fail-closed: an assembly error aborts the whole run.
    from coa.native_sections import NativeSectionsError
    from coa.wire_document import build_vial_wire_document, warn_if_source_ignored
    try:
        _vial_doc = build_vial_wire_document(db, parent)
    except NativeSectionsError as e:
        return _resp(False, f"COA aborted — {e.detail}")
```
Inside the loop, after `vbody` is built:
```python
            if _vial_doc is not None:
                vbody["native_sections"] = _vial_doc
```
And after `data = resp.json()` inside the loop's try:
```python
                warn_if_source_ignored(_vial_doc, data, sample_id)
```

4. `regen_primary_coa` — same substitution as site 2 (wrapper + keep error handling), and add the same `warn_if_source_ignored(alias_body.get("native_sections"), data, sample_id)` call immediately after it parses the COABuilder response JSON (find its `resp.json()` — same shape as `generate_sample_coa`).

5. S2S `get_sample_coa_sections` — replace:
```python
    from coa.native_sections import NativeSectionsError, build_native_sections
    try:
        return build_native_sections(db, parent)
```
with:
```python
    from coa.native_sections import NativeSectionsError
    from coa.wire_document import build_coa_wire_document
    try:
        return build_coa_wire_document(db, parent)
```

- [ ] **Step 4: Run the affected suites**

Run: `python -m pytest backend/tests/test_coa_sections_endpoint.py backend/tests/test_coa_generate_resolver.py backend/tests/test_regular_coa_child.py backend/tests/test_coa_wire_document.py -q`
Expected: PASS (all, including the two new tests)

- [ ] **Step 5: Commit**

```bash
git add backend/main.py backend/tests/test_coa_sections_endpoint.py
git commit -m "feat(seam4): all five COA call sites assemble via build_coa_wire_document"
```

---

### Task 8: Mk1 FE — read-source lib additions

**Working directory:** `C:\tmp\Accu-Mk1-methods`

**Files:**
- Modify: `src/lib/read-source.ts`
- Modify: `src/lib/__tests__/effective-read-source.test.ts` (extend)

**Interfaces:**
- Consumes: existing `ReadSource`, `DEFAULT_READ_SOURCE`, `isSource`, `READ_SOURCE_SETTING_KEY`, `getSettings` query idiom (all already in the file).
- Produces: `COA_SOURCE_KEY = 'coa_generation'`, `parseCoaGenerationSource(raw): ReadSource`, `coaSourceLabel(source): string` (`'SENAITE'` | `'Accu-Mk1'`), `useCoaGenerationSource(): ReadSource`. Tasks 9 and 10 import these. `PAGE_KEYS` and `parseGlobalReadSource` are NOT modified (no session-override machinery for this key).

- [ ] **Step 1: Write the failing test (extend the existing file)**

```typescript
describe('parseCoaGenerationSource', () => {
  it('defaults to senaite for absent/malformed raw', () => {
    expect(parseCoaGenerationSource(undefined)).toBe('senaite')
    expect(parseCoaGenerationSource(null)).toBe('senaite')
    expect(parseCoaGenerationSource('not json')).toBe('senaite')
    expect(parseCoaGenerationSource('[]')).toBe('senaite')
  })

  it('reads coa_generation from the shared map', () => {
    expect(parseCoaGenerationSource(JSON.stringify({ coa_generation: 'mk1' }))).toBe('mk1')
    expect(parseCoaGenerationSource(JSON.stringify({ sample_details: 'mk1' }))).toBe('senaite')
    expect(parseCoaGenerationSource(JSON.stringify({ coa_generation: 'bogus' }))).toBe('senaite')
  })

  it('is NOT a page key — parseGlobalReadSource must ignore it', () => {
    const map = parseGlobalReadSource(JSON.stringify({ coa_generation: 'mk1' }))
    expect(map).toEqual({})
  })
})

describe('coaSourceLabel', () => {
  it('labels both sources', () => {
    expect(coaSourceLabel('senaite')).toBe('SENAITE')
    expect(coaSourceLabel('mk1')).toBe('Accu-Mk1')
  })
})
```

(Add `parseCoaGenerationSource`, `coaSourceLabel` to the file's imports from `@/lib/read-source`.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/__tests__/effective-read-source.test.ts`
Expected: FAIL — imports not exported.

- [ ] **Step 3: Implement in `src/lib/read-source.ts`**

Append:

```typescript
/** Data Source map key for COA generation sourcing. Deliberately NOT a
 *  PageKey: the BACKEND reads this key at wire-document assembly time
 *  (backend/coa/source_setting.py), so per-session page overrides must
 *  never apply — what the badge shows must be what the backend does. */
export const COA_SOURCE_KEY = 'coa_generation'

export function parseCoaGenerationSource(rawValue: string | undefined | null): ReadSource {
  if (!rawValue) return DEFAULT_READ_SOURCE
  try {
    const parsed = JSON.parse(rawValue) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const v = (parsed as Record<string, unknown>)[COA_SOURCE_KEY]
      if (isSource(v)) return v
    }
  } catch { /* fall through */ }
  return DEFAULT_READ_SOURCE
}

export function coaSourceLabel(source: ReadSource): string {
  return source === 'mk1' ? 'Accu-Mk1' : 'SENAITE'
}

export function useCoaGenerationSource(): ReadSource {
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: getSettings })
  const raw = settings?.find((s) => s.key === READ_SOURCE_SETTING_KEY)?.value
  return parseCoaGenerationSource(raw)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/__tests__/effective-read-source.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/read-source.ts src/lib/__tests__/effective-read-source.test.ts
git commit -m "feat(seam4): coa_generation source parsing + hook (non-page key)"
```

---

### Task 9: Mk1 FE — DataSourcePane COA section (with save-merge fix)

**Working directory:** `C:\tmp\Accu-Mk1-methods`

**Files:**
- Modify: `src/components/preferences/panes/DataSourcePane.tsx`
- Modify: `src/components/preferences/panes/__tests__/DataSourcePane.test.tsx` (extend)

**Interfaces:**
- Consumes: `COA_SOURCE_KEY`, `parseCoaGenerationSource` (Task 8); existing pane state/save machinery.
- Produces: the pane renders a "COA generation" section and the saved JSON always includes `coa_generation`.

**⚠️ The load-bearing part:** today `saveMutation` writes `JSON.stringify(sourceByPage)` — page keys only. Once `coa_generation` lives in the same JSON, saving page toggles WITHOUT the merge below would silently erase it. The regression test for that is the point of this task.

- [ ] **Step 1: Write the failing tests (extend the existing test file, reusing its render/fixture idiom)**

```typescript
it('renders the COA generation section with both source buttons', async () => {
  renderPane()   // existing helper in this test file
  expect(await screen.findByText('COA generation')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'COA generation: Accu-Mk1' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'COA generation: SENAITE' })).toBeInTheDocument()
})

it('saving includes coa_generation in the written map', async () => {
  renderPane()
  fireEvent.click(await screen.findByRole('button', { name: 'COA generation: Accu-Mk1' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(updateSettingMock).toHaveBeenCalled())
  const [, written] = updateSettingMock.mock.calls[0]
  expect(JSON.parse(written)).toMatchObject({ coa_generation: 'mk1' })
})

it('saving a page toggle preserves an existing coa_generation value', async () => {
  // Settings fixture must return registry_read_source containing
  // {"sample_details":"senaite","coa_generation":"mk1"} for this test.
  renderPaneWithSettings({ registry_read_source: JSON.stringify({ sample_details: 'senaite', coa_generation: 'mk1' }) })
  fireEvent.click(await screen.findByRole('button', { name: 'Sample details: Accu-Mk1' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(updateSettingMock).toHaveBeenCalled())
  const [, written] = updateSettingMock.mock.calls[0]
  expect(JSON.parse(written)).toMatchObject({ sample_details: 'mk1', coa_generation: 'mk1' })
})
```

(Adapt helper names — `renderPane`, `renderPaneWithSettings`, `updateSettingMock` — to what `DataSourcePane.test.tsx` actually provides; read it first and follow its existing mocking of `getSettings`/`updateSetting`.)

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run src/components/preferences/panes/__tests__/DataSourcePane.test.tsx`
Expected: the three new tests FAIL; existing tests PASS.

- [ ] **Step 3: Implement in `DataSourcePane.tsx`**

- Import `COA_SOURCE_KEY, parseCoaGenerationSource` from `@/lib/read-source`.
- Add state: `const [coaSource, setCoaSource] = useState<ReadSource>('senaite')`.
- In the settings-sync block (`if (settings && settings !== prevSettings)`), add:
  `setCoaSource(parseCoaGenerationSource(settingsMap.get(READ_SOURCE_SETTING_KEY)))`.
- Change the mutationFn to merge:
```typescript
    mutationFn: () =>
      updateSetting(
        READ_SOURCE_SETTING_KEY,
        JSON.stringify({ ...sourceByPage, [COA_SOURCE_KEY]: coaSource })
      ),
```
- After the `{PAGES.map(...)}` block, add the section (same button styling as the page rows, `aria-label={`COA generation: ${source === 'mk1' ? 'Accu-Mk1' : 'SENAITE'}`}`, onClick sets `setCoaSource(source); setIsDirty(true)`):
```tsx
      <SettingsSection title="COA generation">
        <div className="flex items-center gap-0.5 rounded border p-0.5 w-fit">
          {(['senaite', 'mk1'] as const).map(source => (
            <button
              key={source}
              type="button"
              disabled={!isAdmin}
              aria-label={`COA generation: ${source === 'mk1' ? 'Accu-Mk1' : 'SENAITE'}`}
              onClick={() => { setCoaSource(source); setIsDirty(true) }}
              className={cn(
                'px-2 py-1 text-xs font-mono rounded disabled:opacity-50 disabled:cursor-not-allowed',
                coaSource === source
                  ? 'bg-emerald-600/30 text-emerald-400'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {source === 'mk1' ? 'Accu-Mk1' : 'SENAITE'}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Where COABuilder sources legacy-family result rows (core HPLC,
          endotoxin, sterility, bac water) at generation time. No per-user
          override — this is what the backend actually does.
        </p>
        {!isAdmin && (
          <p className="text-xs text-muted-foreground">Only admins can change this.</p>
        )}
      </SettingsSection>
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/preferences/panes/__tests__/DataSourcePane.test.tsx`
Expected: PASS (all)

- [ ] **Step 5: Commit**

```bash
git add src/components/preferences/panes/DataSourcePane.tsx "src/components/preferences/panes/__tests__/DataSourcePane.test.tsx"
git commit -m "feat(seam4): COA generation toggle in Data Source pane (save preserves the key)"
```

---

### Task 10: Mk1 FE — Actions dropdown source badges

**Working directory:** `C:\tmp\Accu-Mk1-methods`

**Files:**
- Modify: `src/components/senaite/SampleDetails.tsx` (dropdown items at ~:5292-5313; add hook near the component's other hooks)

**Interfaces:**
- Consumes: `useCoaGenerationSource`, `coaSourceLabel` (Task 8). Label logic is fully covered by Task 8's tests; this task is wiring, gated by typecheck + lint (SampleDetails has no direct component test — do not add one for a text suffix).

- [ ] **Step 1: Wire the badge**

- Import: `import { useCoaGenerationSource, coaSourceLabel } from '@/lib/read-source'`.
- In the component body (near the other hooks): `const coaGenSource = useCoaGenerationSource()`.
- Update the two dropdown items (keep `DropdownMenuContent` width usable — widen `w-52` to `w-60`):

```tsx
                        <DropdownMenuItem
                          onClick={handleGenerateCOA}
                          disabled={isGeneratingCOA}
                          className="cursor-pointer"
                        >
                          Generate Accumark COA
                          <span className="ml-auto text-[10px] font-mono text-muted-foreground">
                            {coaSourceLabel(coaGenSource)}
                          </span>
                        </DropdownMenuItem>
```

and the same `<span>` (same classes, same `coaSourceLabel(coaGenSource)`) appended inside the "Generate Per-Vial COAs" item.

- [ ] **Step 2: Typecheck + lint (zero-new via stash-compare)**

Run: `npx tsc --noEmit`
Expected: no new errors.
Run: `npx eslint src/components/senaite/SampleDetails.tsx`
Expected: no NEW findings vs master (compare against `git stash`-baseline if the file has pre-existing findings).

- [ ] **Step 3: Commit**

```bash
git add src/components/senaite/SampleDetails.tsx
git commit -m "feat(seam4): COA source badge on Generate COA dropdown items"
```

---

### Task 11: Full gates, both repos

**Working directories:** both.

- [ ] **Step 1: coab full suite** (in `C:\tmp\coabuilder-seam4`)

Run: `python -m pytest tests/ -q`
Expected: PASS (coab's suite has no known baseline failures; investigate anything red).

- [ ] **Step 2: Mk1 backend failure-set diff** (in `C:\tmp\Accu-Mk1-methods`)

Run: `python -m pytest backend/tests/ -q 2>&1 | tail -30`
Compare the failure SET against the master baseline (stash the branch changes and re-run if unsure). Gate: **no new failures** — never chase zero-failures (known baseline exists).

- [ ] **Step 3: Mk1 FE gates**

Run: `npx tsc --noEmit && npx vitest run`
Expected: typecheck clean; test failure-set diff vs baseline = empty.

- [ ] **Step 4: Commit any stragglers, then report**

Both branches stay local until the orchestrator reviews; PR creation is the orchestrator's step (PR bodies must carry root cause + test plan per repo convention).

## Deploy notes (for the eventual release — NOT part of this plan's execution)

- Deploy order: **coab before Mk1** (established BEFORE/WITH rule). 2.32.0's validator ignores unknown doc keys, and the toggle defaults `senaite`, so mixed versions are safe but inert.
- Arcitest first: flip `coa_generation=mk1` in Data Source, generate a peptide blend + endo/sterility sample + a bac-water sample; diff `coa_data` against a senaite-mode generation of the same samples. Watch for the drift-detector warning in Mk1 logs (should NOT appear once both sides are deployed).
- Prod default stays `senaite` until the Handler flips it.

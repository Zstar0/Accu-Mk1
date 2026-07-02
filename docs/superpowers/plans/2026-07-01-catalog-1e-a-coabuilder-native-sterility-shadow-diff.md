# Catalog 1E-a — coabuilder Native Sterility Read + Shadow-Diff (additive, nothing cut) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give coabuilder the ability to read a sample's sterility results from **Accu-Mk1** (in addition to SENAITE) and run a **shadow-diff** comparing the two, so we can prove parity on real samples *before* any SENAITE seam is cut.

**Architecture:** Two repos, fully additive. (1) Accu-Mk1 gains one server-to-server endpoint (`X-Service-Token`) returning verified parent-tier sterility results by `sample_id`, reusing `list_promotions_for_parent`. (2) coabuilder gains an Accu-Mk1 HTTP client and a standalone `sterility_shadow_diff` that fetches native sterility, normalizes it with the **existing `parse_sterility`**, and compares it per-keyword against the SENAITE-sourced values — logging discrepancies as validation evidence. **SENAITE remains the authoritative COA source; nothing is cut.** The source-flip and the seam cuts (promote write-back, order→AR) are later, separately-gated steps.

**Tech Stack:** Python 3, FastAPI + SQLAlchemy (Accu-Mk1), `requests` + `python-jose` (coabuilder); pytest.

**What 1E-a proves — and what it does NOT (read before pitching this as a safety gate):** the promote path writes the native parent-tier row (`routes.py:305`) **and** the SENAITE write-back (`routes.py:345-351`) from the *same value in one operation*. So on any natively-promoted sample, native == SENAITE **by construction** — a `match=true` from this read-time value-diff is near-tautological and is **not** parity-proof that the native source can safely replace SENAITE on a certificate. What this slice genuinely validates is the native **read/normalize plumbing** — `AccumkClient → normalize_native_sterility → parse_sterility` is a distinct code path from how the value was written, so the diff catches keyword-mapping bugs, `result_options` misreads, wrong-row bugs, and presence gaps. That's real and worth having. The spec's actual "top control" — a **rendered-COA both-ways diff, retained as evidence** — belongs to the later *source-flip/cut* slice, not here. Pitch 1E-a as "the native read pipeline works end-to-end," not "parity is proven."

## Global Constraints

- **Additive, nothing cut.** SENAITE stays the authoritative sterility source for the COA. This slice only *adds* a parallel read + a diff. `coa.addon_results` is NOT altered by the native read. No change to the promote write-back, the order→AR path, or `ADDON_KEYWORDS`.
- **The shadow read is best-effort and MUST NOT affect COA generation.** Every native call is wrapped so a failure (Mk1 down, misconfig, timeout) logs and returns — it can never raise into the COA pipeline. If `ACCUMK1_URL` is unset, the shadow-diff is skipped entirely (prod unaffected until explicitly configured).
- **Reuse `parse_sterility` as the shared normalizer** (`coabuilder/src/coabuilder_core/addon_parsing.py:104-151`) so a native row and a SENAITE row are compared after identical normalization — the diff measures source divergence, not formatting.
- **Auth = `X-Service-Token`** shared secret (`ACCUMK1_INTERNAL_SERVICE_TOKEN` on Mk1 / a matching value coabuilder sends), the same S2S pattern the integration-service uses. NOT JWT (that needs a staff token), NOT `X-API-Key` (not an inbound guard on Mk1).
- **Direct coabuilder→Accu-Mk1** (not proxied through integration-service — the IS is scoped to WP bridging; Mk1 already exposes S2S sample data directly, e.g. `variance-payload`).
- **Sterility keyword set** (the only keywords this slice touches): `STER-PCR`, `STER-USP71`, `PCR-FUNGI`, `PCR-BACTERIA`. Endotoxin (`ENDO-LAL`) is explicitly OUT — it stays SENAITE-sourced.
- **`JWT_SECRET` unchanged.** This slice adds no COA-verification-code logic; it introduces a *separate* `X-Service-Token` for the Mk1 read.
- **coabuilder edit discipline (per coabuilder/CLAUDE.md):** before editing any existing coabuilder symbol, run `gitnexus_impact({target, direction:"upstream"})` and report blast radius; run `gitnexus_detect_changes()` before committing. New files (the client, the shadow module) don't need impact analysis; the one existing-symbol edit (`fetch_sample_data`) does.

## Execution environment (READ FIRST)

This is **cross-repo** and touches the customer-COA pipeline, so it runs in a **fresh isolated `accumark-stack`** with production-shaped data (real promoted-sterility samples for the diff) — NOT the shared `catalog` stack. At execution start, invoke the **`accumark-stack-platform`** skill to spin up an isolated stack, then create worktrees:
- **Accu-Mk1** worktree branched off the current 1C work (`feat/catalog-departments-admin` @ `9bf0ce3`) so the endpoint sees the 1C catalog (STER-USP71 etc.). Suggested branch `feat/1e-a-native-sterility`.
- **coabuilder** worktree off its current HEAD (`2c95762`, detached — create a real branch, e.g. `feat/1e-a-native-sterility`, so `git pull`/push work).
- Mount both to the isolated stack.

**Test loops** (both repos run pytest on the stack containers; no local Python):
- Accu-Mk1 backend: `docker exec <stack>-accu-mk1-backend sh -c "cd /app && python -m pytest tests/<file> -q"` (prefix docker with `DOCKER_HOST=unix:///var/run/docker.sock` if the SSH session's docker context is empty, per the 1C runbook). No restart needed (code-only, pytest reads disk).
- coabuilder: run pytest inside the coabuilder container against the mounted worktree, e.g. `docker exec <stack>-coabuilder sh -c "cd /app && python -m pytest scripts/test_accumk1_client.py -q"` (coabuilder ships pytest in its venv/image). The exact container name + workdir come from the stack the platform skill creates — confirm with `docker ps` at execution start.
- Set `ACCUMK1_URL` + `ACCUMK1_SERVICE_TOKEN` in the coabuilder container's env (matching the backend's `ACCUMK1_INTERNAL_SERVICE_TOKEN`) for the live shadow-diff run in Task 3's stack verification.

Commit convention (both repos): conventional-commit subject + footer
```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DQSWZ3crh9dMhKwU2YHeq7
```
Stage EXPLICIT paths only — NEVER `git add -A`.

---

## File Structure

| Repo | File | Responsibility | Change |
|---|---|---|---|
| Accu-Mk1 | `backend/main.py` | S2S sterility-results endpoint | **Modify** — add `_STERILITY_KEYWORDS` + `GET /samples/{sample_id}/sterility-results` near the other S2S endpoints (after `variance-payload`, ~`:16704`). |
| Accu-Mk1 | `backend/tests/test_sterility_results_endpoint.py` | endpoint auth + shape + filtering | **Create** (clone `test_variance_payload_endpoint.py`). |
| coabuilder | `src/coabuilder_core/accumk1_client.py` | Accu-Mk1 S2S client + native-sterility normalize | **Create** |
| coabuilder | `src/coabuilder_core/sterility_shadow.py` | shadow-diff (fetch native, compare vs SENAITE, log) | **Create** |
| coabuilder | `src/coabuilder_core/senaite_client.py` | wire the shadow-diff into `fetch_sample_data` (one guarded call) | **Modify** — `fetch_sample_data`, right before `return coa` (~`:614`). |
| coabuilder | `scripts/test_accumk1_client.py` | client normalize unit test (mock `requests`) | **Create** |
| coabuilder | `scripts/test_sterility_shadow_diff.py` | diff match/mismatch unit test (mock client) | **Create** |

---

## Task 1: Accu-Mk1 — S2S `sterility-results` endpoint

**Files:**
- Modify: `backend/main.py` (add near the `variance-payload` endpoint, ~`:16699-16704`)
- Test: `backend/tests/test_sterility_results_endpoint.py` (create)

**Interfaces:**
- Consumes: `lims_analyses.service.list_promotions_for_parent(db, parent_sample_id) -> list[ParentPromotionInfo]` (each has `.keyword`, `.result_value`, `.promoted_at`); `auth.require_internal_service_token` (validates `X-Service-Token`).
- Produces: `GET /samples/{sample_id}/sterility-results` → `{"sample_id": str, "sterility_results": [{"keyword": str, "result_value": str|None, "promoted_at": datetime}]}`. Returns an empty list (200, not 404) for an unknown/never-promoted sample — the caller proceeds bare.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_sterility_results_endpoint.py`, cloning the structure of `test_variance_payload_endpoint.py` (TestClient, `X-Service-Token` auth helper). The data-independent auth tests fail RED because the route doesn't exist yet (404 instead of 401).

```python
"""S2S sterility-results endpoint (Catalog 1E-a).

GET /samples/{sample_id}/sterility-results is consumed server-to-server by
coabuilder to read native (Accu-Mk1) sterility results for the shadow-diff
against SENAITE. Auth + shape are data-independent; the 200-with-content path
is exercised live against a real promoted-sterility sample on the stack.
"""
import os

from fastapi.testclient import TestClient

from main import app

client = TestClient(app)


def _auth():
    return {"X-Service-Token": os.environ["ACCUMK1_INTERNAL_SERVICE_TOKEN"]}


def test_requires_service_token():
    resp = client.get("/samples/BW-0013/sterility-results")
    assert resp.status_code == 401


def test_rejects_bad_service_token():
    resp = client.get(
        "/samples/BW-0013/sterility-results",
        headers={"X-Service-Token": "definitely-not-the-token"},
    )
    assert resp.status_code == 401


def test_unknown_sample_returns_empty_list():
    """Unknown sample -> 200 with empty list (caller proceeds bare, no 404)."""
    resp = client.get(
        "/samples/NOPE-DOES-NOT-EXIST-9999/sterility-results", headers=_auth()
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body == {"sample_id": "NOPE-DOES-NOT-EXIST-9999", "sterility_results": []}


def test_shape_and_sterility_only_filter():
    """A known sample returns 200 with the sterility_results shape, and every
    returned row's keyword is in the sterility set (never HPLC/endo)."""
    # BW-0013 is a fixture-stable sterility sample on the dev/stack DB; if absent
    # in a given environment the endpoint still must not 5xx.
    resp = client.get("/samples/BW-0013/sterility-results", headers=_auth())
    assert resp.status_code == 200
    body = resp.json()
    assert set(body.keys()) == {"sample_id", "sterility_results"}
    assert isinstance(body["sterility_results"], list)
    allowed = {"STER-PCR", "STER-USP71", "PCR-FUNGI", "PCR-BACTERIA"}
    for row in body["sterility_results"]:
        assert set(row.keys()) == {"keyword", "result_value", "promoted_at"}
        assert row["keyword"] in allowed
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest tests/test_sterility_results_endpoint.py -q`
Expected: the two auth tests FAIL (route missing → 404, not 401). Confirms the endpoint isn't defined yet.

- [ ] **Step 3: Add the endpoint**

In `backend/main.py`, add near the `variance-payload` endpoint (~`:16704`). Place the constant at module scope (top of the S2S section) and the route beside `variance-payload`:

```python
# Sterility analytes reported natively from Accu-Mk1 (Catalog 1E-a). Endotoxin
# (ENDO-LAL) is intentionally excluded — it stays SENAITE-sourced.
_STERILITY_KEYWORDS = frozenset({"STER-PCR", "STER-USP71", "PCR-FUNGI", "PCR-BACTERIA"})


@app.get("/samples/{sample_id}/sterility-results")
def get_sample_sterility_results(
    sample_id: str,
    db: Session = Depends(get_db),
    _: None = Depends(require_internal_service_token),
):
    """Server-to-server: verified parent-tier sterility results for a sample,
    for coabuilder's native (SENAITE-free) sterility source + shadow-diff.
    Keyed by sample_id (P-XXXX). Empty list for an unknown or never-promoted
    sample (200, not 404) — the caller proceeds bare."""
    from lims_analyses import service as la_service

    promos = la_service.list_promotions_for_parent(db, sample_id)
    rows = [
        {
            "keyword": p.keyword,
            "result_value": p.result_value,
            "promoted_at": p.promoted_at,
        }
        for p in promos
        if p.keyword in _STERILITY_KEYWORDS
    ]
    return {"sample_id": sample_id, "sterility_results": rows}
```

Confirm `require_internal_service_token`, `Depends`, `get_db`, and `Session` are already imported in `main.py` (they are — `variance-payload` uses them at `:16699-16704`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `python -m pytest tests/test_sterility_results_endpoint.py -q`
Expected: auth tests PASS; `test_unknown_sample_returns_empty_list` PASS; `test_shape_and_sterility_only_filter` PASS (or, if BW-0013 has no promoted sterility on this stack, it still passes — empty list satisfies the assertions). No 5xx.

- [ ] **Step 5: Commit**

```bash
git add backend/main.py backend/tests/test_sterility_results_endpoint.py
git commit -m "feat(coa-source): S2S GET /samples/{id}/sterility-results for native sterility read (1E-a)"
```

---

## Task 2: coabuilder — Accu-Mk1 client + native-sterility normalizer

**Files:**
- Create: `src/coabuilder_core/accumk1_client.py`
- Test: `scripts/test_accumk1_client.py`

**Interfaces:**
- Consumes: `addon_parsing.parse_sterility(analysis: dict) -> dict` (the existing normalizer — takes a dict with `"Result"` and `"title"`, returns the addon-row shape used in `CoAData.addon_results`).
- Produces:
  - `AccumkClient(base_url=None, service_token=None)` with `.fetch_sterility_results(sample_id: str) -> list[dict]` → raw Mk1 rows `[{"keyword","result_value","promoted_at"}]` (empty list on any error or when unconfigured).
  - `normalize_native_sterility(rows: list[dict]) -> dict[str, dict]` → `{keyword: parse_sterility-row}` keyed by keyword (so the shadow-diff can match by keyword).
  - `is_configured() -> bool` (module-level: True iff `ACCUMK1_URL` is set).

- [ ] **Step 1: Write the failing test**

Create `scripts/test_accumk1_client.py` (pytest-style, mocks `requests` — no live services). Follows the repo's `scripts/test_*.py` convention.

```python
"""Catalog 1E-a: AccumkClient normalizes native sterility rows via parse_sterility."""
import os
import sys
from unittest import mock

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from src.coabuilder_core.accumk1_client import (
    AccumkClient,
    normalize_native_sterility,
    KEYWORD_TITLES,
)


def _fake_response(payload, status=200):
    r = mock.Mock()
    r.status_code = status
    r.json.return_value = payload
    r.raise_for_status.return_value = None
    return r


def test_fetch_returns_rows_and_sends_service_token():
    client = AccumkClient(base_url="http://mk1.test", service_token="tok-123")
    payload = {"sample_id": "P-0013", "sterility_results": [
        {"keyword": "STER-PCR", "result_value": "0", "promoted_at": "2026-06-01T00:00:00"}]}
    with mock.patch("src.coabuilder_core.accumk1_client.requests.get",
                    return_value=_fake_response(payload)) as g:
        rows = client.fetch_sterility_results("P-0013")
    assert rows == payload["sterility_results"]
    # X-Service-Token header sent; correct URL.
    _, kwargs = g.call_args
    assert kwargs["headers"]["X-Service-Token"] == "tok-123"


def test_fetch_swallows_errors_returns_empty():
    client = AccumkClient(base_url="http://mk1.test", service_token="tok")
    with mock.patch("src.coabuilder_core.accumk1_client.requests.get",
                    side_effect=Exception("boom")):
        assert client.fetch_sterility_results("P-0013") == []


def test_normalize_maps_keyword_to_parsed_row():
    rows = [
        {"keyword": "STER-PCR", "result_value": "0"},      # 0 -> Pass
        {"keyword": "STER-USP71", "result_value": "1"},    # 1 -> Fail
    ]
    out = normalize_native_sterility(rows)
    assert set(out.keys()) == {"STER-PCR", "STER-USP71"}
    assert out["STER-PCR"]["result"] == "Pass"
    assert out["STER-PCR"]["conforms"] is True
    assert out["STER-USP71"]["result"] == "Fail"
    assert out["STER-USP71"]["conforms"] is False
    # Title comes from the keyword map, not the default.
    assert out["STER-USP71"]["test_name"] == KEYWORD_TITLES["STER-USP71"]
```

- [ ] **Step 2: Run the test to verify it fails**

Run (in the coabuilder container): `python -m pytest scripts/test_accumk1_client.py -q`
Expected: FAIL with `ModuleNotFoundError: ...accumk1_client` (module not created yet).

- [ ] **Step 3: Create the client + normalizer**

Create `src/coabuilder_core/accumk1_client.py`:

```python
"""Accu-Mk1 server-to-server client (Catalog 1E-a).

Reads native sterility results from Accu-Mk1 for the shadow-diff against
SENAITE. Auth = X-Service-Token shared secret (same S2S pattern the
integration-service uses). Best-effort: every failure returns empty so the
COA pipeline is never affected.
"""
import os
import logging
from typing import Optional

import requests

from .addon_parsing import parse_sterility

logger = logging.getLogger(__name__)

STERILITY_KEYWORDS = ("STER-PCR", "STER-USP71", "PCR-FUNGI", "PCR-BACTERIA")

# Display titles for parse_sterility (its own default is STER-PCR's title).
KEYWORD_TITLES = {
    "STER-PCR": "Rapid Sterility Screening (PCR)",
    "STER-USP71": "USP<71> Sterility",
    "PCR-FUNGI": "PCR - Fungi",
    "PCR-BACTERIA": "PCR - Bacteria",
}


def is_configured() -> bool:
    """True iff a native Accu-Mk1 source is configured (else shadow read is skipped)."""
    return bool(os.environ.get("ACCUMK1_URL"))


class AccumkClient:
    def __init__(self, base_url: Optional[str] = None, service_token: Optional[str] = None,
                 timeout: float = 5.0):
        self.base_url = (base_url or os.environ.get("ACCUMK1_URL", "")).rstrip("/")
        self.service_token = service_token or os.environ.get("ACCUMK1_SERVICE_TOKEN", "")
        self.timeout = timeout

    def fetch_sterility_results(self, sample_id: str) -> list:
        """GET /samples/{sample_id}/sterility-results. Returns the raw rows
        list, or [] on any error/misconfig (never raises)."""
        if not self.base_url:
            return []
        try:
            resp = requests.get(
                f"{self.base_url}/samples/{sample_id}/sterility-results",
                headers={"X-Service-Token": self.service_token},
                timeout=self.timeout,
            )
            resp.raise_for_status()
            return resp.json().get("sterility_results", []) or []
        except Exception as e:  # best-effort: shadow read must never break the COA
            logger.warning("accumk1.sterility_fetch_failed sample=%s err=%s", sample_id, e)
            return []


def normalize_native_sterility(rows: list) -> dict:
    """Map raw Mk1 rows -> {keyword: parse_sterility-row}, using parse_sterility
    (the same normalizer applied to SENAITE rows) so the shadow-diff compares
    apples to apples."""
    out = {}
    for row in rows:
        kw = row.get("keyword")
        if kw not in STERILITY_KEYWORDS:
            continue
        analysis = {"Result": row.get("result_value", ""), "title": KEYWORD_TITLES.get(kw)}
        out[kw] = parse_sterility(analysis)
    return out
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `python -m pytest scripts/test_accumk1_client.py -q`
Expected: 3/3 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/coabuilder_core/accumk1_client.py scripts/test_accumk1_client.py
git commit -m "feat(coa-source): Accu-Mk1 S2S client + native sterility normalizer (1E-a)"
```

---

## Task 3: coabuilder — shadow-diff, wired into `fetch_sample_data`

**Files:**
- Create: `src/coabuilder_core/sterility_shadow.py`
- Modify: `src/coabuilder_core/senaite_client.py` (`fetch_sample_data`, one guarded call before `return coa`, ~`:614`)
- Test: `scripts/test_sterility_shadow_diff.py`

**Interfaces:**
- Consumes: `accumk1_client.AccumkClient`, `accumk1_client.normalize_native_sterility`, `accumk1_client.is_configured`, `accumk1_client.STERILITY_KEYWORDS`; `addon_parsing.parse_sterility`.
- Produces: `sterility_shadow_diff(sample_id: str, senaite_analyses_detailed: list) -> dict` — a report `{"sample_id", "compared": [...], "match": bool, "senaite_only": [kw], "mk1_only": [kw]}`. It NEVER raises and NEVER mutates its inputs; it logs every mismatch. Returns `{"skipped": True}` when `is_configured()` is False.

- [ ] **Step 1: Write the failing test**

Create `scripts/test_sterility_shadow_diff.py` (mocks the client; no live services):

```python
"""Catalog 1E-a: sterility_shadow_diff compares SENAITE vs Accu-Mk1 per keyword."""
import os
import sys
from unittest import mock

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from src.coabuilder_core import sterility_shadow


def _senaite_analyses(result_value):
    # Shape of sample_json["_Analyses_Detailed"] entries: SENAITE analysis dicts.
    return [
        {"Keyword": "HPLC-ID", "Result": "1"},                 # non-sterility, ignored
        {"Keyword": "STER-PCR", "Result": result_value, "title": "Rapid Sterility Screening (PCR)"},
    ]


def test_match_when_sources_agree(monkeypatch):
    monkeypatch.setattr(sterility_shadow, "is_configured", lambda: True)
    monkeypatch.setattr(
        sterility_shadow.AccumkClient, "fetch_sterility_results",
        lambda self, sid: [{"keyword": "STER-PCR", "result_value": "0"}],
    )
    report = sterility_shadow.sterility_shadow_diff("P-0013", _senaite_analyses("0"))
    assert report["match"] is True
    assert report["senaite_only"] == [] and report["mk1_only"] == []
    assert any(c["keyword"] == "STER-PCR" and c["agree"] for c in report["compared"])


def test_mismatch_flagged_when_sources_disagree(monkeypatch):
    monkeypatch.setattr(sterility_shadow, "is_configured", lambda: True)
    monkeypatch.setattr(
        sterility_shadow.AccumkClient, "fetch_sterility_results",
        lambda self, sid: [{"keyword": "STER-PCR", "result_value": "1"}],  # Fail vs SENAITE Pass
    )
    report = sterility_shadow.sterility_shadow_diff("P-0013", _senaite_analyses("0"))
    assert report["match"] is False
    bad = [c for c in report["compared"] if c["keyword"] == "STER-PCR"][0]
    assert bad["agree"] is False
    assert bad["senaite_result"] == "Pass" and bad["mk1_result"] == "Fail"


def test_mk1_only_when_senaite_missing(monkeypatch):
    monkeypatch.setattr(sterility_shadow, "is_configured", lambda: True)
    monkeypatch.setattr(
        sterility_shadow.AccumkClient, "fetch_sterility_results",
        lambda self, sid: [{"keyword": "STER-USP71", "result_value": "0"}],
    )
    report = sterility_shadow.sterility_shadow_diff("P-0013", _senaite_analyses("0"))
    assert "STER-USP71" in report["mk1_only"]        # native-only (no SENAITE line)
    assert report["match"] is False                   # presence divergence = not a clean match


def test_skips_when_unconfigured(monkeypatch):
    monkeypatch.setattr(sterility_shadow, "is_configured", lambda: False)
    report = sterility_shadow.sterility_shadow_diff("P-0013", _senaite_analyses("0"))
    assert report == {"skipped": True}


def test_never_raises_on_client_error(monkeypatch):
    monkeypatch.setattr(sterility_shadow, "is_configured", lambda: True)
    def _boom(self, sid):
        raise RuntimeError("mk1 down")
    monkeypatch.setattr(sterility_shadow.AccumkClient, "fetch_sterility_results", _boom)
    # Must not raise — best-effort.
    report = sterility_shadow.sterility_shadow_diff("P-0013", _senaite_analyses("0"))
    assert report.get("error") is not None
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest scripts/test_sterility_shadow_diff.py -q`
Expected: FAIL (`ModuleNotFoundError: ...sterility_shadow`).

- [ ] **Step 3: Create the shadow-diff module**

Create `src/coabuilder_core/sterility_shadow.py`:

```python
"""Sterility source shadow-diff (Catalog 1E-a).

Compares the SENAITE-sourced sterility result (current authoritative source)
against the Accu-Mk1 native result for the same sample, per keyword, using the
SAME parse_sterility normalizer. Purpose: validates the native read/normalize
plumbing end-to-end. NOT parity — native and SENAITE share write-provenance on
promoted samples (promote writes both from the same value), so a match is
near-tautological; the rendered-COA parity evidence (ISO 17025 7.11.2) is a
later flip/cut-slice deliverable, not this one. This NEVER alters the COA and
NEVER raises into the pipeline.
"""
import logging
from typing import List, Dict

from .addon_parsing import parse_sterility
from .accumk1_client import (
    AccumkClient,
    normalize_native_sterility,
    is_configured,
    STERILITY_KEYWORDS,
    KEYWORD_TITLES,
)

logger = logging.getLogger(__name__)


def _senaite_sterility_by_keyword(analyses_detailed: List[Dict]) -> Dict[str, Dict]:
    """Extract SENAITE sterility rows from sample_json['_Analyses_Detailed'],
    normalized via parse_sterility, keyed by keyword."""
    out = {}
    for a in analyses_detailed or []:
        kw = a.get("Keyword")
        if kw in STERILITY_KEYWORDS:
            title = a.get("title") or KEYWORD_TITLES.get(kw)
            out[kw] = parse_sterility({"Result": a.get("Result", ""), "title": title})
    return out


def sterility_shadow_diff(sample_id: str, senaite_analyses_detailed: List[Dict]) -> Dict:
    """Diff native (Accu-Mk1) vs SENAITE sterility for one sample. Best-effort,
    read-only, non-raising. SENAITE stays authoritative regardless of outcome."""
    if not is_configured():
        return {"skipped": True}
    try:
        senaite = _senaite_sterility_by_keyword(senaite_analyses_detailed)
        native_rows = AccumkClient().fetch_sterility_results(sample_id)
        native = normalize_native_sterility(native_rows)

        compared = []
        for kw in sorted(set(senaite) & set(native)):
            s_res, m_res = senaite[kw]["result"], native[kw]["result"]
            agree = (s_res == m_res) and (senaite[kw]["status"] == native[kw]["status"])
            compared.append({"keyword": kw, "agree": agree,
                             "senaite_result": s_res, "mk1_result": m_res})
            if not agree:
                logger.warning(
                    "sterility.shadow_diff.MISMATCH sample=%s kw=%s senaite=%s mk1=%s",
                    sample_id, kw, s_res, m_res)

        senaite_only = sorted(set(senaite) - set(native))
        mk1_only = sorted(set(native) - set(senaite))
        match = all(c["agree"] for c in compared) and not senaite_only and not mk1_only
        if senaite_only or mk1_only:
            logger.warning("sterility.shadow_diff.PRESENCE sample=%s senaite_only=%s mk1_only=%s",
                           sample_id, senaite_only, mk1_only)
        report = {"sample_id": sample_id, "compared": compared, "match": match,
                  "senaite_only": senaite_only, "mk1_only": mk1_only}
        logger.info("sterility.shadow_diff sample=%s match=%s compared=%d",
                    sample_id, match, len(compared))
        return report
    except Exception as e:  # never break the COA pipeline
        logger.warning("sterility.shadow_diff.error sample=%s err=%s", sample_id, e)
        return {"sample_id": sample_id, "error": str(e)}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `python -m pytest scripts/test_sterility_shadow_diff.py -q`
Expected: 5/5 PASS.

- [ ] **Step 5: Wire the shadow-diff into `fetch_sample_data` (guarded, best-effort)**

First run impact analysis (coabuilder/CLAUDE.md rule): `gitnexus_impact({target: "fetch_sample_data", direction: "upstream"})` and report the blast radius. `fetch_sample_data` is the COA anchor — expect HIGH usage; the change is additive (one guarded call that ignores its result), so it does not alter existing behavior.

In `src/coabuilder_core/senaite_client.py`, in `fetch_sample_data`, immediately before `return coa` (~`:614`), add:

```python
        # Catalog 1E-a: shadow-diff the native (Accu-Mk1) sterility source vs
        # SENAITE. Read-only, best-effort, never alters coa or raises — SENAITE
        # stays authoritative. Skipped unless ACCUMK1_URL is configured.
        try:
            from .sterility_shadow import sterility_shadow_diff
            sterility_shadow_diff(sample_id, sample_json.get("_Analyses_Detailed", []))
        except Exception:
            pass

        return coa
```

`sample_json` IS in scope here — verified: `fetch_sample_data` spans `senaite_client.py:244-615` (next method `_save_result` starts at `:616`), `sample_json` is assigned at `:298` and holds `_Analyses_Detailed` from `:318`, so it is live at the `return coa` at `:614`. No fallback needed.

- [ ] **Step 6: Re-run the diff test + confirm no COA regression**

Run: `python -m pytest scripts/test_sterility_shadow_diff.py scripts/test_accumk1_client.py -q` → all pass.
Then run coabuilder's existing conformance smoke to confirm the wiring didn't disturb COA assembly: `python -m pytest scripts/test_conformance.py -q` (or run it as a script if it's not pytest-collectable). Expected: unchanged behavior (the shadow call is a no-op when `ACCUMK1_URL` is unset, which it is in that test's env).
Run `gitnexus_detect_changes()` and confirm only the expected symbols/flows changed.

- [ ] **Step 7: Commit**

```bash
git add src/coabuilder_core/sterility_shadow.py scripts/test_sterility_shadow_diff.py src/coabuilder_core/senaite_client.py
git commit -m "feat(coa-source): shadow-diff native Accu-Mk1 sterility vs SENAITE, wired best-effort (1E-a)"
```

- [ ] **Step 8: Stack verification — prove the native read pipeline works end-to-end (NOT parity-for-the-cut)**

This step validates the plumbing (`AccumkClient → normalize → parse_sterility → diff`) against real data — it does **not** prove parity (native == SENAITE by construction on promoted samples; see "What 1E-a proves" at the top). Do not report `match=true` as a safety gate.

1. **First confirm a promoted-sterility sample exists on the stack — else this step is vacuous.** `list_promotions_for_parent` returns only *promoted* (verified) rows, so query the stack DB for one:
   `docker exec <stack>-postgres psql -U postgres -d accumark_mk1 -c "SELECT DISTINCT s.sample_id FROM lims_analyses a JOIN lims_samples s ON s.id=a.lims_sample_pk JOIN lims_analysis_promotions p ON p.parent_analysis_id=a.id WHERE a.keyword IN ('STER-PCR','STER-USP71','PCR-FUNGI','PCR-BACTERIA') LIMIT 5;"`
   If none, note it — the plumbing is still unit-proven (Tasks 2-3), but there's no live sample to exercise; either promote one, or record that live exercise was skipped for lack of data.
2. Set `ACCUMK1_URL` (the backend's in-stack URL) + `ACCUMK1_SERVICE_TOKEN` (matching the backend's `ACCUMK1_INTERNAL_SERVICE_TOKEN`) in the coabuilder container. Generate/refresh a COA for a promoted-sterility sample from step 1. Read the coabuilder logs for `sterility.shadow_diff` lines.
3. **Expected outcomes and how to read them:** for a natively-promoted sample, `match=true` (confirms the read/normalize path returns the same value — plumbing works). For a **legacy** sample (SENAITE STER-PCR line but no native promote), expect `senaite_only=[STER-PCR]`, `match=False` — this is **presence divergence, expected, not a bug** (no native promote happened), so don't misread it as a failure. A per-keyword *value* `MISMATCH` on a sample that has BOTH sources is a genuine finding (a plumbing/mapping bug, since the values share provenance) — investigate and record it; it does not block this additive slice.

Note: the diff is log-only here (plumbing validation), which is fine for this slice. The **retained** ISO 17025 validation evidence — the rendered-COA both-ways diff captured to a durable artifact — is a deliverable of the later source-flip/cut slice, not 1E-a.

---

## Self-Review (completed against the spec)

**Spec coverage (of this additive sub-phase):**
- "coabuilder gains an Accu-Mk1 sterility result source" (spec §183, seam 1 — the read half) → Tasks 1+2.
- Task 3 delivers the read-time value shadow-diff — which validates the native **read/normalize plumbing**, NOT the spec's "top control." The spec's top control (§206, §244) is a *rendered-COA both-ways* diff retained as evidence; because native and SENAITE share write-provenance on promoted samples, a rendered diff only becomes meaningful at the **source-flip/cut** slice (where the COA is actually built from the native source). That rendered-COA diff + its retained artifact is deferred there — 1E-a lays the read pipeline it will use.
- Additive, nothing cut (spec locked decision #7; cut order §199-206) → Global Constraints; SENAITE stays authoritative, `coa.addon_results` untouched, no seam severed.
- **Deliberately deferred** (later, separately-gated slices): the source-flip (use Accu-Mk1 for the COA once parity proven); cutting the promote SENAITE write-back (seam 2); the native-sample anchor for sterility-only orders (seam 4) + integration-service order→AR cut (seam 3, "1D"). Endotoxin stays SENAITE (out of scope).

**Placeholder scan:** none — every step ships real code + an exact command. The one environment-dependent detail (exact stack container names, and whether `sample_json` is in scope at `:614` vs `:318`) is called out explicitly with the fallback.

**Type/name consistency:** `STERILITY_KEYWORDS` / `KEYWORD_TITLES` defined once in `accumk1_client.py` and imported by `sterility_shadow.py`; `parse_sterility` row keys (`result`, `status`, `conforms`, `test_name`) used consistently; the endpoint response shape (`{sample_id, sterility_results:[{keyword,result_value,promoted_at}]}`) matches what `AccumkClient.fetch_sterility_results` reads and what `normalize_native_sterility` consumes.

**Open items (non-blocking):** `STER-USP71` result terminology (from 1C) is still a lab-confirm — the diff uses `parse_sterility`'s 0/1 mapping regardless. Because native and SENAITE share write-provenance, a value `MISMATCH` on a both-sources sample is a **plumbing/mapping bug** (not source divergence) — surface it as such. The real cut-gate (rendered-COA diff proving the native source renders identically) is a separate deliverable of the flip/cut slice; do not let a green 1E-a be read as license to cut.

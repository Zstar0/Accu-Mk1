# Customer Remarks (Lab Remarks) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Tech-authored customer-facing remarks on the parent sample, delivered with the published COA (email + order-page button), hard-gated in COABuilder when the COA is non-conforming.

**Architecture:** New `lims_samples.customer_remarks` (Mk1) rides the existing publish rail: generate-coa body → COABuilder `coa_data["lab_remarks"]` → IS `COANotificationPayload` → WP `_accumark_coas[sample_id]["lab_remarks"]` → email templates + order-page modal. Gate lives in COABuilder where conformance is computed.

**Spec:** `docs/superpowers/specs/2026-06-12-customer-remarks-design.md`

**Repos / worktrees:**
| Repo | Path | Branch |
|---|---|---|
| Mk1 | `C:/tmp/Accu-Mk1-subvial` | `subvial/continue` |
| COABuilder | `C:/tmp/coabuilder-variance` | `feat/coa-identity-na-variance` |
| Integration Service | `C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/integration-service` | current (check `git status` first; commit on a feature branch if dirty state allows, else note) |
| wpstar theme | `//wsl.localhost/.../accumarklabs/wp-content/themes/wpstar` | accumarklabs repo |

**Mk1 venv python:** `C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe`. Never run bare `pytest tests/` (broken `test_coa_gate.py`).

**Plan-time facts (verified):**
- `ParentSampleSummary` built at `sub_samples/routes.py:130` and `:166` (+ a not-found default at `:155`); router prefix `/api/sub-samples`.
- Mk1 idempotent migrations: string list in `backend/database.py` (~L326-348 cluster).
- IS payload constructions: `app/services/ingestion.py:491` (primary, already looks up `generation.coa_data`), `app/api/desktop.py:1897` (Mk1 publish, reads `published.coa_data`), `app/api/webhook.py:299` (additional COAs, `child` generation in scope).
- WP: notify entry stored in `handle_primary_coa_notification` (`COAEndpoint.php:316`); `$coa_dl = array_merge($cd, ...)` so new entry keys reach the order-page rows automatically; email templates receive `$order` + `$sample_id` and the meta is saved BEFORE the email triggers, so templates read remarks from order meta (no trigger-signature change). Re-publish uses `WC_Email_COA_Reissued` (`customer-coa-reissued.php`) — needs the same section.
- COABuilder additional COAs build `alt_coa_data_json = _build_coa_data_json(alt_data)` where `alt_data` is a copy of the primary `CoAData` — `lab_remarks` field carries to children automatically.

---

### Task 1: Mk1 — schema + service + routes (TDD)

**Files:**
- Modify: `backend/database.py` (migration list), `backend/models.py` (LimsSample), `backend/sub_samples/schemas.py`, `backend/sub_samples/service.py`, `backend/sub_samples/routes.py`
- Test: `backend/tests/test_customer_remarks.py` (create)

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_customer_remarks.py`:

```python
"""Customer remarks: parent-level customer-facing text delivered with the COA.
set_customer_remarks persists + audit-logs; ParentSampleSummary carries it."""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from database import Base
from models import AuditLog, LimsSample
from sub_samples.service import set_customer_remarks


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def parent(db):
    p = LimsSample(sample_id="P-0700", external_lims_uid="uid-p0700")
    db.add(p)
    db.commit()
    return p


def test_set_and_update(db, parent):
    out = set_customer_remarks(db, "P-0700", "Sample shows minor degradation.", user_id=None)
    assert out["customer_remarks"] == "Sample shows minor degradation."
    db.refresh(parent)
    assert parent.customer_remarks == "Sample shows minor degradation."
    set_customer_remarks(db, "P-0700", "Updated text.", user_id=None)
    db.refresh(parent)
    assert parent.customer_remarks == "Updated text."


def test_clear_with_empty_string(db, parent):
    set_customer_remarks(db, "P-0700", "something", user_id=None)
    set_customer_remarks(db, "P-0700", "", user_id=None)
    db.refresh(parent)
    assert parent.customer_remarks == ""


def test_unknown_sample_raises(db):
    with pytest.raises(LookupError):
        set_customer_remarks(db, "P-9999", "text", user_id=None)


def test_audit_log_written_without_full_text(db, parent):
    set_customer_remarks(db, "P-0700", "Confidential paragraph.", user_id=None)
    row = db.execute(
        select(AuditLog).where(
            AuditLog.operation == "customer_remarks_updated",
            AuditLog.entity_id == "P-0700",
        )
    ).scalars().first()
    assert row is not None
    # Audit details carry lengths, not the text itself
    assert "Confidential" not in str(row.details)
    assert row.details.get("new_length") == len("Confidential paragraph.")
```

- [ ] **Step 2: Run — expect ImportError**

```bash
cd C:/tmp/Accu-Mk1-subvial/backend && C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe -m pytest tests/test_customer_remarks.py -q
```
Expected: ImportError on `set_customer_remarks`.

- [ ] **Step 3: Schema + model**

`backend/database.py` — append to the lims_samples ALTER cluster (after the `variance_locked_by_user_id` line, ~L348):

```python
        "ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS customer_remarks TEXT",
```

`backend/models.py` — in `LimsSample` (after `variance_locked_by_user_id` field area, keep grouping):

```python
    # Customer-facing remarks delivered with the published COA (snapshot at
    # COA generation; re-publish refreshes the customer copy). Distinct from
    # the SENAITE-backed internal Remarks field.
    customer_remarks: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
```

- [ ] **Step 4: Service**

In `backend/sub_samples/service.py` (near `set_assignment_role`), add:

```python
def set_customer_remarks(db: Session, sample_id: str, remarks: str,
                         user_id: Optional[int] = None) -> dict:
    """Set the customer-facing remarks on a parent sample. Audit-logs lengths
    only (the text is customer-facing but the audit trail doesn't need to
    duplicate it). Raises LookupError when the parent has no lims_samples row.

    Spec: docs/superpowers/specs/2026-06-12-customer-remarks-design.md
    """
    from models import AuditLog, LimsSample

    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == sample_id)
    ).scalar_one_or_none()
    if parent is None:
        raise LookupError(f"sample {sample_id} not found")
    old = parent.customer_remarks or ""
    parent.customer_remarks = remarks
    db.add(AuditLog(
        operation="customer_remarks_updated",
        entity_type="lims_sample",
        entity_id=sample_id,
        user_id=user_id,
        details={"old_length": len(old), "new_length": len(remarks)},
    ))
    db.commit()
    return {"sample_id": sample_id, "customer_remarks": remarks}
```

(Check `AuditLog` column names with `grep -n "class AuditLog" -A 15 models.py` — if the user column is named differently (e.g. no `user_id`), drop that kwarg; the test doesn't assert it.)

- [ ] **Step 5: Run service tests**

Same command as Step 2. Expected: 4 passed.

- [ ] **Step 6: Schemas + routes**

`backend/sub_samples/schemas.py`:
- `ParentSampleSummary` add: `customer_remarks: Optional[str] = None`
- New model:

```python
class CustomerRemarksUpdate(BaseModel):
    remarks: str
```

`backend/sub_samples/routes.py`:
- Add `customer_remarks=parent.customer_remarks,` to BOTH `ParentSampleSummary(...)` constructions (ensure endpoint ~L130 and list endpoint ~L166; the not-found default at ~L155 stays None).
- New route (near the ensure endpoint; import `CustomerRemarksUpdate`):

```python
@router.put("/parent/{parent_sample_id}/customer-remarks")
def update_customer_remarks(
    parent_sample_id: str,
    body: CustomerRemarksUpdate,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """Set the parent's customer-facing remarks (delivered with the COA)."""
    try:
        return service.set_customer_remarks(
            db, parent_sample_id, body.remarks, user_id=user.id,
        )
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
```

- [ ] **Step 7: Run full new-feature suite + commit**

```bash
cd C:/tmp/Accu-Mk1-subvial/backend && C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe -m pytest tests/test_customer_remarks.py tests/test_sub_samples_routes.py -q
```
Expected: customer_remarks 4 passed; `test_sub_samples_routes` no NEW failures (handoff documents pre-existing baseline failures — compare counts before blaming).

```bash
cd C:/tmp/Accu-Mk1-subvial && git add backend/database.py backend/models.py backend/sub_samples/schemas.py backend/sub_samples/service.py backend/sub_samples/routes.py backend/tests/test_customer_remarks.py && git commit -m "feat(samples): customer_remarks field on parent samples"
```

---

### Task 2: Mk1 — send lab_remarks in generate-coa + FE section

**Files:**
- Modify: `backend/main.py` (generate-coa variance block), `src/lib/api.ts`, `src/components/senaite/SampleDetails.tsx`

- [ ] **Step 1: generate-coa body**

In `generate_sample_coa`, the variance-replicates block already loads `_parent_row` inside `if not is_sub:`. Extend it (remarks ride the same parent load):

```python
    if not is_sub:
        try:
            from coa.variance_series import build_variance_replicates
            _parent_row = db.execute(
                select(LimsSample).where(LimsSample.sample_id == sample_id)
            ).scalar_one_or_none()
            if _parent_row is not None:
                _reps = build_variance_replicates(db, _parent_row)
                if _reps:
                    alias_body["variance_replicates"] = _reps
                # Customer-facing remarks snapshot — COABuilder embeds them in
                # coa_data and gates non-conforming COAs on their presence.
                if (_parent_row.customer_remarks or "").strip():
                    alias_body["lab_remarks"] = _parent_row.customer_remarks.strip()
        except Exception:
            _logger.warning("variance replicate build failed for %s", sample_id, exc_info=True)
```

Syntax check:
```bash
cd C:/tmp/Accu-Mk1-subvial/backend && C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe -c "import ast; ast.parse(open('main.py',encoding='utf-8').read()); print('ok')"
```

- [ ] **Step 2: FE api.ts**

Add to `ParentSampleSummary` interface (~L4910): `customer_remarks?: string | null`.
Add near the other sub-sample API functions:

```typescript
export async function updateCustomerRemarks(
  parentSampleId: string,
  remarks: string,
): Promise<{ sample_id: string; customer_remarks: string }> {
  return apiFetch(`/api/sub-samples/parent/${encodeURIComponent(parentSampleId)}/customer-remarks`, {
    method: 'PUT',
    body: JSON.stringify({ remarks }),
  })
}
```

(Match the file's existing fetch helper — if it uses a different wrapper than `apiFetch`, mirror the adjacent `ensureParentSampleRow` implementation exactly.)

- [ ] **Step 3: SampleDetails — rename + new card**

(a) `SectionHeader icon={MessageSquare} title="Remarks"` (~L4195) → `title="Internal Remarks"`.

(b) Add a local component (near `AddRemarkForm`):

```tsx
function CustomerRemarksCard({
  sampleId,
  initial,
  onSaved,
}: {
  sampleId: string
  initial: string
  onSaved: () => void
}) {
  const [text, setText] = useState(initial)
  const [saving, setSaving] = useState(false)
  const dirty = text !== initial

  async function handleSave() {
    setSaving(true)
    try {
      await updateCustomerRemarks(sampleId, text.trim())
      toast.success('Customer remarks saved')
      onSaved()
    } catch (err) {
      toast.error('Failed to save customer remarks', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-2">
      <Textarea
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder="Short customer-facing summary delivered with the published COA…"
        className="min-h-24 text-sm"
        aria-label={`Customer remarks for ${sampleId}`}
        disabled={saving}
      />
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-muted-foreground">
          Delivered to the customer with the published COA. Required when the
          COA is non-conforming. Re-publish the COA to refresh the customer copy.
        </p>
        <Button size="sm" onClick={handleSave} disabled={!dirty || saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  )
}
```

(c) Below the Internal Remarks section, add a sibling section (same card/layout wrappers as the Remarks section — copy its container markup):

```tsx
        {/* Customer Remarks — delivered with the published COA */}
        <SectionHeader icon={MessageSquare} title="Customer Remarks" />
        <CustomerRemarksCard
          sampleId={sampleId}
          initial={subSamplesData?.parent?.customer_remarks ?? ''}
          onSaved={() => refetchSubSamples()}
        />
```

Wire `initial`/`onSaved` to however SampleDetails holds the sub-samples list query (it already fetches `/api/sub-samples?parent_sample_id=` — find the query variable and its refetch; use a `key={...customer_remarks}` remount or state-sync if the card needs to reflect refetched values).

- [ ] **Step 4: Typecheck + lint + commit**

```bash
cd C:/tmp/Accu-Mk1-subvial && npm run typecheck && npx eslint src/components/senaite/SampleDetails.tsx src/lib/api.ts
```
Expected: typecheck clean; eslint — SampleDetails+api.ts have a 26-problem pre-existing baseline; no NEW problems.

```bash
cd C:/tmp/Accu-Mk1-subvial && git add backend/main.py src/lib/api.ts src/components/senaite/SampleDetails.tsx && git commit -m "feat(samples): customer remarks UI + lab_remarks in generate-coa body"
```

---

### Task 3: COABuilder — gate + coa_data (TDD)

**Files:**
- Modify: `src/coabuilder_core/conformance.py`, `src/coabuilder_core/data_model.py`, `scripts/server.py`
- Test: `tests/test_lab_remarks_gate.py` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/test_lab_remarks_gate.py`:

```python
"""Lab-remarks gate: a non-conforming COA (any identity/purity row with
conforms=False) requires customer remarks. Helper-level tests — the HTTP 422
wrapping lives in scripts/server.py."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from coabuilder_core.conformance import ConformanceEngine, coa_requires_lab_remarks  # noqa: E402


def _json(identity="BPC-157", purity="98.25"):
    return {
        "ClientSampleID": "CS-1", "id": "P-0700",
        "Analyte1Peptide": "BPC-157 - Identity (HPLC)",
        "_Analyses_Detailed": [
            {"Title": "BPC-157 - Identity (HPLC)", "getKeyword": "ANALYTE-1-ID",
             "Result": identity, "review_state": "verified"},
            {"getKeyword": "ANALYTE-1-PUR", "Result": purity, "review_state": "verified"},
        ],
        "Analyses": [],
    }


class TestLabRemarksGate(unittest.TestCase):
    def test_identity_fail_requires_remarks(self):
        table = ConformanceEngine().process(_json(identity="Out of Spec"))["results_table"]
        self.assertTrue(coa_requires_lab_remarks(table))

    def test_purity_fail_requires_remarks(self):
        table = ConformanceEngine().process(_json(purity="91.0"))["results_table"]
        self.assertTrue(coa_requires_lab_remarks(table))

    def test_conforming_does_not_require(self):
        table = ConformanceEngine().process(_json())["results_table"]
        self.assertFalse(coa_requires_lab_remarks(table))

    def test_works_on_analysis_result_objects(self):
        from coabuilder_core.data_model import AnalysisResult
        rows = [AnalysisResult(test_type="PURITY", conforms=False)]
        self.assertTrue(coa_requires_lab_remarks(rows))
        rows = [AnalysisResult(test_type="QUANTITY", conforms=False)]
        self.assertFalse(coa_requires_lab_remarks(rows))  # quantity is informational


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run — expect ImportError**

```bash
cd C:/tmp/coabuilder-variance && python tests/test_lab_remarks_gate.py
```

- [ ] **Step 3: Implement helper + CoAData field**

`src/coabuilder_core/conformance.py` (after `_identity_summary`):

```python
def coa_requires_lab_remarks(results) -> bool:
    """True when any IDENTITY or PURITY row is non-conforming (conforms is
    False) — the lab's rule: a non-conforming COA must carry customer remarks.
    Quantity is informational and never gates. Accepts results_table dicts or
    AnalysisResult objects."""
    for r in results:
        if isinstance(r, dict):
            tt, cf = r.get("test_type"), r.get("conforms")
        else:
            tt, cf = getattr(r, "test_type", None), getattr(r, "conforms", None)
        if tt in ("IDENTITY", "PURITY") and cf is False:
            return True
    return False
```

`src/coabuilder_core/data_model.py` — `CoAData` gains (next to `results_interpretation`):

```python
    # Customer-facing lab remarks (from Mk1 via /process body). Embedded in
    # coa_data for the digital pipeline; not rendered on the PDF.
    lab_remarks: str = ""
```

- [ ] **Step 4: server.py — body field, gate, coa_data key**

`ProcessSampleRequest` add:
```python
    lab_remarks: Optional[str] = None
```

In `process_sample`, after `variance_replicates = body.variance_replicates if body else None`:
```python
    lab_remarks = (body.lab_remarks or "").strip() if body and body.lab_remarks else ""
```

After `data = client.fetch_sample_data(...)` (and its `if not data: 404` guard):
```python
        # Lab-remarks gate: a non-conforming COA must carry customer remarks
        # (lab rule — the customer gets insight into why). Applies to every
        # generation including re-publish; the field persists on the Mk1
        # sample, so re-publishes only block if the lab cleared it.
        from coabuilder_core.conformance import coa_requires_lab_remarks
        if coa_requires_lab_remarks(data.results) and not lab_remarks:
            raise HTTPException(
                status_code=422,
                detail="Non-conforming COA requires customer remarks. Add Customer Remarks on the sample page in Accu-Mk1 and regenerate.",
            )
        data.lab_remarks = lab_remarks
```

`_build_coa_data_json` — in the returned dict (top level, after the `"client"` block), add:
```python
        "lab_remarks": getattr(data, "lab_remarks", "") or "",
```

- [ ] **Step 5: Run tests + full regression**

```bash
cd C:/tmp/coabuilder-variance && python tests/test_lab_remarks_gate.py && python tests/test_identity_fail_na.py && python tests/test_variance_series_render.py && python tests/test_addon_parsing.py
```
Expected: all OK (4 + 3 + 8 + 5).

- [ ] **Step 6: Version bump 2.16.0 → 2.17.0 + CHANGELOG**

`src/coabuilder_core/__init__.py`: `__version__ = "2.17.0"`.
CHANGELOG prepend:

```markdown
## [2.17.0] - 2026-06-12

### Added

- **Customer lab remarks + non-conforming gate.** `/process` accepts `lab_remarks`
  (tech-authored customer-facing text from Mk1). It is embedded in `coa_data` for
  the digital pipeline (email + order page render it; not on the PDF). When the
  engine finds any non-conforming identity or purity row and no remarks were
  supplied, generation is refused with 422 — the lab's rule that a non-conforming
  COA must explain itself to the customer. Applies to initial generation and
  re-publish alike. Test-first via `tests/test_lab_remarks_gate.py`.

---
```

- [ ] **Step 7: Commit**

```bash
cd C:/tmp/coabuilder-variance && git add src/coabuilder_core/conformance.py src/coabuilder_core/data_model.py scripts/server.py tests/test_lab_remarks_gate.py src/coabuilder_core/__init__.py CHANGELOG.md && git commit -m "feat(coa): lab_remarks in coa_data + non-conforming remarks gate (2.17.0)"
```

---

### Task 4: Integration Service — payload passthrough

**Files:**
- Modify: `app/adapters/wordpress.py`, `app/services/ingestion.py` (~L455-500), `app/api/desktop.py` (~L1885-1910), `app/api/webhook.py` (~L290-315)
- Test: `tests/test_lab_remarks_payload.py` (create; if the suite's conftest demands a live DB for collection, fall back to `python -c` verification and note it)

- [ ] **Step 0: Check repo state**

```bash
cd C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/integration-service && git status --short | head && git branch --show-current
```
If the working tree has unrelated changes, create a branch `feat/coa-lab-remarks` from the current HEAD and keep edits scoped to the four files.

- [ ] **Step 1: Payload field + to_dict**

`app/adapters/wordpress.py` — `COANotificationPayload` add (after `client_name`):

```python
    # Customer-facing lab remarks from coa_data (rendered in the COA email
    # and the order-page Lab Remarks button)
    lab_remarks: str | None = None
```

In `to_dict()`, after the `client_name` block:

```python
        if self.lab_remarks:
            payload["lab_remarks"] = self.lab_remarks
```

- [ ] **Step 2: Ingestion (primary) path**

`app/services/ingestion.py` — the block before `wp_payload = COANotificationPayload(` already looks up `generation` + `coa_data` for `client_sample_id`. Initialize `lab_remarks = None` next to `client_sample_id`'s init, and inside the same `if generation and generation.coa_data ... isinstance(coa_data, dict)` body add:

```python
                        lab_remarks = coa_data.get("lab_remarks") or None
```

NOTE: that lookup currently runs only when needed for client_sample_id — read the surrounding `if`/`try` and make sure the generation lookup executes unconditionally enough to populate lab_remarks (hoist the lookup out of any client_sample_id-specific condition if necessary, preserving its error handling). Then add to the constructor:

```python
            lab_remarks=lab_remarks,
```

- [ ] **Step 3: Desktop publish path**

`app/api/desktop.py` (~L1890) — alongside the existing coa_data reads:

```python
            lab_remarks = None
            if published.coa_data and isinstance(published.coa_data, dict):
                client_sample_id = published.coa_data.get("sample", {}).get("name")
                client_info = published.coa_data.get("client", {})
                client_logo_url = client_info.get("logo_url") or None
                client_name = client_info.get("name") or None
                lab_remarks = published.coa_data.get("lab_remarks") or None
```

and `lab_remarks=lab_remarks,` in the `COANotificationPayload(` call.

- [ ] **Step 4: Additional-COA path**

`app/api/webhook.py` (~L299) — children carry their own coa_data (copied from the primary CoAData):

```python
                lab_remarks=(child.coa_data or {}).get("lab_remarks") or None if isinstance(child.coa_data, dict) else None,
```

(Write it as a small local variable above the constructor for readability:)

```python
            child_remarks = None
            if isinstance(child.coa_data, dict):
                child_remarks = child.coa_data.get("lab_remarks") or None
```
then `lab_remarks=child_remarks,`.

- [ ] **Step 5: Test**

Create `tests/test_lab_remarks_payload.py`:

```python
"""COANotificationPayload.lab_remarks serialization."""
from app.adapters.wordpress import COANotificationPayload


def test_lab_remarks_in_to_dict_when_set():
    p = COANotificationPayload(
        sample_id="P-0700", coa_version=1, s3_key="k",
        verification_code="AAAA-BBBB", lab_remarks="Customer-facing text.",
    )
    d = p.to_dict()
    assert d["lab_remarks"] == "Customer-facing text."


def test_lab_remarks_absent_when_unset():
    p = COANotificationPayload(sample_id="P-0700", coa_version=1, s3_key="k")
    assert "lab_remarks" not in p.to_dict()
```

Run:
```bash
cd C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/integration-service && python -m pytest tests/test_lab_remarks_payload.py -q
```
Expected: 2 passed (IS has its own venv? — check for `.venv/`; use it if present, else system python; if conftest demands env vars, run with the documented test env from the repo's README/conftest).

- [ ] **Step 6: Commit**

```bash
cd C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/integration-service && git add app/adapters/wordpress.py app/services/ingestion.py app/api/desktop.py app/api/webhook.py tests/test_lab_remarks_payload.py && git commit -m "feat(coa): lab_remarks passthrough on COA notify payload"
```

---

### Task 5: WordPress — store, email sections, order-page button

**Files (live theme tree, accumarklabs repo):**
- Modify: `src/Api/COAEndpoint.php`, `woocommerce/emails/customer-coa-published.php`, `woocommerce/emails/customer-coa-reissued.php`, `woocommerce/emails/plain/customer-coa-published.php`, `woocommerce/emails/plain/customer-coa-reissued.php`, `templates/portal-view-order.php`

- [ ] **Step 1: COAEndpoint — extract + store**

In the `/coa/notify` REST callback, find where `client_name` is extracted from the request and mirror it: `$lab_remarks = sanitize_textarea_field($request->get_param('lab_remarks') ?? '');` then thread it to `handle_primary_coa_notification(..., string $lab_remarks = '')` and add to the stored entry:

```php
        $existing_coas[$sample_id] = [
            'version' => $coa_version,
            's3_key' => $s3_key,
            'verification_code' => $verification_code,
            'sha256' => $sha256,
            'created_at' => $created_at,
            'updated_at' => current_time('c'),
            'sample_name' => $sample_name,
            'lab_remarks' => $lab_remarks,
        ];
```

(Additional-COA handler: also store `'lab_remarks' => $lab_remarks` in its entry if the same param threading is cheap — the order-page button is primary-only, but storing costs nothing. Optional.)

- [ ] **Step 2: Email templates (HTML ×2)**

In `customer-coa-published.php` AND `customer-coa-reissued.php`, after the sample-info card block, add:

```php
    <?php
    // Customer-facing lab remarks — stored on the order by the COA notify
    // (saved before this email triggers).
    $_remarks_coas = $order->get_meta('_accumark_coas') ?: [];
    $lab_remarks = trim((string) ($_remarks_coas[$sample_id]['lab_remarks'] ?? ''));
    ?>
    <?php if ($lab_remarks) : ?>
    <div style="background: #fffdf5; border: 1px solid #f0e6c8; border-radius: 12px; padding: 20px 24px; margin: 0 0 24px;">
        <p style="color: #8a7a3a; margin: 0 0 8px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px;">
            <?php esc_html_e('Remarks from the Lab', 'wpstar'); ?>
        </p>
        <p style="color: #444; margin: 0; font-size: 14px; line-height: 1.6;">
            <?php echo nl2br(esc_html($lab_remarks)); ?>
        </p>
    </div>
    <?php endif; ?>
```

- [ ] **Step 3: Plain templates (×2)**

In both `plain/` templates, after the sample/verification lines:

```php
<?php
$_remarks_coas = $order->get_meta('_accumark_coas') ?: [];
$lab_remarks = trim((string) ($_remarks_coas[$sample_id]['lab_remarks'] ?? ''));
if ($lab_remarks) {
    echo "\n" . esc_html__('REMARKS FROM THE LAB', 'wpstar') . "\n";
    echo esc_html($lab_remarks) . "\n";
}
?>
```

- [ ] **Step 4: Order page — Lab Remarks button + dialog**

`templates/portal-view-order.php` — in BOTH COA row loops (~L584 and the second table ~L1116 area; grep `foreach ($all_dl_coas as $coa_dl)` to find each), inside the row's actions area (after the download cell), add:

```php
                                                <?php
                                                $dl_remarks = trim((string) ($coa_dl['lab_remarks'] ?? ''));
                                                if (!$dl_is_additional && $dl_remarks): ?>
                                                <div class="coa-popup-cell">
                                                    <button type="button" class="coa-remarks-btn"
                                                            onclick="this.nextElementSibling.showModal()">
                                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                                                        <?php esc_html_e('Lab Remarks', 'wpstar'); ?>
                                                    </button>
                                                    <dialog class="coa-remarks-dialog">
                                                        <h4><?php echo esc_html(sprintf(__('Remarks from the Lab — %s', 'wpstar'), $dl_label)); ?></h4>
                                                        <p><?php echo nl2br(esc_html($dl_remarks)); ?></p>
                                                        <form method="dialog"><button class="coa-remarks-close"><?php esc_html_e('Close', 'wpstar'); ?></button></form>
                                                    </dialog>
                                                </div>
                                                <?php endif; ?>
```

Add styles to the page's stylesheet (`css/accuverify.css` is the verify page — find the portal css; grep `coa-popup-cell` for which file styles these rows, add alongside):

```css
.coa-remarks-btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 8px 14px; border-radius: 8px; border: 1px solid var(--portal-color-border, #e2e8f0);
    background: #fff; color: var(--portal-color-text, #334155);
    font-size: 13px; font-weight: 600; cursor: pointer;
}
.coa-remarks-btn:hover { border-color: #2ABFC4; color: #2ABFC4; }
.coa-remarks-dialog {
    max-width: 480px; border: none; border-radius: 12px; padding: 24px;
    box-shadow: 0 20px 50px rgba(0,0,0,0.25);
}
.coa-remarks-dialog::backdrop { background: rgba(15, 23, 42, 0.5); }
.coa-remarks-dialog h4 { margin: 0 0 12px; font-size: 15px; }
.coa-remarks-dialog p { margin: 0 0 16px; font-size: 14px; line-height: 1.6; color: #475569; }
.coa-remarks-close {
    padding: 8px 20px; border-radius: 8px; border: none;
    background: #2ABFC4; color: #fff; font-weight: 600; cursor: pointer;
}
```

- [ ] **Step 5: Verify + commit (accumarklabs repo)**

```bash
grep -c "lab_remarks" <theme>/src/Api/COAEndpoint.php          # >= 3 (param, thread, store)
grep -c "Remarks from the Lab" <theme>/woocommerce/emails/customer-coa-published.php  # 1
grep -c "coa-remarks-dialog" <theme>/templates/portal-view-order.php                  # >= 2 (two row loops)
```

Commit in the accumarklabs repo:
`feat(coa): lab remarks — store from notify, email section, order-page modal`

---

### Task 6: Verification + UAT handoff

- [ ] **Step 1: Cross-stack smoke on the subvial stack** — backend reloaded (`docker logs accumark-subvial-accu-mk1-backend --since 2m | grep Reloading`); set remarks on a parent via the new endpoint (curl with stack login token), confirm `lims_samples.customer_remarks` populated (psql).
- [ ] **Step 2: UAT script for the Handler:**
  1. Sample page (hard-refresh): "Internal Remarks" header + new "Customer Remarks" card; type a paragraph → Save → reload sticks.
  2. Non-conforming sample with EMPTY customer remarks → Generate COA → error toast "Non-conforming COA requires customer remarks…". Fill remarks → generates.
  3. Conforming sample with empty remarks → generates (no gate).
  4. Publish → COA email shows "Remarks from the Lab" section (MailHog :5522); order page COA row shows "Lab Remarks" button → modal with the text. No button when remarks empty.
  5. Note: stack COABuilder/IS containers run pinned images — full E2E needs the rebuilt images or local services; the per-repo tests cover the seams (documented limitation).

---

## Self-review

- Spec coverage: schema/UI/rename (T1, T2), generate-coa body (T2), gate + coa_data (T3), IS passthrough all 3 sites incl. additional-COA fallback question — resolved: children copy the primary CoAData so their coa_data has lab_remarks natively (T4), WP store/email×4/button+modal (T5), pathway doc for Variance Report — in spec, no task needed.
- Types: `set_customer_remarks(db, sample_id, remarks, user_id) -> dict`; `CustomerRemarksUpdate.remarks`; `coa_requires_lab_remarks(results) -> bool`; payload `lab_remarks: str | None`. Consistent.
- Known judgment points called out inline (AuditLog kwargs, ingestion lookup hoisting, FE fetch-wrapper name) with exact verification commands rather than guesses.

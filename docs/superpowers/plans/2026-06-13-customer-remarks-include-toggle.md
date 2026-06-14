# Customer Remarks "Include with Publish?" Toggle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit "Include with Publish?" checkbox to the Customer Remarks section (default on) that gates whether remarks are delivered with a published COA, plus a Mk1-side "Delivered on <date/time>" timestamp stamped at successful COA generation.

**Architecture:** Two new `lims_samples` columns (`customer_remarks_include`, `customer_remarks_delivered_at`). Mk1 generate-COA sends `lab_remarks` only when included and always sends `include_lab_remarks` so COABuilder can skip its non-conforming gate on intentional suppression. COABuilder gains an `include_lab_remarks` body field routed through a pure gate helper. FE adds a checkbox + a delivered-on line.

**Tech Stack:** FastAPI + SQLAlchemy (Mk1 backend, `C:/tmp/accu-mk1-wave1`), FastAPI (COABuilder, `C:/tmp/coabuilder-variance`, branch `feat/coa-identity-na-variance`), React + Vitest (Mk1 frontend). Spec: `docs/superpowers/specs/2026-06-13-customer-remarks-include-toggle-design.md`.

---

## File Structure

| File | Repo | Responsibility |
|---|---|---|
| `backend/models.py` | Mk1 | `LimsSample` gains two columns |
| `backend/database.py` | Mk1 | Idempotent ALTERs for the two columns |
| `backend/sub_samples/schemas.py` | Mk1 | `CustomerRemarksUpdate.include`; `ParentSampleSummary` new fields |
| `backend/sub_samples/service.py` | Mk1 | `set_customer_remarks(..., include=)` persists the flag |
| `backend/sub_samples/routes.py` | Mk1 | Pass `include` through; expose new fields |
| `backend/main.py` | Mk1 | generate-COA: gate the send on include; stamp `delivered_at` |
| `backend/tests/test_customer_remarks.py` | Mk1 | Service include-flag tests |
| `src/coabuilder_core/conformance.py` | COABuilder | Pure gate helper `lab_remarks_gate_blocks` |
| `scripts/server.py` | COABuilder | `include_lab_remarks` field + call helper |
| `src/coabuilder_core/__init__.py` + `CHANGELOG.md` | COABuilder | Version bump 2.19.0 |
| `tests/test_lab_remarks_gate.py` | COABuilder | Gate-skip tests |
| `src/lib/api.ts` | Mk1 FE | `updateCustomerRemarks(id, remarks, include)` |
| `src/components/senaite/SampleDetails.tsx` | Mk1 FE | Checkbox + delivered-on line |

---

## Task 1: Mk1 schema — model columns + idempotent migration

**Files:**
- Modify: `C:/tmp/accu-mk1-wave1/backend/models.py:760`
- Modify: `C:/tmp/accu-mk1-wave1/backend/database.py:351`

- [ ] **Step 1: Add the two model columns**

In `backend/models.py`, the `customer_remarks` column on `LimsSample` is at line 760. Insert immediately after it:

```python
    customer_remarks: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # "Include with Publish?" — when False the remark is authored/saved but NOT
    # delivered with the COA (Mk1 omits lab_remarks + sends include_lab_remarks
    # false so COABuilder skips its non-conforming gate). Default TRUE preserves
    # the prior always-deliver-when-non-empty behavior.
    customer_remarks_include: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default="true", default=True
    )
    # Set to utcnow() when a COA is successfully generated with remarks INCLUDED
    # (the snapshot/delivery moment Mk1 can observe). Surfaced as "Delivered on".
    customer_remarks_delivered_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime, nullable=True
    )
```

(`Boolean`, `DateTime`, `Text`, `Optional`, `datetime` are already imported — see `models.py:9` and existing `in_variance_set` at line 748 for the same Boolean pattern.)

- [ ] **Step 2: Add idempotent ALTERs**

In `backend/database.py`, find the existing customer_remarks ALTER (line 351):

```python
        "ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS customer_remarks TEXT",
```

Insert immediately after it:

```python
        # "Include with Publish?" toggle + Mk1-side delivery timestamp
        # (2026-06-13-customer-remarks-include-toggle-design.md)
        "ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS customer_remarks_include BOOLEAN NOT NULL DEFAULT TRUE",
        "ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS customer_remarks_delivered_at TIMESTAMP",
```

- [ ] **Step 3: Verify the model imports cleanly**

Run: `MSYS_NO_PATHCONV=1 docker exec accu-mk1-backend sh -c "cd /app && python -c 'import models; print(models.LimsSample.customer_remarks_include, models.LimsSample.customer_remarks_delivered_at)'"`
Expected: prints the two column attributes without an ImportError/AttributeError.

- [ ] **Step 4: Commit**

```bash
cd /c/tmp/accu-mk1-wave1
git add backend/models.py backend/database.py
git commit -m "feat(lims): add customer_remarks_include + customer_remarks_delivered_at columns

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Mk1 service/API — persist + expose the include flag (TDD)

**Files:**
- Test: `C:/tmp/accu-mk1-wave1/backend/tests/test_customer_remarks.py`
- Modify: `C:/tmp/accu-mk1-wave1/backend/sub_samples/service.py:1114-1142`
- Modify: `C:/tmp/accu-mk1-wave1/backend/sub_samples/schemas.py:45-57`
- Modify: `C:/tmp/accu-mk1-wave1/backend/sub_samples/routes.py:173,178-190,227`

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_customer_remarks.py`:

```python
def test_include_defaults_true(db, parent):
    set_customer_remarks(db, "P-0700", "Visible to customer.", user_id=None)
    db.refresh(parent)
    assert parent.customer_remarks_include is True


def test_include_false_persists(db, parent):
    out = set_customer_remarks(db, "P-0700", "Internal only.", include=False, user_id=None)
    assert out["customer_remarks_include"] is False
    db.refresh(parent)
    assert parent.customer_remarks_include is False


def test_include_flag_in_audit_details(db, parent):
    set_customer_remarks(db, "P-0700", "text", include=False, user_id=None)
    row = db.execute(
        select(AuditLog).where(
            AuditLog.operation == "customer_remarks_updated",
            AuditLog.entity_id == "P-0700",
        )
    ).scalars().first()
    assert row.details.get("include") is False
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `MSYS_NO_PATHCONV=1 docker exec accu-mk1-backend sh -c "cd /app && python -m pytest tests/test_customer_remarks.py -k 'include' -v"`
Expected: FAIL — `TypeError: set_customer_remarks() got an unexpected keyword argument 'include'`.

- [ ] **Step 3: Update the service**

In `backend/sub_samples/service.py`, change the `set_customer_remarks` signature and body (currently lines 1114-1142):

```python
def set_customer_remarks(db: Session, sample_id: str, remarks: str,
                         include: bool = True,
                         user_id: Optional[int] = None) -> dict:
    """Set the customer-facing remarks on a parent sample and whether they are
    delivered with the COA ("Include with Publish?"). Audit-logs lengths +
    the include flag (not the text). Raises LookupError when the parent has no
    lims_samples row. Does NOT touch customer_remarks_delivered_at (that is
    stamped at COA generation).

    Spec: docs/superpowers/specs/2026-06-13-customer-remarks-include-toggle-design.md
    """
    from models import AuditLog

    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == sample_id)
    ).scalar_one_or_none()
    if parent is None:
        raise LookupError(f"sample {sample_id} not found")
    old = parent.customer_remarks or ""
    parent.customer_remarks = remarks
    parent.customer_remarks_include = include
    db.add(AuditLog(
        operation="customer_remarks_updated",
        entity_type="lims_sample",
        entity_id=sample_id,
        details={
            "old_length": len(old),
            "new_length": len(remarks),
            "include": include,
            "user_id": user_id,
        },
    ))
    db.commit()
    return {
        "sample_id": sample_id,
        "customer_remarks": remarks,
        "customer_remarks_include": include,
    }
```

- [ ] **Step 4: Update the Pydantic schemas**

In `backend/sub_samples/schemas.py`, `ParentSampleSummary` — after the `customer_remarks` field (line 50) add:

```python
    customer_remarks: Optional[str] = None
    # "Include with Publish?" + the Mk1-side delivery timestamp.
    customer_remarks_include: bool = True
    customer_remarks_delivered_at: Optional[datetime] = None
```

And extend `CustomerRemarksUpdate` (line 56-57):

```python
class CustomerRemarksUpdate(BaseModel):
    remarks: str
    include: bool = True
```

- [ ] **Step 5: Thread `include` + new fields through the routes**

In `backend/sub_samples/routes.py`:

`update_customer_remarks` (lines 185-188) — pass `include`:

```python
        return service.set_customer_remarks(
            db, parent_sample_id, body.remarks, include=body.include,
            user_id=user.id,
        )
```

In BOTH `ParentSampleSummary(...)` constructions that already pass `customer_remarks=parent.customer_remarks` (lines ~173 and ~227), add the two new fields right after that line:

```python
        customer_remarks=parent.customer_remarks,
        customer_remarks_include=parent.customer_remarks_include,
        customer_remarks_delivered_at=parent.customer_remarks_delivered_at,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `MSYS_NO_PATHCONV=1 docker exec accu-mk1-backend sh -c "cd /app && python -m pytest tests/test_customer_remarks.py -v"`
Expected: PASS (all existing + 3 new tests).

- [ ] **Step 7: Commit**

```bash
cd /c/tmp/accu-mk1-wave1
git add backend/sub_samples/service.py backend/sub_samples/schemas.py backend/sub_samples/routes.py backend/tests/test_customer_remarks.py
git commit -m "feat(remarks): persist + expose customer_remarks_include flag

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Mk1 generate-COA — gate the send + stamp delivered_at

**Files:**
- Modify: `C:/tmp/accu-mk1-wave1/backend/main.py:9159-9174` (body assembly) and the success block `~9253-9288`

- [ ] **Step 1: Restructure the parent-row block — set the include flag OUTSIDE the variance try**

In `backend/main.py`, replace the whole block (currently lines 9159-9174):

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

with (note: remarks/include set OUTSIDE the variance try so a variance-build
failure can't drop `include_lab_remarks` and silently re-enable the gate):

```python
    # Tracks whether this generation delivered customer remarks — drives the
    # "Delivered on" timestamp stamped after a successful generation.
    _remarks_included = False
    if not is_sub:
        _parent_row = db.execute(
            select(LimsSample).where(LimsSample.sample_id == sample_id)
        ).scalar_one_or_none()
        if _parent_row is not None:
            # Customer-remarks snapshot + "Include with Publish?" gating. When
            # the flag is False we omit lab_remarks and tell COABuilder the
            # suppression was intentional so its non-conforming gate is skipped.
            # include_lab_remarks is ALWAYS sent. Set OUTSIDE the variance try
            # below so a variance-build error can't drop it.
            _include_remarks = bool(_parent_row.customer_remarks_include)
            alias_body["include_lab_remarks"] = _include_remarks
            _remarks_text = (_parent_row.customer_remarks or "").strip()
            if _include_remarks and _remarks_text:
                alias_body["lab_remarks"] = _remarks_text
                _remarks_included = True
            # Variance replicate series — best-effort; a builder error must not
            # block generation.
            try:
                from coa.variance_series import build_variance_replicates
                _reps = build_variance_replicates(db, _parent_row)
                if _reps:
                    alias_body["variance_replicates"] = _reps
            except Exception:
                _logger.warning("variance replicate build failed for %s", sample_id, exc_info=True)
```

- [ ] **Step 2: Stamp delivered_at after a successful generation**

In the success path, the manifest-write block begins at line 9260 with `if (resolver_result is not None and verification_code and generation_number:`. Immediately BEFORE that `if` (after line 9251 `message += ...`), insert:

```python
    # "Delivered on" — stamp the parent when this generation actually carried
    # customer remarks. Best-effort; a failure here must not fail the
    # already-successful generation. Re-query (the earlier _parent_row is scoped
    # to the not-is_sub block and may be stale).
    if _remarks_included and verification_code:
        try:
            from datetime import datetime as _dt
            _p = db.execute(
                select(LimsSample).where(LimsSample.sample_id == sample_id)
            ).scalar_one_or_none()
            if _p is not None:
                _p.customer_remarks_delivered_at = _dt.utcnow()
                db.commit()
        except Exception:
            db.rollback()
            _logger.warning("delivered_at stamp failed for %s", sample_id, exc_info=True)
```

- [ ] **Step 3: Restart backend and verify it boots**

Run: `docker restart accu-mk1-backend && sleep 5 && docker logs --tail 8 accu-mk1-backend`
Expected: "Application startup complete." with no traceback. (Backend has no --reload — restart is required.)

- [ ] **Step 4: Commit**

```bash
cd /c/tmp/accu-mk1-wave1
git add backend/main.py
git commit -m "feat(coa): gate customer-remarks delivery on include flag; stamp delivered_at

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: COABuilder — include-aware gate (TDD)

**Files:**
- Test: `C:/tmp/coabuilder-variance/tests/test_lab_remarks_gate.py`
- Modify: `C:/tmp/coabuilder-variance/src/coabuilder_core/conformance.py` (after `coa_requires_lab_remarks`)
- Modify: `C:/tmp/coabuilder-variance/scripts/server.py:512-516,593-598`
- Modify: `C:/tmp/coabuilder-variance/src/coabuilder_core/__init__.py:1` + `CHANGELOG.md`

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_lab_remarks_gate.py`:

```python
class TestLabRemarksGateInclude(unittest.TestCase):
    def _nonconforming(self):
        return [{"test_type": "PURITY", "conforms": False}]

    def test_blocks_when_included_and_empty(self):
        from coabuilder_core.conformance import lab_remarks_gate_blocks
        self.assertTrue(lab_remarks_gate_blocks(self._nonconforming(), "", include_remarks=True))

    def test_passes_when_excluded_even_if_empty(self):
        from coabuilder_core.conformance import lab_remarks_gate_blocks
        # Intentional suppression — non-conforming + no remarks must NOT block.
        self.assertFalse(lab_remarks_gate_blocks(self._nonconforming(), "", include_remarks=False))

    def test_passes_when_included_with_remarks(self):
        from coabuilder_core.conformance import lab_remarks_gate_blocks
        self.assertFalse(lab_remarks_gate_blocks(self._nonconforming(), "see note", include_remarks=True))

    def test_default_include_true_blocks(self):
        from coabuilder_core.conformance import lab_remarks_gate_blocks
        # Absent flag ⇒ defaults to included ⇒ back-compat gate behavior.
        self.assertTrue(lab_remarks_gate_blocks(self._nonconforming(), ""))

    def test_conforming_never_blocks(self):
        from coabuilder_core.conformance import lab_remarks_gate_blocks
        self.assertFalse(lab_remarks_gate_blocks([{"test_type": "PURITY", "conforms": True}], "", include_remarks=True))
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /c/tmp/coabuilder-variance && python -m pytest tests/test_lab_remarks_gate.py -k Include -v`
Expected: FAIL — `ImportError: cannot import name 'lab_remarks_gate_blocks'`.

- [ ] **Step 3: Add the pure helper**

In `src/coabuilder_core/conformance.py`, immediately after the `coa_requires_lab_remarks` function, add:

```python
def lab_remarks_gate_blocks(results, lab_remarks, include_remarks: bool = True) -> bool:
    """True when generation must 422 for missing customer remarks.

    The non-conforming-COA rule only applies when the lab intends to deliver
    remarks. When include_remarks is False (Mk1's "Include with Publish?"
    unchecked), suppression is intentional and the gate is skipped. Absent flag
    defaults to True for back-compat with any caller that doesn't send it.
    """
    if not include_remarks:
        return False
    return coa_requires_lab_remarks(results) and not (lab_remarks or "").strip()
```

- [ ] **Step 4: Wire it into the server + add the body field**

In `scripts/server.py`, add to `ProcessSampleRequest` (after `lab_remarks` at line 516):

```python
    lab_remarks: Optional[str] = None
    # "Include with Publish?" from Mk1. False ⇒ remarks intentionally suppressed;
    # the non-conforming gate is skipped. Absent ⇒ True (back-compat).
    include_lab_remarks: Optional[bool] = None
```

Replace the gate block (lines 593-598):

```python
        from coabuilder_core.conformance import coa_requires_lab_remarks
        if coa_requires_lab_remarks(data.results) and not lab_remarks:
            raise HTTPException(
                status_code=422,
                detail="Non-conforming COA requires customer remarks. Add Customer Remarks on the sample page in Accu-Mk1 and regenerate.",
            )
        data.lab_remarks = lab_remarks
```

with:

```python
        from coabuilder_core.conformance import lab_remarks_gate_blocks
        include_remarks = body.include_lab_remarks if (body and body.include_lab_remarks is not None) else True
        if lab_remarks_gate_blocks(data.results, lab_remarks, include_remarks):
            raise HTTPException(
                status_code=422,
                detail="Non-conforming COA requires customer remarks. Add Customer Remarks on the sample page in Accu-Mk1 and regenerate.",
            )
        data.lab_remarks = lab_remarks
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /c/tmp/coabuilder-variance && python -m pytest tests/test_lab_remarks_gate.py -v`
Expected: PASS (existing + 5 new tests).

- [ ] **Step 6: Version bump + CHANGELOG**

In `src/coabuilder_core/__init__.py` line 1: `__version__ = "2.19.0"`.

Prepend under the title in `CHANGELOG.md` (above the `## [2.18.0]` block):

```markdown
## [2.19.0] - 2026-06-13

### Changed

- **Lab-remarks gate honors Mk1's "Include with Publish?" flag.** `/process`
  accepts `include_lab_remarks`; when False the non-conforming-COA remarks gate
  is skipped (intentional suppression). Absent ⇒ True (back-compat). Gate logic
  factored into pure helper `lab_remarks_gate_blocks`. Test:
  `tests/test_lab_remarks_gate.py`.

---
```

- [ ] **Step 7: Commit**

```bash
cd /c/tmp/coabuilder-variance
git add src/coabuilder_core/conformance.py scripts/server.py src/coabuilder_core/__init__.py CHANGELOG.md tests/test_lab_remarks_gate.py
git commit -m "feat(gate): honor include_lab_remarks; skip non-conforming gate on suppression (2.19.0)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Mk1 FE — checkbox + delivered-on line

**Files:**
- Modify: `C:/tmp/accu-mk1-wave1/src/lib/api.ts:5087-5102`
- Modify: `C:/tmp/accu-mk1-wave1/src/components/senaite/SampleDetails.tsx:1940-1989,4350-4362`

- [ ] **Step 1: Extend the API client**

In `src/lib/api.ts`, replace `updateCustomerRemarks` (lines 5087-5102):

```typescript
/** Set the parent's customer-facing remarks + whether they're delivered with the COA. */
export async function updateCustomerRemarks(
  parentSampleId: string,
  remarks: string,
  include: boolean,
): Promise<{ sample_id: string; customer_remarks: string; customer_remarks_include: boolean }> {
  const response = await fetch(
    `${API_BASE_URL()}/api/sub-samples/parent/${encodeURIComponent(parentSampleId)}/customer-remarks`,
    {
      method: 'PUT',
      headers: { ...getBearerHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ remarks, include }),
    }
  )
  if (!response.ok) throw new Error(`updateCustomerRemarks failed: ${response.status}`)
  return response.json()
}
```

- [ ] **Step 2: Import the Checkbox primitive**

In `src/components/senaite/SampleDetails.tsx`, after the Textarea import (line 127) add:

```typescript
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
```

- [ ] **Step 3: Update CustomerRemarksCard (checkbox + delivered-on)**

Replace the whole `CustomerRemarksCard` component (lines 1940-1989) with:

```typescript
function CustomerRemarksCard({
  sampleId,
  initial,
  initialInclude,
  deliveredAt,
  onSaved,
}: {
  sampleId: string
  initial: string
  initialInclude: boolean
  deliveredAt: string | null
  onSaved: () => void
}) {
  const [text, setText] = useState(initial)
  const [include, setInclude] = useState(initialInclude)
  const [saving, setSaving] = useState(false)
  const dirty = text !== initial || include !== initialInclude

  async function handleSave() {
    setSaving(true)
    try {
      await updateCustomerRemarks(sampleId, text.trim(), include)
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
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={include}
          onCheckedChange={v => setInclude(v === true)}
          disabled={saving}
          aria-label="Include with publish"
        />
        Include with Publish?
      </label>
      {deliveredAt && (
        <p className="text-[11px] text-muted-foreground">
          Delivered on {formatDate(deliveredAt)}
        </p>
      )}
      <div className="flex items-center justify-between gap-4">
        <p className="text-[11px] text-muted-foreground">
          Delivered to the customer with the published COA when included. Required
          when the COA is non-conforming (unless suppressed). Re-publish the COA to
          refresh the customer copy.
        </p>
        <Button size="sm" onClick={handleSave} disabled={!dirty || saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Pass the new props at the call site**

In `src/components/senaite/SampleDetails.tsx`, the `<CustomerRemarksCard ... />` call (lines 4354-4359) — add the two props:

```tsx
              <CustomerRemarksCard
                key={data.sample_id}
                sampleId={data.sample_id}
                initial={subData?.parent?.customer_remarks ?? ''}
                initialInclude={subData?.parent?.customer_remarks_include ?? true}
                deliveredAt={subData?.parent?.customer_remarks_delivered_at ?? null}
                onSaved={() => refetchSubs()}
              />
```

- [ ] **Step 5: Restart frontend + typecheck**

Run: `docker restart accu-mk1-frontend && sleep 3 && MSYS_NO_PATHCONV=1 docker exec accu-mk1-frontend sh -c "cd /app && npx tsc --noEmit"`
Expected: no type errors. (Vite serves stale transforms across the bind mount — the restart is required.)

- [ ] **Step 6: Confirm the new code is served**

Run: `curl -s "http://localhost:3101/src/lib/api.ts" | grep -c "remarks, include"`
Expected: `1` (the new PUT body is being served).

- [ ] **Step 7: Commit**

```bash
cd /c/tmp/accu-mk1-wave1
git add src/lib/api.ts src/components/senaite/SampleDetails.tsx
git commit -m "feat(ui): Include-with-Publish checkbox + Delivered-on line in Customer Remarks

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Full verification + live UAT

**Files:** none (verification only)

- [ ] **Step 1: Mk1 backend — Replace/remove + remarks suites**

Run: `MSYS_NO_PATHCONV=1 docker exec accu-mk1-backend sh -c "cd /app && python -m pytest tests/test_customer_remarks.py tests/test_replace_analyte.py tests/test_removal_impact.py tests/test_native_manage_analyses.py -q 2>&1 | tail -5"`
Expected: all pass.

- [ ] **Step 2: COABuilder gate suite**

Run: `cd /c/tmp/coabuilder-variance && python -m pytest tests/test_lab_remarks_gate.py tests/test_variance_report.py -q 2>&1 | tail -5`
Expected: all pass.

- [ ] **Step 3: FE typecheck**

Run: `MSYS_NO_PATHCONV=1 docker exec accu-mk1-frontend sh -c "cd /app && npx tsc --noEmit"`
Expected: no errors.

- [ ] **Step 4: Deploy 2.19.0 COABuilder to what wave1 hits — HANDLER-GATED**

> ⚠️ **Environmental gap (must resolve before Step 5.3).** wave1's backend calls
> `COA_BUILDER_URL=http://host.docker.internal:5000` → container `coabuilder_service`,
> which runs a **baked image (`coabuilder-coabuilder`) at 2.18.0** — NOT the
> bind-mounted branch checkout. My edits to `/c/tmp/coabuilder-variance` go live on
> `:5528` (`accumark-subvial-coabuilder`, bind-mounted) after a restart, but wave1
> does not hit that container.
>
> **What still works WITHOUT this deploy:** Pydantic v2 ignores unknown body fields,
> so the current 2.18.0 coabuilder silently ignores `include_lab_remarks`.
> Suppression on **conforming** COAs already works (Mk1 omits `lab_remarks` →
> coabuilder embeds nothing). Only the **non-conforming suppression bypass** (UAT
> 5.3) needs 2.19.0 live.
>
> **Options (Handler picks):**
> - **A — rebuild + recreate `coabuilder_service`:** `docker compose -p coabuilder build && docker compose -p coabuilder up -d` from the build context, after pointing it at `/c/tmp/coabuilder-variance` (the compose project's working_dir is the OneDrive `coabuilder` dir, currently stale at 2.14.8 — do NOT rebuild from there or it regresses). Keeps wave1's URL unchanged.
> - **B — repoint wave1 backend to `:5528`:** recreate `accu-mk1-backend` with `COA_BUILDER_URL=http://host.docker.internal:5528` and `docker restart accumark-subvial-coabuilder`. No image rebuild; couples wave1 to the subvial container (revert after UAT).
>
> Confirm `curl -s http://localhost:5000/version` returns `2.19.0` (option A) or that the backend now targets `:5528` (option B) before running UAT 5.3.

- [ ] **Step 5: Live UAT (Handler-driven, on a PB-#### test sample)**

Confirm in the browser on a parent sample page:
1. Customer Remarks card shows the "Include with Publish?" checkbox, checked by default.
2. Save with a remark + checked → generate COA → **refresh the sample page** (the card refetches on save, not on generate) → "Delivered on <date/time>" appears.
3. Uncheck → Save → regenerate a **non-conforming** COA (requires 2.19.0 live, Step 4) → generation succeeds (no 422), no "Lab Remarks" button appears on the customer order page, and delivered_at is NOT advanced.
4. DB spot-check: `docker exec accumark_postgres psql -U postgres -d accumark_mk1 -tA -c "SELECT customer_remarks_include, customer_remarks_delivered_at FROM lims_samples WHERE sample_id='<PB-####>'"`

- [ ] **Step 6: Push both branches**

```bash
git -C /c/tmp/accu-mk1-wave1 push origin subsample-features
git -C /c/tmp/coabuilder-variance push origin feat/coa-identity-na-variance
```

---

## Self-Review notes

- **Spec coverage:** schema (T1) · service/route include flag + exposed fields (T2) · generate-COA gate + delivered_at (T3) · COABuilder include-aware gate + version (T4) · FE checkbox + delivered-on (T5) · tests/UAT (T6). All spec sections mapped.
- **Type consistency:** `customer_remarks_include` (bool) and `customer_remarks_delivered_at` (datetime/ISO string) used identically across model, Pydantic, routes, API client, and component props. `include_lab_remarks` is the COABuilder body key; `customer_remarks_include` is the Mk1 column — distinct by design (one is the wire field to COABuilder, the other the DB column).
- **Gate default:** absent `include_lab_remarks` ⇒ True everywhere (DB `DEFAULT TRUE`, Pydantic `= True`, helper default, server `is not None` guard) — no behavior change for existing rows/callers.

# Sample Lot on Cards + Lot Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each sample's customer lot code on the sample cards of the Order Status page and the Customers page, and add a lot search box to both pages (client-side filter on Order Status; server-side fourth search axis on the Customers detail view).

**Architecture:** The lot exists in two places: the WP order payload (`order.payload.samples[i].lot_code`, positionally aligned with `sample_results` keys) and the SENAITE lookup (`SenaiteLookupResult.client_lot`, authoritative once loaded). Cards display `client_lot ?? payload lot`. The Order Status page filter is client-side (matches either source). The Customers-page axis is server-side: a `search_lot` param on IS `GET /explorer/orders` (jsonpath probe on `payload->'samples'`, covered by the existing `idx_order_submissions_samples_gin` GIN index — **no migration**), forwarded verbatim by the Mk1 backend proxy, driven by a fourth debounced input in `CustomerOrdersTab`.

**Tech Stack:** React 19 + TanStack Query + Zustand (selector syntax, ast-grep enforced) + Vitest; FastAPI + SQLAlchemy async + Postgres jsonpath; pytest.

**Spec:** `C:/tmp/mk1-lot-search/docs/superpowers/specs/2026-07-14-sample-lot-cards-search-design.md`

## Global Constraints

- **Worktrees:** Accu-Mk1 work happens in `C:/tmp/mk1-lot-search` (branch `feat/sample-lot-cards-search`, off v1.4.0). integration-service work happens in `C:/tmp/is-lot-search` (branch `feat/search-lot-axis`, off 1.0.8). Never edit the main checkouts.
- **Additive only.** New optional props/params; no existing behavior changes. Do not rename or restructure existing symbols.
- **Accu-Mk1 frontend is npm ONLY** (never pnpm). Fresh worktree: use `npm ci` (NOT `npm install`); if `package-lock.json` shows as modified afterwards, `git checkout -- package-lock.json`.
- **Zustand selector syntax** (`useUIStore(state => state.x)`) is mandatory — ast-grep enforced. No destructuring of the hook result.
- **React Compiler** handles memoization — do NOT add new `useMemo`/`useCallback`; do not remove existing ones.
- **IS Python:** `C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/integration-service/.venv/Scripts/python.exe` (run from the worktree cwd). **Mk1 backend Python:** `C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe`.
- **IS integration tests need live Postgres:** container `accumark_postgres` is already listening on `localhost:5432`. Env: `POSTGRES_HOST=localhost POSTGRES_PASSWORD=accumark_dev_secret`.
- **Commit messages:** conventional commits; end every commit body with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- **Do NOT push** any branch; do NOT bump versions (deploy/version bumps are owned by the accumark-deploy skill later).
- **GitNexus note:** the repo CLAUDE.md mandates `gitnexus_impact` before edits, but both indexes predate the current worktree tips (stale by hundreds of commits). All edits here are additive optional params/props whose only callers are grep-verified in this plan; skip GitNexus and note it in the final report.

---

### Task 1: IS `search_lot` axis on GET /explorer/orders

**Files:**
- Modify: `C:/tmp/is-lot-search/app/api/desktop.py` (handler `get_desktop_orders`, ~lines 399–580)
- Test: `C:/tmp/is-lot-search/tests/integration/test_explorer_orders_search.py`

**Interfaces:**
- Consumes: existing `_jsonpath_string_escape(value: str) -> str` (desktop.py:412), `re` (already imported), `text`/`bindparam` (already imported).
- Produces: `GET /explorer/orders?search_lot=<str≤256>` — case-insensitive literal-substring match on `payload.samples[*].lot_code`, AND-combined with the other axes. Task 2's proxy and Task 7's client forward this param name verbatim.

- [ ] **Step 1: Write the failing tests**

In `tests/integration/test_explorer_orders_search.py`:

1a. Add `lot_code` to the seed payloads in `_seed()` — modify the four `OrderSubmissionRecord` payloads to:

```python
            payload={"samples": [
                {"sample_identity": "BPC-157 5mg", "lot_code": "LOT-A100"},
                {"sample_identity": "GHRP-6 5mg", "lot_code": "LOT-B200"},
            ]},
```
(ORDER_1), and:
```python
            payload={"samples": [{"sample_identity": "NAD+ 100mg", "lot_code": "PZ-777"}]},
```
(ORDER_2). Leave ORDER_3's payload WITHOUT a `lot_code` key (absence coverage — jsonpath must simply not match). Give ORDER_4_OTHER:
```python
            payload={"samples": [{"sample_identity": "BPC-157 50mg", "lot_code": "LOT-A100"}]},
```

1b. Add `search_lot=None` to the `params = dict(...)` defaults in `_call_handler`.

1c. Extend BOTH injection parametrize lists from `["search_sample_id", "search_analyte"]` to `["search_sample_id", "search_analyte", "search_lot"]` (the per-axis test) — the combined-axes test can stay as-is.

1d. Append this section at the end of the file:

```python
# ============================================================================
# Lot axis (2026-07-14 — sample-lot-cards-search)
# ============================================================================

@pytest.mark.asyncio
async def test_search_by_lot_returns_matching_order() -> None:
    """search_lot does case-insensitive regex substring against payload.samples[*].lot_code."""
    await _dispose_stale_engine()
    await _cleanup()
    try:
        async with get_session_factory()() as setup_db:
            await _seed(setup_db)

        result = await _call_handler(search_lot="LOT-A100")
        # ORDER_1 only: ORDER_4_OTHER also carries LOT-A100 but belongs to a
        # different customer (customer-scope must hold on this axis too).
        assert len(result) == 1
        assert result[0].order_number == ORDER_1_ID
    finally:
        await _cleanup()


@pytest.mark.asyncio
async def test_search_by_lot_case_insensitive_substring() -> None:
    """Lowercase partial value matches (like_regex flag 'i', substring semantics)."""
    await _dispose_stale_engine()
    await _cleanup()
    try:
        async with get_session_factory()() as setup_db:
            await _seed(setup_db)

        result = await _call_handler(search_lot="lot-b2")  # partial of LOT-B200
        assert len(result) == 1
        assert result[0].order_number == ORDER_1_ID
    finally:
        await _cleanup()


@pytest.mark.asyncio
async def test_search_by_lot_no_match_returns_empty() -> None:
    """A lot value present nowhere (incl. ORDER_3 which has NO lot_code key) → []."""
    await _dispose_stale_engine()
    await _cleanup()
    try:
        async with get_session_factory()() as setup_db:
            await _seed(setup_db)

        result = await _call_handler(search_lot="NOPE-999")
        assert result == []
    finally:
        await _cleanup()


@pytest.mark.asyncio
async def test_and_combine_lot_plus_analyte() -> None:
    """Lot + analyte AND-combine: consistent pair matches, disjoint pair is empty."""
    await _dispose_stale_engine()
    await _cleanup()
    try:
        async with get_session_factory()() as setup_db:
            await _seed(setup_db)

        # Consistent: ORDER_1 has GHRP-6 AND LOT-B200 (both on sample 2).
        result = await _call_handler(search_lot="LOT-B200", search_analyte="GHRP-6")
        assert len(result) == 1
        assert result[0].order_number == ORDER_1_ID

        # Disjoint: PZ-777 lives on ORDER_2, BPC-157 on ORDER_1/ORDER_3 → empty.
        result_disjoint = await _call_handler(
            search_lot="PZ-777", search_analyte="BPC-157"
        )
        assert result_disjoint == []
    finally:
        await _cleanup()


@pytest.mark.asyncio
async def test_lot_regex_metacharacters_treated_literally() -> None:
    """`.*` must match the LITERAL substring '.*', not act as a regex wildcard."""
    await _dispose_stale_engine()
    await _cleanup()
    try:
        async with get_session_factory()() as setup_db:
            await _seed(setup_db)

        result = await _call_handler(search_lot=".*")
        assert result == []
    finally:
        await _cleanup()


@pytest.mark.asyncio
async def test_empty_search_lot_returns_all_orders() -> None:
    """search_lot='' is no-filter on that axis (same '' semantics as the other axes)."""
    await _dispose_stale_engine()
    await _cleanup()
    try:
        async with get_session_factory()() as setup_db:
            await _seed(setup_db)

        result = await _call_handler(search_lot="")
        nums = {o.order_number for o in result}
        assert nums == {ORDER_1_ID, ORDER_2_ID, ORDER_3_ID}
    finally:
        await _cleanup()
```

- [ ] **Step 2: Run the new tests — verify they fail**

```bash
cd C:/tmp/is-lot-search
POSTGRES_HOST=localhost POSTGRES_PASSWORD=accumark_dev_secret \
  "C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/integration-service/.venv/Scripts/python.exe" \
  -m pytest tests/integration/test_explorer_orders_search.py -q -k "lot"
```

Expected: the new lot tests FAIL with `TypeError: get_desktop_orders() got an unexpected keyword argument 'search_lot'`. (If Postgres is unreachable, STOP and report — do not fake the cycle.)

- [ ] **Step 3: Implement `search_lot` in the handler**

In `app/api/desktop.py`:

3a. Update the axis comment above `ALLOWED_SORTS` (~line 394): change “THREE independent params (`search_order_number`, `search_sample_id`, `search_analyte`)” to “FOUR independent params (`search_order_number`, `search_sample_id`, `search_analyte`, `search_lot`)”.

3b. Add the param to the signature directly after the `search_analyte` Query block:

```python
    search_lot: str | None = Query(
        None,
        max_length=256,
        description="Filter: case-insensitive regex on payload.samples[*].lot_code (jsonpath @?)",
    ),
```

3c. Add to the `logger.info("desktop_orders_request", ...)` kwargs, after `search_analyte_len`:

```python
        search_lot_len=len(search_lot) if search_lot else 0,
```

3d. Add the condition directly after the `if search_analyte:` block:

```python
    if search_lot:
        # Same @? + jsonpath_ops strategy as search_analyte — probes the SAME
        # indexed expression (payload->'samples'), so
        # idx_order_submissions_samples_gin covers this axis with no new
        # migration. lot_code is the customer's lot/batch code captured on the
        # WP order wizard (app/models/order.py Sample.lot_code); samples
        # without the key simply never satisfy the jsonpath predicate.
        #
        # T-30-01 mitigation — same two layers as the analyte axis:
        #   1. re.escape() disables regex metacharacters in user input
        #   2. _jsonpath_string_escape() disables jsonpath string-literal
        #      escapes introduced by re.escape() (backslashes)
        # Bound under a distinct name (`lot_path`) so it AND-combines with
        # sample_path / analyte_path in one query without bindparam collisions.
        regex_safe_lot = re.escape(search_lot)
        lot_path = f'$[*].lot_code ? (@ like_regex "{_jsonpath_string_escape(regex_safe_lot)}" flag "i")'
        conditions.append(
            text("payload->'samples' @? CAST(:lot_path AS jsonpath)")
            .bindparams(bindparam("lot_path", value=lot_path))
        )
```

- [ ] **Step 4: Run the lot tests — verify they pass**

Same command as Step 2. Expected: all `-k "lot"` tests PASS.

- [ ] **Step 5: Run the whole search test file + lint gates**

```bash
cd C:/tmp/is-lot-search
POSTGRES_HOST=localhost POSTGRES_PASSWORD=accumark_dev_secret \
  "C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/integration-service/.venv/Scripts/python.exe" \
  -m pytest tests/integration/test_explorer_orders_search.py -q
"C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/integration-service/.venv/Scripts/python.exe" -m ruff check app tests
"C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/integration-service/.venv/Scripts/python.exe" -m mypy app
```

Expected: full file PASS (including the pre-existing injection/AND/sort tests), ruff clean, mypy clean (match the repo's existing mypy baseline — if pre-existing errors unrelated to desktop.py appear, only NEW errors block).

- [ ] **Step 6: Commit**

```bash
cd C:/tmp/is-lot-search
git add app/api/desktop.py tests/integration/test_explorer_orders_search.py
git commit -m "feat(explorer): search_lot axis on GET /explorer/orders

Fourth AND-combined search axis: case-insensitive literal-substring match
on payload.samples[*].lot_code via the same escaped-jsonpath + @? pipeline
as search_analyte. Covered by the existing GIN index on payload->'samples'
(no migration).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Mk1 backend proxy forwards `search_lot`

**Files:**
- Modify: `C:/tmp/mk1-lot-search/backend/main.py` (handler `get_explorer_orders`, ~lines 7565–7625)

**Interfaces:**
- Consumes: Task 1's IS param name `search_lot`.
- Produces: Mk1 `GET /explorer/orders?...&search_lot=<str>` accepted and forwarded — Task 7's `api.ts` calls this.

- [ ] **Step 1: Add the param and forward it**

In `get_explorer_orders`:

1a. Signature — after `search_analyte: Optional[str] = None,` add:

```python
    search_lot: Optional[str] = None,
```

1b. Docstring — extend the axis line to read:

```
    - search_order_number / search_sample_id / search_analyte / search_lot:
      UX-revision AND-combined search axes (Customer Detail → Customer Orders
      tab). Each is independently optional; the IS AND-combines whichever are
      set. Each is forwarded only when explicitly provided so an absent param
      stays absent.
```

1c. Forward block — after the `if search_analyte is not None:` lines add:

```python
        if search_lot is not None:
            params["search_lot"] = search_lot
```

- [ ] **Step 2: Syntax gate**

```bash
cd C:/tmp/mk1-lot-search
"C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m py_compile backend/main.py && echo COMPILE-OK
```

Expected: `COMPILE-OK`. (No dedicated proxy test exists for the other three axes either — the IS integration tests own the SQL contract; parity preserved.)

- [ ] **Step 3: Commit**

```bash
cd C:/tmp/mk1-lot-search
git add backend/main.py
git commit -m "feat(explorer): forward search_lot to Integration Service

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Frontend setup + SampleCard `lot` prop

**Files:**
- Modify: `C:/tmp/mk1-lot-search/src/components/explorer/SampleCard.tsx`
- Test: `C:/tmp/mk1-lot-search/src/test/sample-card.test.tsx`

**Interfaces:**
- Consumes: `SenaiteLookupResult.client_lot: string | null` (exists in `src/lib/api.ts`).
- Produces: `SampleCard` prop `lot?: string` (payload-sourced). Render contract: `data-testid="sample-card-lot-${sampleId}"`, text `Lot: {value}`, `title={value}`; normal branch prefers `lookup.client_lot`; row omitted when neither source has a non-blank value. Tasks 4 uses this prop.

- [ ] **Step 1: One-time worktree setup**

```bash
cd C:/tmp/mk1-lot-search
npm ci
git status --short -- package-lock.json
```

Expected: `npm ci` completes; `git status` shows package-lock.json UNMODIFIED (if modified: `git checkout -- package-lock.json`).

- [ ] **Step 2: Write the failing tests**

Append to `src/test/sample-card.test.tsx` (uses the file's existing `wrapper` and `makeLookup` helpers):

```tsx
// Lot display — payload `lot_code` prop with SENAITE `client_lot` upgrade.
// Payload value renders on all three branches (loading / error / normal);
// on the normal branch the SENAITE lookup's client_lot (authoritative,
// lab-editable) wins over the payload value. When neither source has a
// value the row is omitted entirely (no whitespace gap).
describe('SampleCard — lot display', () => {
  it('renders the payload lot on the loading branch', () => {
    render(
      <SampleCard
        sampleId="P-0001"
        lookup={undefined}
        isLoading={true}
        isError={false}
        lot="LOT-A100"
      />,
      { wrapper }
    )
    expect(screen.getByTestId('sample-card-lot-P-0001')).toHaveTextContent(
      'Lot: LOT-A100'
    )
  })

  it('renders the payload lot on the error branch', () => {
    render(
      <SampleCard
        sampleId="P-0001"
        lookup={undefined}
        isLoading={false}
        isError={true}
        lot="LOT-A100"
      />,
      { wrapper }
    )
    expect(screen.getByTestId('sample-card-lot-P-0001')).toHaveTextContent(
      'Lot: LOT-A100'
    )
  })

  it('prefers lookup.client_lot over the payload lot on the normal branch', () => {
    const lookup = makeLookup({
      review_state: 'verified',
      client_lot: 'LOT-EDITED',
    })
    render(
      <SampleCard
        sampleId="P-0001"
        lookup={lookup}
        isLoading={false}
        isError={false}
        lot="LOT-A100"
      />,
      { wrapper }
    )
    const el = screen.getByTestId('sample-card-lot-P-0001')
    expect(el).toHaveTextContent('Lot: LOT-EDITED')
    expect(el).toHaveAttribute('title', 'LOT-EDITED')
    expect(el.className).toMatch(/truncate/)
  })

  it('falls back to the payload lot when client_lot is null', () => {
    const lookup = makeLookup({ review_state: 'verified', client_lot: null })
    render(
      <SampleCard
        sampleId="P-0001"
        lookup={lookup}
        isLoading={false}
        isError={false}
        lot="LOT-A100"
      />,
      { wrapper }
    )
    expect(screen.getByTestId('sample-card-lot-P-0001')).toHaveTextContent(
      'Lot: LOT-A100'
    )
  })

  it('renders client_lot even when no payload lot prop is passed', () => {
    const lookup = makeLookup({ review_state: 'verified', client_lot: 'LOT-S1' })
    render(
      <SampleCard
        sampleId="P-0001"
        lookup={lookup}
        isLoading={false}
        isError={false}
      />,
      { wrapper }
    )
    expect(screen.getByTestId('sample-card-lot-P-0001')).toHaveTextContent(
      'Lot: LOT-S1'
    )
  })

  it('omits the lot row entirely when neither source has a value', () => {
    const lookup = makeLookup({ review_state: 'verified', client_lot: null })
    render(
      <SampleCard
        sampleId="P-0001"
        lookup={lookup}
        isLoading={false}
        isError={false}
      />,
      { wrapper }
    )
    expect(
      screen.queryByTestId('sample-card-lot-P-0001')
    ).not.toBeInTheDocument()
  })

  it('omits the lot row for a blank payload lot on the loading branch', () => {
    render(
      <SampleCard
        sampleId="P-0001"
        lookup={undefined}
        isLoading={true}
        isError={false}
        lot="  "
      />,
      { wrapper }
    )
    expect(
      screen.queryByTestId('sample-card-lot-P-0001')
    ).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 3: Run — verify the new tests fail**

```bash
cd C:/tmp/mk1-lot-search
npx vitest run src/test/sample-card.test.tsx
```

Expected: the 7 new tests FAIL (`Unable to find an element by: [data-testid="sample-card-lot-P-0001"]`); all pre-existing tests still pass.

- [ ] **Step 4: Implement the `lot` prop in SampleCard**

In `src/components/explorer/SampleCard.tsx`:

4a. Add `lot,` to the destructured props (after `analyte,`) and to the props type (after the `analyte?: string` entry):

```tsx
  // Sample lot — payload-sourced (`order.payload.samples[i].lot_code`), same
  // positional-alignment contract as `analyte`, so it shows on all three
  // render branches. On the normal branch the SENAITE lookup's `client_lot`
  // (authoritative — lab-editable after AR creation) wins over this prop.
  // When neither source has a non-blank value the row is omitted.
  lot?: string
```

4b. Below the `analyteEl` definition add:

```tsx
  const payloadLot =
    typeof lot === 'string' && lot.trim().length > 0 ? lot.trim() : undefined
  const lotRow = (value: string | undefined) =>
    value ? (
      <div
        data-testid={`sample-card-lot-${sampleId}`}
        className="text-xs text-muted-foreground truncate mb-1"
        title={value}
      >
        Lot: {value}
      </div>
    ) : null
```

4c. Loading branch — after `{analyteEl}` add `{lotRow(payloadLot)}`.

4d. Error branch — after `{analyteEl}` (before the `Failed to load` div) add `{lotRow(payloadLot)}`.

4e. Normal branch — above the `return` (next to `counts`) add:

```tsx
  const clientLot =
    lookup.client_lot && lookup.client_lot.trim().length > 0
      ? lookup.client_lot.trim()
      : undefined
```

and after `{analyteEl}` in the JSX add `{lotRow(clientLot ?? payloadLot)}`.

- [ ] **Step 5: Run — verify all tests pass**

```bash
npx vitest run src/test/sample-card.test.tsx
```

Expected: ALL PASS.

- [ ] **Step 6: Commit**

```bash
cd C:/tmp/mk1-lot-search
git add src/components/explorer/SampleCard.tsx src/test/sample-card.test.tsx
git commit -m "feat(explorer): lot row on SampleCard (client_lot ?? payload lot)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: OrderRow extracts `lot_code` and passes it through

**Files:**
- Modify: `C:/tmp/mk1-lot-search/src/components/explorer/OrderRow.tsx`
- Test: `C:/tmp/mk1-lot-search/src/test/order-row.test.tsx`

**Interfaces:**
- Consumes: Task 3's `SampleCard lot?: string` prop.
- Produces: `sampleEntries[i].lot: string | undefined` extracted from `order.payload.samples[idx].lot_code` (idx = parseInt(sample_results key) − 1). The failed-sample inline card renders the same `Lot:` line.

- [ ] **Step 1: Write the failing tests**

Append to `src/test/order-row.test.tsx` (uses the file's existing `makeOrder`, `renderRow`, and empty `sampleLookupMap` patterns; the SampleCard renders its loading branch when the map has no entry — the lot line is payload-sourced so it renders regardless):

```tsx
// Lot pass-through — payload.samples[i].lot_code reaches the SampleCard lot
// row via the same positional alignment used for the analyte (key "1" →
// samples[0]). Payload-sourced, so it renders even while the SENAITE lookup
// is loading (empty sampleLookupMap ⇒ loading branch).
describe('OrderRow — lot pass-through', () => {
  const emptyMap = new Map<
    string,
    { data?: SenaiteLookupResult; isLoading: boolean; isError: boolean }
  >()

  it('passes payload lot_code positionally to each SampleCard', () => {
    const order = makeOrder({
      sample_results: {
        '1': { senaite_id: 'P-0001', status: 'created' },
        '2': { senaite_id: 'P-0002', status: 'created' },
      },
      payload: {
        billing: { email: 'forrestp@outlook.com' },
        samples: [
          { sample_identity: 'BPC-157', lot_code: 'LOT-A100' },
          { sample_identity: 'GHRP-6', lot_code: 'LOT-B200' },
        ],
      },
    })
    renderRow(
      <OrderRow
        order={order}
        wordpressHost="https://wp.example.test"
        sampleLookupMap={emptyMap}
        activeAnalysisStates={[]}
      />
    )
    expect(screen.getByTestId('sample-card-lot-P-0001')).toHaveTextContent(
      'Lot: LOT-A100'
    )
    expect(screen.getByTestId('sample-card-lot-P-0002')).toHaveTextContent(
      'Lot: LOT-B200'
    )
  })

  it('omits the lot row when the payload sample has no lot_code', () => {
    const order = makeOrder({
      sample_results: { '1': { senaite_id: 'P-0003', status: 'created' } },
      payload: {
        billing: { email: 'forrestp@outlook.com' },
        samples: [{ sample_identity: 'NAD+' }],
      },
    })
    renderRow(
      <OrderRow
        order={order}
        wordpressHost="https://wp.example.test"
        sampleLookupMap={emptyMap}
        activeAnalysisStates={[]}
      />
    )
    expect(screen.queryByTestId('sample-card-lot-P-0003')).toBeNull()
  })

  it('renders the lot line on the failed-sample inline card', () => {
    const order = makeOrder({
      sample_results: { '1': { senaite_id: '', status: 'failed' } },
      payload: {
        billing: { email: 'forrestp@outlook.com' },
        samples: [{ sample_identity: 'BPC-157', lot_code: 'LOT-F500' }],
      },
    })
    renderRow(
      <OrderRow
        order={order}
        wordpressHost="https://wp.example.test"
        sampleLookupMap={emptyMap}
        activeAnalysisStates={[]}
      />
    )
    expect(screen.getByText('Lot: LOT-F500')).toBeInTheDocument()
    expect(screen.getByText('Failed to create in SENAITE')).toBeInTheDocument()
  })
})
```

Note: if `makeOrder`'s `sample_results` value type requires more fields than `{ senaite_id, status }`, mirror whatever shape the file's existing sample-results tests use — do not invent new fields.

- [ ] **Step 2: Run — verify the new tests fail**

```bash
cd C:/tmp/mk1-lot-search
npx vitest run src/test/order-row.test.tsx
```

Expected: 3 new tests FAIL (no lot testids rendered); pre-existing tests pass.

- [ ] **Step 3: Implement extraction + pass-through**

In `src/components/explorer/OrderRow.tsx`:

3a. Replace the `payloadSamples` type assertion and `sampleEntries` map (currently ~lines 87–107) with:

```tsx
  const payloadSamples = (
    order.payload as
      | { samples?: { sample_identity?: string; lot_code?: string }[] }
      | null
      | undefined
  )?.samples
  const sampleEntries = order.sample_results
    ? Object.entries(order.sample_results).map(([key, val]) => {
        const idx = parseInt(key, 10) - 1
        const payloadSample = Number.isNaN(idx) ? undefined : payloadSamples?.[idx]
        const trimmed = payloadSample?.sample_identity?.trim()
        const trimmedLot = payloadSample?.lot_code?.trim()
        return {
          name: key,
          senaiteId: val.senaite_id,
          integrationStatus: val.status,
          analyte: trimmed && trimmed.length > 0 ? trimmed : undefined,
          lot: trimmedLot && trimmedLot.length > 0 ? trimmedLot : undefined,
        }
      })
    : []
```

3b. Failed-sample inline card — after its `{s.analyte && (...)}` block add:

```tsx
                    {s.lot && (
                      <div
                        className="text-xs text-muted-foreground truncate mb-1"
                        title={s.lot}
                      >
                        Lot: {s.lot}
                      </div>
                    )}
```

3c. `SampleCard` call — add `lot={s.lot}` after `analyte={s.analyte}`.

- [ ] **Step 4: Run — verify all tests pass**

```bash
npx vitest run src/test/order-row.test.tsx src/test/sample-card.test.tsx
```

Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
cd C:/tmp/mk1-lot-search
git add src/components/explorer/OrderRow.tsx src/test/order-row.test.tsx
git commit -m "feat(explorer): extract payload lot_code in OrderRow, pass to SampleCard

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Order Status page — Lot filter box + kanban lot line

**Files:**
- Modify: `C:/tmp/mk1-lot-search/src/components/explorer/order-filters.ts`
- Modify: `C:/tmp/mk1-lot-search/src/components/OrderStatusPage.tsx`
- Test: `C:/tmp/mk1-lot-search/src/test/order-filters.test.ts`

**Interfaces:**
- Consumes: `ExplorerOrder` / `SenaiteLookupResult` types from `@/lib/api`.
- Produces: `orderMatchesLot(order: ExplorerOrder, query: string, sampleLookupMap: Map<string, { data?: SenaiteLookupResult; isLoading: boolean; isError: boolean }>): boolean` in `order-filters.ts`; `OrderFilters.lotFilter: string`; `KanbanSampleItem.lot?: string`.

- [ ] **Step 1: Write the failing unit tests for `orderMatchesLot`**

Append to `src/test/order-filters.test.ts` (match the file's existing import style):

```ts
import { orderMatchesLot } from '@/components/explorer/order-filters'
import type { ExplorerOrder, SenaiteLookupResult } from '@/lib/api'

type LookupMap = Map<
  string,
  { data?: SenaiteLookupResult; isLoading: boolean; isError: boolean }
>

const makeLotOrder = (over: Partial<ExplorerOrder> = {}): ExplorerOrder =>
  ({
    id: 'u-1',
    order_id: '1001',
    order_number: '1001',
    status: 'accepted',
    payload: { samples: [{ lot_code: 'LOT-A100' }] },
    sample_results: { '1': { senaite_id: 'P-0001', status: 'created' } },
    created_at: '2026-01-01T00:00:00Z',
    completed_at: null,
    ...over,
  }) as ExplorerOrder

const emptyMap: LookupMap = new Map()

const mapWithClientLot = (sampleId: string, clientLot: string): LookupMap =>
  new Map([
    [
      sampleId,
      {
        data: { client_lot: clientLot } as SenaiteLookupResult,
        isLoading: false,
        isError: false,
      },
    ],
  ])

describe('orderMatchesLot', () => {
  it('matches payload lot_code case-insensitively on substring', () => {
    expect(orderMatchesLot(makeLotOrder(), 'lot-a1', emptyMap)).toBe(true)
  })

  it('does not match when neither source contains the query', () => {
    expect(orderMatchesLot(makeLotOrder(), 'ZZZ', emptyMap)).toBe(false)
  })

  it('matches the loaded lookup client_lot when the payload has no lot', () => {
    const order = makeLotOrder({ payload: { samples: [{}] } })
    expect(
      orderMatchesLot(order, 'edited', mapWithClientLot('P-0001', 'LOT-EDITED'))
    ).toBe(true)
  })

  it('aligns positionally: sample_results key "2" reads payload samples[1]', () => {
    const order = makeLotOrder({
      payload: { samples: [{ lot_code: 'AAA' }, { lot_code: 'BBB' }] },
      sample_results: {
        '1': { senaite_id: 'P-0001', status: 'created' },
        '2': { senaite_id: 'P-0002', status: 'created' },
      },
    })
    expect(orderMatchesLot(order, 'bbb', emptyMap)).toBe(true)
  })

  it('empty/whitespace query matches everything (no-filter semantics)', () => {
    expect(orderMatchesLot(makeLotOrder(), '   ', emptyMap)).toBe(true)
  })

  it('order without sample_results never matches a non-empty query', () => {
    const order = makeLotOrder({ sample_results: null })
    expect(orderMatchesLot(order, 'lot', emptyMap)).toBe(false)
  })
})
```

- [ ] **Step 2: Run — verify they fail**

```bash
cd C:/tmp/mk1-lot-search
npx vitest run src/test/order-filters.test.ts
```

Expected: FAIL — `orderMatchesLot` is not exported.

- [ ] **Step 3: Implement `orderMatchesLot`**

Append to `src/components/explorer/order-filters.ts`:

```ts
import type { ExplorerOrder, SenaiteLookupResult } from '@/lib/api'

/** True when any of the order's samples matches the lot query — against the
 *  payload's customer-entered `lot_code` (instant; present on the fetched
 *  order, positionally aligned with sample_results keys) OR the sample's
 *  loaded SENAITE `client_lot` (authoritative, lab-editable; refines as
 *  lookups arrive). Case-insensitive substring. Empty/whitespace query =
 *  no filter (matches). */
export function orderMatchesLot(
  order: ExplorerOrder,
  query: string,
  sampleLookupMap: Map<
    string,
    { data?: SenaiteLookupResult; isLoading: boolean; isError: boolean }
  >
): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  if (!order.sample_results) return false
  const payloadSamples = (
    order.payload as { samples?: { lot_code?: string }[] } | null | undefined
  )?.samples
  return Object.entries(order.sample_results).some(([key, v]) => {
    const idx = parseInt(key, 10) - 1
    const payloadLot = Number.isNaN(idx)
      ? undefined
      : payloadSamples?.[idx]?.lot_code
    if (payloadLot?.toLowerCase().includes(q)) return true
    if (!v.senaite_id) return false
    const clientLot = sampleLookupMap.get(v.senaite_id)?.data?.client_lot
    return clientLot?.toLowerCase().includes(q) ?? false
  })
}
```

(Keep the existing type-only import line for `OrderSlaVerdict`; merge imports per the file's lint style.)

- [ ] **Step 4: Run — verify unit tests pass**

```bash
npx vitest run src/test/order-filters.test.ts
```

Expected: ALL PASS.

- [ ] **Step 5: Wire the Lot filter + kanban lot into OrderStatusPage**

In `src/components/OrderStatusPage.tsx`:

5a. Import: add `orderMatchesLot` to the existing import from `./explorer/order-filters` (the file already imports `toggleFilterKey` / `isOrderAtRisk` — extend that import).

5b. `OrderFilters` interface — after `analyteFilter: string` add `lotFilter: string`.

5c. `loadOrderFilters()` — in the parsed-return add `lotFilter: parsed.lotFilter ?? '',` (next to the `analyteFilter` back-compat line) and in the fallback default object add `lotFilter: '',`.

5d. `filteredOrders` useMemo — directly after the analyte-filter `if (analyteQ) {...}` block add:

```ts
    // Lot filter — payload lot_code (instant) OR loaded SENAITE client_lot
    // (refines as lookups arrive). Same progressive-refinement contract as
    // the analyte filter above.
    const lotQ = orderFilters.lotFilter.trim().toLowerCase()
    if (lotQ) {
      result = result.filter(o => orderMatchesLot(o, lotQ, sampleLookupMap))
    }
```

5e. Row-3 text filters — after the Analyte `<Input>` add:

```tsx
            <Input
              placeholder="Lot"
              value={orderFilters.lotFilter}
              onChange={e => updateFilters({ lotFilter: e.target.value })}
              className="h-7 w-32 text-xs"
            />
```

5f. Clear button — extend the presence condition to
`(orderFilters.orderIdFilter || orderFilters.emailFilter || orderFilters.sampleIdFilter || orderFilters.analyteFilter || orderFilters.lotFilter)`
and the reset call to
`updateFilters({ orderIdFilter: '', emailFilter: '', sampleIdFilter: '', analyteFilter: '', lotFilter: '' })`.

5g. `KanbanSampleItem` interface — after `analysisServices?: string[]` add:

```ts
  lot?: string  // payload lot_code, positionally aligned (display fallback for client_lot)
```

5h. `KanbanView` `allItems` useMemo — rework the inner loop to keep positional keys (currently `Object.values`); replace the `for (const entry of Object.values(order.sample_results))` loop header and add lot extraction:

```ts
      const kanbanPayloadSamples = (
        order.payload as { samples?: { lot_code?: string }[] } | null | undefined
      )?.samples
      for (const [slotKey, entry] of Object.entries(order.sample_results)) {
        if (!entry.senaite_id || entry.status === 'failed') continue
        const slotIdx = parseInt(slotKey, 10) - 1
        const rawLot = Number.isNaN(slotIdx)
          ? undefined
          : kanbanPayloadSamples?.[slotIdx]?.lot_code
        const lot =
          rawLot && rawLot.trim().length > 0 ? rawLot.trim() : undefined
```

and add `lot,` to BOTH `items.push({...})` object literals (the loading-branch push and the count-branch push).

5i. `KanbanSampleCard` — after the analysts block (`{analysts.length > 0 && (...)}`) add:

```tsx
      {(item.lookup?.client_lot ?? item.lot) && (
        <div className="flex items-center gap-1 mt-0.5">
          <span className="text-[10px] text-muted-foreground/50">Lot:</span>
          <span className="text-[10px] text-muted-foreground/80 truncate">
            {item.lookup?.client_lot ?? item.lot}
          </span>
        </div>
      )}
```

- [ ] **Step 6: Typecheck + targeted tests**

```bash
cd C:/tmp/mk1-lot-search
npx tsc --noEmit -p tsconfig.json
npx vitest run src/test/order-filters.test.ts src/test/order-row.test.tsx src/test/sample-card.test.tsx
```

Expected: tsc clean (no NEW errors — if the repo has a pre-existing tsc baseline, only new errors block); tests PASS.

- [ ] **Step 7: Commit**

```bash
cd C:/tmp/mk1-lot-search
git add src/components/explorer/order-filters.ts src/components/OrderStatusPage.tsx src/test/order-filters.test.ts
git commit -m "feat(order-status): Lot filter box + lot on kanban cards

Client-side filter matches payload lot_code instantly and loaded SENAITE
client_lot as lookups arrive (same progressive contract as the analyte
filter). Kanban items carry the positional payload lot as display fallback.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: ui-store `lot` search slot

**Files:**
- Modify: `C:/tmp/mk1-lot-search/src/store/ui-store.ts`
- Test: `C:/tmp/mk1-lot-search/src/store/ui-store.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `customerOrderSearch: { order_number: string; sample_id: string; analyte: string; lot: string }`; `setCustomerOrderSearchField(field: 'order_number' | 'sample_id' | 'analyte' | 'lot', value: string)`. Task 7 consumes both.

- [ ] **Step 1: Update/extend the store tests (they must fail first)**

In `src/store/ui-store.test.ts`, find every assertion of the `customerOrderSearch` shape (search for `customerOrderSearch`; the existing block sits ~lines 300–400):

1a. Extend EVERY `expect(...customerOrderSearch).toEqual({ order_number: ..., sample_id: ..., analyte: ... })` literal with `lot: ''` (or the set value where the test seeds slots).

1b. Extend every seeding literal (`useUIStore.setState({ customerOrderSearch: { ... } })`) with a `lot` key — `lot: ''` unless the test is about preserving other slots, in which case follow the test's intent.

1c. Add two new tests inside the same describe block:

```ts
  it('setCustomerOrderSearchField("lot", v) writes the lot slot and preserves the others', () => {
    useUIStore.setState({
      customerOrderSearch: {
        order_number: '3001',
        sample_id: 'P-0001',
        analyte: 'BPC',
        lot: '',
      },
    })
    useUIStore.getState().setCustomerOrderSearchField('lot', 'LOT-A100')
    expect(useUIStore.getState().customerOrderSearch).toEqual({
      order_number: '3001',
      sample_id: 'P-0001',
      analyte: 'BPC',
      lot: 'LOT-A100',
    })
  })

  it('setCustomerOrderSearchReset clears the lot slot too', () => {
    useUIStore.setState({
      customerOrderSearch: {
        order_number: '',
        sample_id: '',
        analyte: '',
        lot: 'LOT-A100',
      },
    })
    useUIStore.getState().setCustomerOrderSearchReset()
    expect(useUIStore.getState().customerOrderSearch).toEqual({
      order_number: '',
      sample_id: '',
      analyte: '',
      lot: '',
    })
  })
```

(Mirror the file's existing setup/reset conventions — if it resets the store via a helper in beforeEach, use that.)

- [ ] **Step 2: Run — verify failures**

```bash
cd C:/tmp/mk1-lot-search
npx vitest run src/store/ui-store.test.ts
```

Expected: the updated/new tests FAIL (missing `lot` key).

- [ ] **Step 3: Implement the `lot` slot**

In `src/store/ui-store.ts`, update EVERY site (search the file for `customerOrderSearch` and the field union — there are five):

3a. State type: add `lot: string` to the `customerOrderSearch` object type.

3b. Setter type: extend the union to `field: 'order_number' | 'sample_id' | 'analyte' | 'lot'`.

3c. Initial state: `customerOrderSearch: { order_number: '', sample_id: '', analyte: '', lot: '' }`.

3d. `navigateToCustomers` inline reset object: add `lot: ''`.

3e. `setCustomerOrderSearchReset` object: add `lot: ''`.

(`setCustomerOrderSearchField` itself spreads state — no change needed. Update the nearby “three slots / three search slots” comments to “four”.)

- [ ] **Step 4: Run — verify pass**

```bash
npx vitest run src/store/ui-store.test.ts
```

Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
cd C:/tmp/mk1-lot-search
git add src/store/ui-store.ts src/store/ui-store.test.ts
git commit -m "feat(store): lot slot on customerOrderSearch

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Customer detail — Lot input, API axis, queryKey

**Files:**
- Modify: `C:/tmp/mk1-lot-search/src/lib/api.ts` (`getExplorerOrdersByCustomer`, ~lines 1338–1390)
- Modify: `C:/tmp/mk1-lot-search/src/components/CustomerStatusPage.tsx` (`CustomerDetailView` + `CustomerOrdersTab`)
- Test: `C:/tmp/mk1-lot-search/src/test/customer-status-page.test.tsx`

**Interfaces:**
- Consumes: Task 6's store slot + setter union; Task 2's Mk1 `search_lot` param.
- Produces: `getExplorerOrdersByCustomer(customerId, { order_number?, sample_id?, analyte?, lot? }, sort, page, perPage)` — `lot` forwarded as `search_lot` behind the 2-char gate; a fourth labeled input **Lot** (`id="customer-orders-search-lot"`, aria-label `Lot`).

- [ ] **Step 1: Update/extend the component tests (fail first)**

In `src/test/customer-status-page.test.tsx`:

1a. Every literal that seeds `mockState.customerOrderSearch = { order_number: ..., sample_id: ..., analyte: ... }` gains `lot: ''` (including the top-of-file `mockState` initializer and the search-describe `beforeEach`).

1b. Every `expect(getExplorerOrdersByCustomer).toHaveBeenCalledWith(42, { order_number: ..., sample_id: ..., analyte: ... }, 'open_first', 0, 50)` assertion gains `lot: ''` in the search object.

1c. Update the “renders three labeled search inputs” test: add `expect(screen.getByLabelText('Lot')).toBeInTheDocument()` (rename the it() to mention four inputs).

1d. Add to the search describe block:

```tsx
  it('typing in Lot dispatches setCustomerOrderSearchField("lot", value) after 300ms debounce', async () => {
    renderDetailWithCache(makeCustomer({ customer_id: 42 }))
    const lotInput = await screen.findByLabelText('Lot')

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      fireEvent.change(lotInput, { target: { value: 'LOT-A100' } })
      expect(mockState.setCustomerOrderSearchField).not.toHaveBeenCalled()
      vi.advanceTimersByTime(300)
      expect(mockState.setCustomerOrderSearchField).toHaveBeenCalledWith(
        'lot',
        'LOT-A100'
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('forwards the committed lot slot to getExplorerOrdersByCustomer', async () => {
    mockState.customerOrderSearch = {
      order_number: '',
      sample_id: '',
      analyte: '',
      lot: 'LOT-A100',
    }
    renderDetailWithCache(makeCustomer({ customer_id: 42 }))
    await waitFor(() => {
      expect(getExplorerOrdersByCustomer).toHaveBeenCalledWith(
        42,
        { order_number: '', sample_id: '', analyte: '', lot: 'LOT-A100' },
        'open_first',
        0,
        50
      )
    })
  })
```

- [ ] **Step 2: Run — verify failures**

```bash
cd C:/tmp/mk1-lot-search
npx vitest run src/test/customer-status-page.test.tsx
```

Expected: new/updated tests FAIL (no Lot input; search object missing `lot`).

- [ ] **Step 3: Implement the API axis**

In `src/lib/api.ts` `getExplorerOrdersByCustomer`:

3a. Extend the `search` param type:

```ts
  search?: {
    order_number?: string
    sample_id?: string
    analyte?: string
    lot?: string
  },
```

3b. Inside the `if (search) {` block, after the analyte gate:

```ts
      if (search.lot && search.lot.length >= 2) {
        params.set('search_lot', search.lot)
      }
```

- [ ] **Step 4: Implement the component wiring**

In `src/components/CustomerStatusPage.tsx`:

4a. `CustomerDetailView` orders queryKey — insert `customerOrderSearch.lot` directly after `customerOrderSearch.analyte`. `envName` stays LAST; update its comment from “index 8” to “index 9”.

4b. `CustomerDetailView` queryFn — pass the slot:

```ts
      return getExplorerOrdersByCustomer(
        customerDetailTargetId,
        {
          order_number: customerOrderSearch.order_number,
          sample_id: customerOrderSearch.sample_id,
          analyte: customerOrderSearch.analyte,
          lot: customerOrderSearch.lot,
        },
        'open_first',
        0,
        50
      )
```

4c. `CustomerOrdersTab` prop types — `customerOrderSearch` gains `lot: string`; `setCustomerOrderSearchField`'s union gains `'lot'`.

4d. `CustomerOrdersTab` local state + debounce (mirror the analyte pair exactly):

```tsx
  const [lotInput, setLotInput] = useState(customerOrderSearch.lot)
```

```tsx
  useEffect(() => {
    if (lotInput === customerOrderSearch.lot) return
    const handle = setTimeout(() => {
      setCustomerOrderSearchField('lot', lotInput)
    }, 300)
    return () => clearTimeout(handle)
  }, [lotInput, customerOrderSearch.lot, setCustomerOrderSearchField])
```

4e. `searchActive` — add `|| customerOrderSearch.lot` to the `Boolean(...)`.

4f. `activeFilters` — after the analyte push:

```ts
  if (customerOrderSearch.lot) {
    activeFilters.push({ label: 'Lot', value: customerOrderSearch.lot })
  }
```

4g. `handleClearAll` — add `setLotInput('')`.

4h. Fourth input — after the Analyte input div:

```tsx
        <div className="flex flex-col gap-1 flex-1">
          <Label htmlFor="customer-orders-search-lot">Lot</Label>
          <Input
            id="customer-orders-search-lot"
            aria-label="Lot"
            value={lotInput}
            onChange={e => setLotInput(e.target.value)}
            placeholder="e.g., LOT-001"
          />
        </div>
```

- [ ] **Step 5: Run — verify pass**

```bash
npx vitest run src/test/customer-status-page.test.tsx
```

Expected: ALL PASS (including all pre-existing tests in the file).

- [ ] **Step 6: Commit**

```bash
cd C:/tmp/mk1-lot-search
git add src/lib/api.ts src/components/CustomerStatusPage.tsx src/test/customer-status-page.test.tsx
git commit -m "feat(customers): Lot search axis on customer-detail orders

Fourth debounced input; forwarded as search_lot behind the 2-char client
gate; queryKey gains the lot slot with envName kept last.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Full gates (both repos)

**Files:** none modified (verification only; fix-forward anything the gates surface).

- [ ] **Step 1: Mk1 full gate**

```bash
cd C:/tmp/mk1-lot-search
npm run check:all
```

Expected: typecheck/lint/ast:lint/format clean. Known-baseline test failures are ACCEPTABLE (memory baseline: ~34 frontend failures across 5 flag-hook-pollution files, measured on the 1.0.25/1.0.26 lineage — v1.4.0 numbers may differ slightly). The gate is a **normalized failure-set diff**: any failing test FILE not plausibly in the pre-existing baseline (i.e., any file this plan touched, or any new failure clearly caused by the lot changes) must be fixed. If unsure whether a failure is baseline, check it on a clean checkout: `git stash && npx vitest run <file> && git stash pop`.

- [ ] **Step 2: IS full gate**

```bash
cd C:/tmp/is-lot-search
"C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/integration-service/.venv/Scripts/python.exe" -m pytest tests/unit -q
POSTGRES_HOST=localhost POSTGRES_PASSWORD=accumark_dev_secret \
  "C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/integration-service/.venv/Scripts/python.exe" \
  -m pytest tests/integration/test_explorer_orders_search.py -q
"C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/integration-service/.venv/Scripts/python.exe" -m ruff check app tests
"C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/integration-service/.venv/Scripts/python.exe" -m mypy app
```

Expected: unit suite passes (baseline-diff rule applies here too), search integration file fully green, ruff clean, no NEW mypy errors.

- [ ] **Step 3: Report**

Summarize per-repo: commits made, test results (exact counts), any baseline failures observed and why they're pre-existing. Do NOT push.

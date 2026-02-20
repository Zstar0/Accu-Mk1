# Phase 5: SENAITE Sample Lookup - Context

**Gathered:** 2026-02-20
**Status:** Ready for planning

<domain>
## Phase Boundary

Extend wizard step 1 (Sample Info) with a SENAITE lookup flow: tech types a sample ID, app retrieves sample details from SENAITE REST API, and fields auto-populate in a read-only summary card. Manual entry remains available at all times as a parallel mode. Stock prep, dilution, and results steps are unchanged.

</domain>

<decisions>
## Implementation Decisions

### Search Trigger & Flow
- Search field + "Look up" button — deliberate trigger, not as-you-type
- On success: display a read-only summary card (matching how step 1 already behaves after session creation)
- Target conc/vol fields appear below/after the summary card — tech still enters these manually
- Backend hits SENAITE REST API directly via httpx (`http://senaite:8080/senaite/@@API/senaite/v1/AnalysisRequest?id={id}&complete=yes`)
- Auth via HTTP Basic (SENAITE_USER / SENAITE_PASSWORD env vars)

### Manual Entry Fallback
- Always visible — toggle between "SENAITE Lookup" and "Manual Entry" tabs/buttons in step 1
- Tech can choose manual from the start without attempting a search
- If tech switches to manual after a successful lookup: **clear everything, start fresh** (no pre-fill from lookup data)

### Error & Unavailability States
- Differentiate errors with distinct messages:
  - Sample not found (SENAITE returned 0 results): "Sample [ID] not found in SENAITE"
  - SENAITE unreachable / timeout / 5xx: "SENAITE is currently unavailable — use manual entry"
- No background connectivity check on wizard load — errors appear only when "Look up" is clicked

### Blend Samples (Multi-Analyte)
- SENAITE samples can have up to 4 analytes (Analyte1Peptide → Analyte4Peptide)
- Pull all non-null analyte fields and display all analyte names in the summary card
- For each analyte: attempt fuzzy match to local peptides table (see Field Mapping below)
- Physical prep process (stock prep, dilution) is unchanged — still one vial
- Step 4 (peak area / HPLC results) stays single-peak for now — multi-peak blend results are a future phase

### Field Mapping
- **Sample ID**: `id` field (e.g., `P-0112`) — used as-is for `sample_id_label` in the session
- **Declared weight**: `DeclaredTotalQuantity` — decimal string (e.g., `"123.00"`), convert to float
  - If null/empty: populate what we have, leave declared_weight_mg blank for tech to fill in manually
- **Peptide name(s)**: `Analyte1Peptide` through `Analyte4Peptide`, each formatted as `"BPC-157 - Identity (HPLC)"`
  - Strip trailing ` - Identity (HPLC)` and similar ` - [method]` suffixes
  - Attempt case-insensitive fuzzy match against local `peptides.name` column
  - If matched: auto-select the local peptide (populates `peptide_id` in session creation)
  - If no match: display the raw SENAITE name as informational text, tech selects from local dropdown
- `Analyte1DeclaredQuantity` is always null — do NOT use this field

### SENAITE Configuration
- `SENAITE_URL` env var — base URL (default: `http://senaite:8080`)
- `SENAITE_USER` / `SENAITE_PASSWORD` env vars — Basic auth credentials
- If `SENAITE_URL` not set: Lookup tab is hidden or disabled; step 1 shows manual form directly

### Claude's Discretion
- Exact fuzzy matching algorithm (e.g., startswith, contains, or Levenshtein distance)
- Styling/layout of the two-tab / toggle UI in step 1
- Loading spinner behavior during SENAITE fetch
- How blend analytes are displayed in the summary card (list vs. inline)
- SENAITE timeout value

</decisions>

<specifics>
## Specific Ideas

- SENAITE API endpoint confirmed working: `GET /senaite/@@API/senaite/v1/AnalysisRequest?id={id}&complete=yes`
- Auth: HTTP Basic with admin credentials (test: admin / MGrHgmqR3hD2EHWEnPpw)
- Backend (`accu-mk1-backend`) is already on the `senaite_default` Docker network — can reach `http://senaite:8080` directly
- Test samples in local SENAITE: P-0112 (BPC-157, weight 123mg), P-0086 (AOD-9604, weight null), PB-0059 (BPC-157, blend prefix PB-)
- The read-only summary card after lookup should mirror the existing session-created display in Step1SampleInfo

</specifics>

<deferred>
## Deferred Ideas

- Multi-peak results handling for blend samples (Step 4 HPLC results with one peak area per analyte) — future phase
- Real-time SENAITE status indicator on wizard load — deferred, on-demand errors only for now

</deferred>

---

*Phase: 05-senaite-sample-lookup*
*Context gathered: 2026-02-20*

# Changelog

## v0.10.0 — 2026-02-13

### Added

- **In Progress tab** in Order Explorer — shows samples awaiting COA publication with sample name, identity, lot code, SENAITE ID, and delivery/COA status
- **COA Explorer** — new standalone view for browsing COA generations across all orders, accessible from the sidebar
- **`sample_results` field** now returned from backend explorer orders endpoint, fixing the always-empty "Sample IDs" column in the orders table
- **`navigateToOrderExplorer()`** store action for cross-section navigation to Order Explorer
- **Integration Service network** added to Docker Compose for backend-to-Integration Service connectivity
- **`INTEGRATION_SERVICE_URL`** env var for proxying explorer requests

### Changed

- **Ingestions tab renamed** to "COAs Published" across all UI text (tab, loading, error, and empty states)
- **Order Explorer subtitle** updated from "Browse orders and ingestions" to "Browse orders and COAs"
- **AccuMark Tools** section refactored to route between Order Explorer and COA Explorer sub-sections

### Fixed

- **Sample IDs column** in orders table now shows SENAITE IDs (was always empty because `sample_results` wasn't queried from the database)

## v0.9.0 — 2026-02-11

Calibration accuracy fixes, SharePoint reliability, analysis UX.

## v0.8.0 — 2026-02-05

Dashboard, Peptide Config UI overhaul, SharePoint improvements.

## v0.7.0

Docker deployment + production hosting.

## v0.6.0

JWT user authentication system.

## v0.5.0

HPLC peptide analysis pipeline.

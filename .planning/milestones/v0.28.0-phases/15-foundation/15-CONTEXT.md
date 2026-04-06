# Phase 15: Foundation - Context

**Gathered:** 2026-03-31
**Status:** Ready for planning

<domain>
## Phase Boundary

Admins can define service groups that classify analysis services by discipline (e.g., "Core HPLC", "Microbiology"), users can view and assign SENAITE analysts, and the Worksheets section is accessible in the sidebar under HPLC Automation. This phase delivers the data model, admin UI, and nav wiring that Phase 16 (Inbox) depends on.

</domain>

<decisions>
## Implementation Decisions

### Service Group Admin Placement
- **D-01:** Service Groups management lives as a new sub-item under the existing **LIMS** nav section (alongside Instruments, Methods, Peptides, Analysis Services) — NOT as a tab on AnalysisServicesPage. Service groups are a cross-cutting admin concept, not specific to viewing analysis services.
- **D-02:** Admin UI uses the same table + slide-out detail panel pattern established by AnalysisServicesPage, InstrumentsPage, and MethodsPage.
- **D-03:** Group membership editor uses a checkbox list of analysis services in the slide-out panel, similar to how peptide-method associations work.

### Group Color System
- **D-04:** Predefined color palette (8-10 named colors) stored as string keys (e.g., "blue", "amber", "emerald", "red", "violet", "zinc", "rose", "sky"). Maps to Tailwind badge variant classes. No free-form color picker — keeps visual consistency across inbox and worksheets.
- **D-05:** Color preview shown as a small swatch/badge in the service groups table and in the slide-out editor.

### Navigation Wiring
- **D-06:** Worksheets pages are sub-items under the existing `hplc-analysis` section in the sidebar (per user spec: "under HPLC Automation"). New sub-items: "Inbox" (received samples queue), "Worksheets" (worksheets list).
- **D-07:** New type `WorksheetSubSection` added to ui-store.ts. HPLCAnalysisSubSection expanded with `'inbox' | 'worksheets' | 'worksheet-detail'`.
- **D-08:** Hash navigation extended in hash-navigation.ts to support the new sub-sections.

### SENAITE Analyst Assignment
- **D-09:** Analyst assignment endpoint follows the exact same httpx pattern as method-instrument assignment (main.py lines ~9892-9950): `POST /senaite/@@API/senaite/v1/update/{uid}` with `{"Analyst": value}`.
- **D-10:** Phase 15 includes a test/verification step to confirm whether SENAITE's Analyst field accepts a username string (e.g., "lab_tech_1") or requires a UID. This is tested before any bulk flows are built.
- **D-11:** GET analysts endpoint queries SENAITE's lab contacts: `GET /senaite/@@API/senaite/v1/LabContact?complete=yes` (or similar). Returns a list of `{username, fullname}` for dropdown population.

### Service Groups Data Model
- **D-12:** `service_groups` table: id, name (unique), description (nullable), color (string key from predefined palette), sort_order (integer), created_at, updated_at.
- **D-13:** `service_group_members` association table: id, service_group_id FK (cascade delete), analysis_service_id FK (cascade delete), unique constraint on (service_group_id, analysis_service_id).
- **D-14:** Uses the same SQLAlchemy pattern as existing `peptide_methods` M2M junction table (models.py lines 164-172).

### Claude's Discretion
- Exact slide-out panel layout and field ordering for service group editor
- Loading/error state patterns (follow existing AnalysisServicesPage patterns)
- Exact icon choice for Worksheets nav items
- Whether to add a "Service Groups" sub-item to LIMS or make it a section within the existing Analysis Services page

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Existing admin page patterns
- `src/components/hplc/AnalysisServicesPage.tsx` — Table + slide-out detail panel pattern to replicate
- `src/components/hplc/InstrumentsPage.tsx` — Another admin table with slide-out; similar CRUD pattern
- `src/components/hplc/MethodsPage.tsx` — Admin table pattern with detail view

### Navigation and routing
- `src/store/ui-store.ts` — ActiveSection, sub-section types, navigateTo pattern
- `src/lib/hash-navigation.ts` — Hash-based routing, VALID_SECTIONS
- `src/components/layout/AppSidebar.tsx` — Sidebar nav item structure (lines 75-118)
- `src/components/layout/MainWindowContent.tsx` — Section switch/routing

### Data model patterns
- `backend/models.py` — All existing SQLAlchemy models; see `peptide_methods` M2M pattern (lines 164-172), AnalysisService model (lines 140-161)
- `backend/main.py` — SENAITE update pattern (lines ~9892-9950), SENAITE auth pattern (`_get_senaite_auth`)

### API client
- `src/lib/api.ts` — All TypeScript types and API functions; add new service group + analyst functions here

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `AnalysisServicesPage.tsx`: Table + search + slide-out panel pattern — replicate for service groups admin
- `Badge` component (`@/components/ui/badge`): Used throughout for status badges — extend with color variants for service groups
- `Table` components: shadcn/ui table primitives already in use across all admin pages
- `toast` from sonner: All admin pages use toast notifications for success/error feedback
- `Checkbox` component: Available in shadcn/ui, use for service membership editor

### Established Patterns
- **Admin pages**: useState for local state, useCallback for data loading, useEffect for initial load. No TanStack Query on admin pages (they use direct fetch + setState).
- **SENAITE integration**: httpx AsyncClient with `_get_senaite_auth(current_user)`, timeout config, error handling with specific exception types.
- **M2M associations**: `peptide_methods` table pattern — junction table with FKs and unique constraint.
- **Nav structure**: Sections are string union types in ui-store.ts, sidebar items are array objects with id/label/icon/subItems.

### Integration Points
- `ui-store.ts`: Add new sub-section types to HPLCAnalysisSubSection union
- `hash-navigation.ts`: Add new section-subsection mappings to VALID_SECTIONS
- `AppSidebar.tsx`: Add Inbox and Worksheets to hplc-analysis subItems array
- `MainWindowContent.tsx`: Add case for worksheet sub-sections to render new components
- `models.py`: Add ServiceGroup and ServiceGroupMember models below AnalysisService
- `main.py`: Add service group CRUD endpoints and analyst assignment endpoints
- `api.ts`: Add TypeScript types and fetch functions for all new endpoints

</code_context>

<specifics>
## Specific Ideas

- User explicitly requested `/ui-ux-pro-max` skill for designing all worksheet screens — applies to service group admin UI in this phase too
- Service group colors should be the same ones used as badges in the inbox (Phase 16) — design once, reuse everywhere
- "Core HPLC" and "Microbiology" are the primary service group examples from the spec
- SENAITE Analyst field format verification is the #1 risk item — must be resolved in this phase before Phase 16 builds bulk flows

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 15-foundation*
*Context gathered: 2026-03-31*

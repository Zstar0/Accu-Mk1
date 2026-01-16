# Requirements: Accu-Mk1

**Defined:** 2026-01-15
**Core Value:** Streamlined morning workflow: import CSV → review batch → calculate purity → push to SENAITE

## v1 Requirements

Requirements for initial release. Each maps to roadmap phases.

### File Import

- [ ] **IMPORT-01**: System watches configured local directory for new CSV/Excel files
- [ ] **IMPORT-02**: System imports all detected files as single batch
- [ ] **IMPORT-03**: System caches raw files for audit trail
- [ ] **IMPORT-04**: User can manually browse and select files as fallback

### Calculations

- [ ] **CALC-01**: System calculates purity % using linear equation (serial dilution)
- [ ] **CALC-02**: System extracts and displays retention times from HPLC data
- [ ] **CALC-03**: System identifies compounds by matching retention times to configured ranges
- [ ] **CALC-04**: System logs calculation inputs/outputs for audit trail

### Settings

- [ ] **SETTINGS-01**: User can configure compound retention time ranges in app settings
- [ ] **SETTINGS-02**: User can configure watched directory path

### Review

- [ ] **REVIEW-01**: User can view all samples in batch with calculated results (purity, retention time, compound ID)
- [ ] **REVIEW-02**: User can approve individual samples
- [ ] **REVIEW-03**: User can reject individual samples with reason/comment
- [ ] **REVIEW-04**: User can filter and sort samples in batch view

### SENAITE Integration

- [ ] **SENAITE-01**: User can push approved results to SENAITE
- [ ] **SENAITE-02**: System updates existing SENAITE samples (not create new)
- [ ] **SENAITE-03**: User can see sync status (success/failure) per sample

### Infrastructure

- [ ] **INFRA-01**: App runs in browser at localhost for development/testing
- [ ] **INFRA-02**: App packages as Tauri desktop application
- [ ] **INFRA-03**: App uses SQLite database for jobs, results, logs
- [ ] **INFRA-04**: System maintains full audit trail of all operations

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Calculations

- **CALC-05**: Pluggable architecture for additional calculations

### SENAITE Integration

- **SENAITE-04**: Retry failed pushes

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Direct instrument control | App processes exports, doesn't talk to instruments |
| Multi-user authentication | Single-operator workstation model |
| Cloud hosting | Local-first architecture only |
| Complex calculation UI | Backend owns all scientific logic |

## Traceability

Which phases cover which requirements. Updated by create-roadmap.

| Requirement | Phase | Status |
|-------------|-------|--------|
| IMPORT-01 | Phase 2 | Complete |
| IMPORT-02 | Phase 2 | Complete |
| IMPORT-03 | Phase 2 | Complete |
| IMPORT-04 | Phase 2 | Complete |
| CALC-01 | Phase 2 | Complete |
| CALC-02 | Phase 2 | Complete |
| CALC-03 | Phase 2 | Complete |
| CALC-04 | Phase 2 | Complete |
| SETTINGS-01 | Phase 2 | Complete |
| SETTINGS-02 | Phase 2 | Complete |
| REVIEW-01 | Phase 3 | Pending |
| REVIEW-02 | Phase 3 | Pending |
| REVIEW-03 | Phase 3 | Pending |
| REVIEW-04 | Phase 3 | Pending |
| SENAITE-01 | Phase 4 | Pending |
| SENAITE-02 | Phase 4 | Pending |
| SENAITE-03 | Phase 4 | Pending |
| INFRA-01 | Phase 1 | Complete |
| INFRA-02 | Phase 1 | Complete |
| INFRA-03 | Phase 1 | Complete |
| INFRA-04 | Phase 1 | Complete |

**Coverage:**
- v1 requirements: 21 total
- Mapped to phases: 21
- Unmapped: 0 ✓

---
*Requirements defined: 2026-01-15*
*Last updated: 2026-01-16 after Phase 2 completion*

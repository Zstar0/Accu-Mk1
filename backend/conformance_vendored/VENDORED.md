# Vendored: COA Builder conformance engine

**Source repo:** coabuilder
**Source commit:** 2c95762279b613be28d35a891f822b6e04a71e0c (v2.14.8)
**Copied:** 2026-07-15
**Files (verbatim copies):** conformance.py, generic_assay_engine.py, addon_parsing.py, baked_specs.py

## Rules
- MIRROR-ONLY. Never edit these files in place. To update, re-copy from the
  source repo at a known commit and bump the commit/version above.
- The engine is pure stdlib (re, logging, typing, datetime). It must stay
  dependency-free — do not add imports.
- The Mk1 input adapter lives OUTSIDE this package (backend/conformance/).
  The vendored files are byte-identical to source; all Mk1-specific glue is
  in the adapter so parity with the COA is auditable.

## Why vendored (not a COA Builder API call)
Removes the cross-service JWT handshake; lands the engine where the full
spec-validation migration is headed. Guarded by two tests:
- test_conformance_parity.py — vendored engine reproduces a frozen golden.
- test_conformance_input_adapter.py — the adapter feeds the engine the exact
  SENAITE shape it expects (Result/Keyword/Unit/... keys).

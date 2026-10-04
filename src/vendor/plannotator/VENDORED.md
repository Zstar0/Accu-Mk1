# Vendored from backnotprop/plannotator

Upstream: https://github.com/backnotprop/plannotator at tag `v0.27.25`
(commit `c9c8cbbb96572fee9520baf776fbbc9c017b7946`; `@plannotator/ui` 0.49.0, `@plannotator/core` 0.25.9).
License: MIT (see LICENSE-MIT here). Upstream is dual MIT OR Apache-2.0; we take MIT.

| file | upstream path |
|---|---|
| bridge-script.ts | packages/ui/components/html-viewer/bridge-script.ts |
| html-anchor.ts | packages/core/html-anchor.ts |
| srcdoc.ts | packages/ui/components/html-viewer/srcdoc.ts |
| __tests__/html-anchor.test.ts | packages/core/html-anchor.test.ts (bun:test -> vitest) |
| image-annotator/* | packages/ui/components/ImageAnnotator/* |

## Local changes

Every change is fenced `// accumark: <name>` … `// /accumark`. Diff against upstream
by copying the upstream file over and `git diff`.

- srcdoc.ts `url-only`: the inline-script branch and the BRIDGE_SCRIPT import are
  removed so the 185 KB literal tree-shakes out of the app bundle; the bridge is
  always loaded by URL (spec §7.2).
- srcdoc.ts `csp-restore`: `META_CSP_RE` and the placeholder string are exported so
  the parent's stripViewerInjection restores an author CSP `<meta>` on save.
- bridge-script.ts: `headings` extension (Task 9, present: heading feed plus minted `pn-h-N` ids, fenced `// accumark: headings`).
- bridge-script.ts `edit-mode`: set-edit-mode / serialize / apply-replacement handlers and the two selection gates (Task 18).
- image-annotator/index.tsx `local-shortcuts`: upstream imported ../../shortcuts,
  which is not vendored; a local keydown handler provides 1/2/3, Mod+Z,
  Mod+Shift+Z, Esc. `overlay-class`: `pn-visible-viewport-overlay` -> `fixed inset-0`.
- image-annotator/Toolbar.tsx `save-colour`: `bg-success text-success-foreground`
  (not in Mk1's theme) -> `bg-primary text-primary-foreground`.
- image-annotator/utils.ts and Toolbar.tsx `index-cast`: `as` casts on array-index
  reads so the files pass Mk1's `noUncheckedIndexedAccess` (5 tsc errors, no behaviour change).
- All vendored files were normalised CRLF -> LF (repo is LF; upstream clone was checked out CRLF).
- __tests__/html-anchor.test.ts: import source only.

Frozen at this tag. `BRIDGE_PROTOCOL_VERSION` is the drift check; the parent refuses
a bridge reporting another version.

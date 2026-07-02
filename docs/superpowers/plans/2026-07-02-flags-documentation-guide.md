# Flags Documentation Guide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a self-contained Flags user guide (HTML) built from markdown, linked from the Flags flyout header — a third instance of the existing SOP-guide pattern.

**Architecture:** Author markdown in `docs/guides/`, build to self-contained HTML via the existing `docs/guides/_build_html.py` (mirrors into `public/guides/`), and add a new-tab `<a>` link (`HelpCircle` + "Guide") to both header variants of `FlagsFlyout.tsx` via a small local `GuideLink` component.

**Tech Stack:** Markdown + Python `markdown` (build), React + TypeScript, lucide-react, Vitest. **npm only.**

## Global Constraints

- **Frontend + docs only.** No backend, API, or migration change.
- **Mirror the existing SOP guides exactly:** markdown source in `docs/guides/`, built by `docs/guides/_build_html.py` to self-contained HTML in `docs/guides/` **and** `public/guides/`; linked via `<a target="_blank" rel="noopener noreferrer">` + `HelpCircle`, styled `inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground shrink-0`.
- Guide slug: `flags-system-guide` → served at `/guides/flags-system-guide.html`.
- Authoring conventions (from the build script + existing guides): first line `# <Title>` (becomes `<title>`); `##`/`###` sections; `>` blockquotes for callouts; pipe tables; `<!-- screenshot: … -->` markers as editor hints (stripped at render). Practical, second-person tone.
- Commit the `.md` source **and** both generated `.html` files (as the existing guides are tracked).

---

### Task 1: Author + build the Flags guide

**Files:**
- Create: `docs/guides/flags-system-guide.md` (source)
- Generated (by the build script): `docs/guides/flags-system-guide.html`, `public/guides/flags-system-guide.html`

**Interfaces:**
- Produces: the static asset `/guides/flags-system-guide.html` that Task 2 links to.

- [ ] **Step 1: Write the guide markdown**

Create `docs/guides/flags-system-guide.md` starting with `# Flags — User Guide` and covering these sections (practical second-person tone, matching `front-desk-sample-check-in.md`), using `>` callouts, pipe tables, and `<!-- screenshot: … -->` hints where a screenshot would help:

1. **At a glance** — a flag is a mini-ticket on a work item (sample/vial/worksheet); Issue vs Signal; why it beats Slack.
2. **Anatomy of a flag** — title, type, assignee, watchers, status, threaded comments, the entity it's on.
3. **Raising a flag** — from an entity's flag button or the flyout **Add Flag** (context-scoped); choosing type; "raise another".
4. **Assigning & watchers** — assign to a person; watchers = creator / assignee / @mentioned; who gets notified.
5. **The status lifecycle** — a table: Open → In Progress → Blocked → Resolved → Closed (meaning + when to use).
6. **Comments & @mentions** — threaded discussion; `@name` adds a watcher; system/audit lines in the thread.
7. **The Flags flyout** — the header button + unread pulse; tabs (Assigned to me / Raised by me / Watching / All open / Activity / Unread); list vs table; filter bar; unread markers.
8. **Flags on your work** — flag button/indicator on Sample Details (aggregates vials), vial rows, worksheet drawer, Order/Customer views; count badge; multiple flags per item.
9. **Slack DM notifications** — brief: opt-in per-user at **Account → Profile**; category toggles; test-DM button; watchers get no live toasts by design.
10. **For admins — managing flag types** — **Preferences → Flags** pane: create/edit/deactivate types, per-entity scope, blocking status; deactivate-not-delete for audit integrity.
11. **Tips & etiquette** — resolve when done; use Signal for "ready for verification"; don't over-flag.

- [ ] **Step 2: Build the HTML**

Ensure `markdown` is installed (`python -c "import markdown"`; if missing, `pip install markdown`). Then:

Run: `python docs/guides/_build_html.py`
Expected: prints `wrote docs/guides/flags-system-guide.html` (among the existing guides).

- [ ] **Step 3: Verify the generated HTML**

Run: `python -c "p=open('public/guides/flags-system-guide.html',encoding='utf-8').read(); assert '<title>Flags' in p and '<style>' in p and 'Status lifecycle' in p or 'lifecycle' in p.lower(); print('ok', len(p), 'bytes')"`
Expected: `ok <n> bytes` — the file exists at `public/guides/`, is self-contained (`<style>`), and has the derived `<title>`.

- [ ] **Step 4: Commit**

```bash
git add docs/guides/flags-system-guide.md docs/guides/flags-system-guide.html public/guides/flags-system-guide.html
git commit -m "docs(flags): Flags user guide (markdown + built HTML)"
```

---

### Task 2: Link the guide from the Flags flyout header

**Files:**
- Modify: `src/components/flags/FlagsFlyout.tsx` (import `HelpCircle`; add a `GuideLink` component; render it in both header variants)
- Test: `src/components/flags/__tests__/FlagsFlyout.test.tsx` (extend)

**Interfaces:**
- Consumes: the static asset `/guides/flags-system-guide.html` from Task 1.

- [ ] **Step 1: Write the failing test**

Add to `src/components/flags/__tests__/FlagsFlyout.test.tsx` (inside the existing `describe`) a test asserting the guide link renders with the right href + new-tab attrs. Match the file's existing render/mock setup (open the flyout first if needed):

```tsx
it('shows a link to the Flags guide in the header', async () => {
  const { FlagsFlyout } = await import('@/components/flags/FlagsFlyout')
  render(<FlagsFlyout />)
  const link = await screen.findByRole('link', { name: /guide/i })
  expect(link).toHaveAttribute('href', '/guides/flags-system-guide.html')
  expect(link).toHaveAttribute('target', '_blank')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/flags/__tests__/FlagsFlyout.test.tsx -t "Flags guide"`
Expected: FAIL — no link named "guide".

- [ ] **Step 3: Add the `GuideLink` component + import**

In `src/components/flags/FlagsFlyout.tsx`:

1. Add `HelpCircle` to the lucide import (line 2):
```tsx
import { Flag, HelpCircle, List, Plus, Table2, X } from 'lucide-react'
```
2. Add a module-level component (near the other small local components, e.g. above the main `FlagsFlyout` export):
```tsx
function GuideLink() {
  return (
    <a
      href="/guides/flags-system-guide.html"
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground shrink-0"
      title="Open the Flags guide in a new tab"
    >
      <HelpCircle className="size-3.5" aria-hidden="true" />
      Guide
    </a>
  )
}
```
3. Render `<GuideLink />` as the first child of the **scoped** header's action cluster (the `<div className="flex shrink-0 items-center gap-1.5">`, currently ~line 232), before `<ViewToggle …>`.
4. Render `<GuideLink />` as the first child of the **default** header's action cluster (the `<div className="flex items-center gap-1.5">`, currently ~line 268), before the `{!isActivity && …}` ViewToggle block.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/flags/__tests__/FlagsFlyout.test.tsx -t "Flags guide"`
Expected: PASS. (If the flyout needs to be opened first, set the store's `flagsFlyoutOpen` in the test the same way the file's other tests do.)

- [ ] **Step 5: Full gate**

Run: `npx vitest run src/components/flags && npx tsc --noEmit && npx prettier --check "src/components/flags/FlagsFlyout.tsx" && npx eslint src/components/flags/FlagsFlyout.tsx && npm run build`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/components/flags/FlagsFlyout.tsx src/components/flags/__tests__/FlagsFlyout.test.tsx
git commit -m "feat(flags): link the Flags guide from the flyout header"
```

---

## Self-Review

- **Spec coverage:** mechanics/build ✓ Task 1; content sections ✓ Task 1 (all 11 from the spec); link in both header variants ✓ Task 2; wiring test ✓ Task 2; build verify ✓ Task 1 Step 3; gates ✓ Task 2 Step 5.
- **Placeholders:** none — the guide prose is authored to the spec's fixed section list (content authoring, not code logic); all code steps show full code.
- **Type consistency:** `GuideLink` component + `/guides/flags-system-guide.html` slug used identically across Task 1 (asset) and Task 2 (link/test).

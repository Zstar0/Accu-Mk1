# Internal Remarks Amber Note Treatment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Internal Remarks posts on Sample Details a warm amber "internal note" look (the Flags guide's callout color scheme) with an "internal only" caption, via a new presentational `InternalRemarkCard`.

**Architecture:** Extract the inline remark card from the giant `SampleDetails.tsx` into a small, self-contained `InternalRemarkCard` component taking primitive props (so it has no dependency on `SampleDetails` internals and is unit-testable), then swap the inline block for it.

**Tech Stack:** React + TypeScript, Tailwind, DOMPurify, lucide-react, Vitest.

## Global Constraints

- **Frontend-only.** No backend, API, or data change.
- **Color scheme = the Flags guide callouts (exact):** card `rounded-lg border-l-4 border-amber-500 bg-amber-100 p-3 dark:border-amber-600 dark:bg-[#3f2f0c]`; text `text-amber-900 dark:text-amber-200`; muted amber `text-amber-700 dark:text-amber-300/80`.
- Preserve the current DOMPurify allow-list: tags `a b i em strong br p span`, attrs `href target rel class`.
- Caption copy: **"Internal — not shared with the customer"** with an `EyeOff` icon.

---

### Task 1: `InternalRemarkCard` component

**Files:**
- Create: `src/components/senaite/InternalRemarkCard.tsx`
- Test: `src/components/senaite/__tests__/InternalRemarkCard.test.tsx`

**Interfaces:**
- Produces: `export function InternalRemarkCard(props: { author: string; createdLabel: string; content: string })`.

- [ ] **Step 1: Write the failing test**

Create `src/components/senaite/__tests__/InternalRemarkCard.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { InternalRemarkCard } from '@/components/senaite/InternalRemarkCard'

describe('InternalRemarkCard', () => {
  it('renders author, date, sanitized body, and the internal-only caption', () => {
    render(
      <InternalRemarkCard
        author="42"
        createdLabel="Jul 2, 26 3:00 PM"
        content={
          '<b>Bold</b> and <a href="https://x.test">a link</a><script>alert(1)</script>'
        }
      />
    )
    expect(screen.getByText('42')).toBeInTheDocument()
    expect(screen.getByText('Jul 2, 26 3:00 PM')).toBeInTheDocument()
    expect(screen.getByText('Bold')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'a link' })).toHaveAttribute(
      'href',
      'https://x.test'
    )
    expect(
      screen.getByText(/not shared with the customer/i)
    ).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/senaite/__tests__/InternalRemarkCard.test.tsx`
Expected: FAIL — cannot resolve `@/components/senaite/InternalRemarkCard`.

- [ ] **Step 3: Write the component**

Create `src/components/senaite/InternalRemarkCard.tsx`:

```tsx
import DOMPurify from 'dompurify'
import { EyeOff, User } from 'lucide-react'

interface InternalRemarkCardProps {
  author: string
  createdLabel: string
  content: string
}

const ALLOWED_TAGS = ['a', 'b', 'i', 'em', 'strong', 'br', 'p', 'span']
const ALLOWED_ATTR = ['href', 'target', 'rel', 'class']

/** A single lab-internal remark, styled as a warm amber "internal note" (the
 *  Flags guide callout scheme) with an explicit not-shared-with-customer
 *  caption. Presentational — the caller formats the date and passes primitives. */
export function InternalRemarkCard({
  author,
  createdLabel,
  content,
}: InternalRemarkCardProps) {
  return (
    <div className="rounded-lg border-l-4 border-amber-500 bg-amber-100 p-3 dark:border-amber-600 dark:bg-[#3f2f0c]">
      <div className="mb-1.5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-5 w-5 items-center justify-center rounded-full bg-amber-200 dark:bg-amber-800/40">
            <User size={11} className="text-amber-700 dark:text-amber-300" />
          </div>
          <span className="text-xs font-medium text-amber-900 dark:text-amber-200">
            {author}
          </span>
        </div>
        <span className="text-[11px] text-amber-700 dark:text-amber-300/80">
          {createdLabel}
        </span>
      </div>
      <p
        className="pl-7 text-sm text-amber-900 dark:text-amber-200 [&_a]:text-blue-700 [&_a]:underline dark:[&_a]:text-blue-400"
        dangerouslySetInnerHTML={{
          __html: DOMPurify.sanitize(content, {
            ALLOWED_TAGS,
            ALLOWED_ATTR,
          }),
        }}
      />
      <div className="mt-1.5 flex items-center gap-1 pl-7 text-[11px] text-amber-700 dark:text-amber-300/80">
        <EyeOff size={11} aria-hidden="true" />
        Internal — not shared with the customer
      </div>
    </div>
  )
}

export default InternalRemarkCard
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/senaite/__tests__/InternalRemarkCard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/senaite/InternalRemarkCard.tsx src/components/senaite/__tests__/InternalRemarkCard.test.tsx
git commit -m "feat(remarks): InternalRemarkCard amber internal-note component"
```

---

### Task 2: Wire `InternalRemarkCard` into SampleDetails

**Files:**
- Modify: `src/components/senaite/SampleDetails.tsx` (import + swap the inline remark block, ~lines 5520-5557)

**Interfaces:**
- Consumes: `InternalRemarkCard` from Task 1; existing `formatDate`, `data.remarks`.

- [ ] **Step 1: Add the import**

Near the other `@/components/senaite/...` imports (or with the local imports) in `SampleDetails.tsx`, add:
```tsx
import { InternalRemarkCard } from '@/components/senaite/InternalRemarkCard'
```

- [ ] **Step 2: Replace the inline remark card**

Replace the inline `<div>` inside `data.remarks.map((r, i) => ( … ))` — the whole block currently at ~5521-5556:
```tsx
                <div
                  key={`${r.user_id}-${r.created}-${i}`}
                  className="p-3 rounded-lg bg-muted/40 border border-border/30"
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2">
                      <div className="w-5 h-5 rounded-full bg-muted flex items-center justify-center">
                        <User size={11} className="text-muted-foreground" />
                      </div>
                      <span className="text-xs font-medium text-foreground">
                        {r.user_id ?? 'System'}
                      </span>
                    </div>
                    <span className="text-[11px] text-muted-foreground">
                      {formatDate(r.created)}
                    </span>
                  </div>
                  <p
                    className="text-sm text-muted-foreground pl-7 [&_a]:text-blue-700 dark:[&_a]:text-blue-400 [&_a]:underline"
                    dangerouslySetInnerHTML={{
                      __html: DOMPurify.sanitize(r.content, {
                        ALLOWED_TAGS: [
                          'a',
                          'b',
                          'i',
                          'em',
                          'strong',
                          'br',
                          'p',
                          'span',
                        ],
                        ALLOWED_ATTR: ['href', 'target', 'rel', 'class'],
                      }),
                    }}
                  />
                </div>
```
with:
```tsx
                <InternalRemarkCard
                  key={`${r.user_id}-${r.created}-${i}`}
                  author={String(r.user_id ?? 'System')}
                  createdLabel={formatDate(r.created)}
                  content={r.content}
                />
```

- [ ] **Step 3: Verify no now-unused imports**

Run: `npx eslint src/components/senaite/SampleDetails.tsx 2>&1 | grep -iE "is defined but never used|no-unused" || echo "no unused-import errors"`
Expected: `no unused-import errors`. (`User` and `DOMPurify` are used elsewhere in this large file, so they stay. If eslint reports one now-unused, remove only that symbol from its import.)

- [ ] **Step 4: Full gate**

Run: `npx vitest run src/components/senaite && npx tsc --noEmit && npx prettier --check "src/components/senaite/InternalRemarkCard.tsx" "src/components/senaite/__tests__/InternalRemarkCard.test.tsx" "src/components/senaite/SampleDetails.tsx" && npx eslint src/components/senaite/InternalRemarkCard.tsx src/components/senaite/SampleDetails.tsx && npm run build`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/components/senaite/SampleDetails.tsx
git commit -m "feat(remarks): render Internal Remarks as amber internal notes on Sample Details"
```

---

## Self-Review

- **Spec coverage:** amber color scheme ✓ Task 1 (exact guide callout classes); left-border accent ✓; caption ✓ Task 1; presentational extraction w/ primitive props ✓ Task 1; DOMPurify allow-list preserved ✓ Task 1; wiring + passing `formatDate(r.created)` ✓ Task 2; test ✓ Task 1; gates ✓ Task 2 Step 4.
- **Placeholders:** none — full component + test + exact replacement block shown.
- **Type consistency:** `InternalRemarkCard({ author, createdLabel, content })` identical in the component, the test, and the Task 2 call site.

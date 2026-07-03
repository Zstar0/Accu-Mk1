# Flags Documentation Guide

*Design spec — 2026-07-02*

## Purpose

Give lab staff a polished, self-contained **Flags user guide**, linked from the Flags flyout header — a third instance of the existing SOP-guide pattern (Check-In SOP, Worksheets SOP). It explains what flags are and how to use every part of the Flag System, so the feature is discoverable and self-service.

## Scope

Frontend + docs only. No backend, API, or migration change. New branch off master (Mk1 1.0.17); ships as a future 1.0.18.

## Mechanics — mirror the existing SOP guides exactly

The pattern is already established and repeatable (verified against `docs/guides/_build_html.py` + the two existing guides):

1. **Author** `docs/guides/flags-system-guide.md` — markdown, first line `# <Title>` (becomes the page `<title>`). Conventions match the existing guides: `##`/`###` sections, `>` blockquotes for callouts (rendered as amber boxes), pipe tables, and `<!-- screenshot: … -->` markers as editor hints (stripped at render).
2. **Build** with `python docs/guides/_build_html.py` (needs `pip install markdown`) → emits a self-contained HTML (inline CSS, shared blue-accent theme, auto light/dark, print styles) to **both** `docs/guides/flags-system-guide.html` and `public/guides/flags-system-guide.html`.
3. **Serve** — Vite copies `public/` verbatim, so the guide is reachable at `/guides/flags-system-guide.html` in dev and prod.
4. **Commit** the `.md` source and both generated `.html` files (matching how the existing guides are tracked).

## Link placement

In `src/components/flags/FlagsFlyout.tsx`, add a guide link to the header — a plain new-tab anchor (no modal/iframe → no z-index conflict with the Radix `Sheet`), styled like the existing SOP anchors:

```tsx
<a
  href="/guides/flags-system-guide.html"
  target="_blank"
  rel="noopener noreferrer"
  className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0"
  title="Open the Flags guide in a new tab"
>
  <HelpCircle className="size-3.5" aria-hidden="true" />
  Guide
</a>
```

`HelpCircle` matches the other SOP links. The flyout has **two** header variants — the default header (right-side action cluster) and the entity-scoped header. Add the link to **both** so it's always reachable. Import `HelpCircle` from `lucide-react`.

## Guide content (sections)

Practical, second-person, lab-staff tone (matching the Check-In guide). Sections:

1. **At a glance** — what a flag is (a mini-ticket on a work item), Issue vs Signal, why it beats Slack for lab coordination.
2. **Anatomy of a flag** — title, type, assignee, watchers, status, threaded comments, the entity it's attached to.
3. **Raising a flag** — from a sample/vial/worksheet flag button, or the flyout **Add Flag** (context-scoped); choosing type; the multi-flag "raise another" affordance.
4. **Assigning & watchers** — assign to a person; watchers (creator, assignee, @mentioned); who sees what.
5. **The status lifecycle** — Open → In Progress → Blocked → Resolved → Closed (a table of what each means and when to use it); Blocked as a first-class state.
6. **Comments & @mentions** — threaded discussion; `@name` pulls someone in as a watcher; the system/audit lines woven into the thread.
7. **The Flags flyout** — opening it (the header button + unread pulse); the tabs (Assigned to me / Raised by me / Watching / All open / Activity / Unread); list vs table view; the filter bar; unread markers.
8. **Flags on your work** — the flag button/indicator on Sample Details (aggregates its vials), vial rows, worksheet drawer, and the Order/Customer views; the count badge; multiple flags per item.
9. **Slack DM notifications** — **on by default for every user (opt-out)**, including watcher-activity; auto-linked by email match (alias domains cover mixed-domain staff), manual member-ID fallback + test-DM at **Account → Profile**; the five category toggles. (The "no notification for watchers" rule is in-app toasts only, NOT DMs.)
10. **For admins — managing flag types** — **Preferences → Flags** pane: create/edit/deactivate types, per-entity scope, the blocking flag; deactivate-not-delete for audit integrity.
11. **Tips & etiquette** — short: resolve when done, use Signal for "ready for verification", don't over-flag.

Screenshot markers (`<!-- screenshot: … -->`) placed where a future screenshot would help (flyout, raise dialog, entity button) — they're editor hints and don't render.

## Testing

- **Wiring:** a vitest asserting `FlagsFlyout` renders the guide link with `href="/guides/flags-system-guide.html"` and `target="_blank"` (in the default header; scoped header covered by the same anchor).
- **Build:** run `_build_html.py`; confirm `public/guides/flags-system-guide.html` is emitted, is valid self-contained HTML (has `<title>` from the h1), and the app link resolves (200 in a running stack / opens the file).

## Files

- **New:** `docs/guides/flags-system-guide.md`, `docs/guides/flags-system-guide.html` (generated), `public/guides/flags-system-guide.html` (generated).
- **Edit:** `src/components/flags/FlagsFlyout.tsx` (import `HelpCircle`; add the anchor to both header variants), `src/components/flags/__tests__/FlagsFlyout.test.tsx` (create or extend — assert the link).
- **No change:** `_build_html.py`, backend, migrations.

## Verification

`npx tsc --noEmit`, the flags vitest, `npm run build`, prettier + eslint — all green. PR held for sign-off (never auto-merge).

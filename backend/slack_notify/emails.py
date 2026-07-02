"""Email candidate generation for Slack member lookup.

Lab logins and Slack profiles can use different aliased domains on the same
O365 inbox (e.g. forrest@valenceanalytical.com vs forrest@accumarklabs.com).
When the login email misses, retry the same local-part on the other known
alias domains. Safe because the domains alias ONE inbox → same person; the
"Linked → {name}" confidence line in the UI catches any mismap.

Configured by MK1_SLACK_EMAIL_ALIAS_DOMAINS (comma-separated). Empty/unset =
no swap (single lookup + manual member-ID fallback).
"""
from __future__ import annotations

import os


def alias_domains_from_env() -> list[str]:
    raw = os.getenv("MK1_SLACK_EMAIL_ALIAS_DOMAINS", "")
    return [d.strip().lower() for d in raw.split(",") if d.strip()]


def candidate_emails(login_email: str, alias_domains: list[str]) -> list[str]:
    """[login_email, then the same local-part on each OTHER alias domain].

    No swap when the login domain isn't in the alias set (or the set is empty),
    so an off-list address (a personal gmail) is never rewritten.
    """
    out = [login_email]
    if "@" not in login_email or not alias_domains:
        return out
    local, _, domain = login_email.rpartition("@")
    if domain.lower() not in alias_domains:
        return out
    for d in alias_domains:
        if d != domain.lower():
            cand = f"{local}@{d}"
            if cand not in out:
                out.append(cand)
    return out

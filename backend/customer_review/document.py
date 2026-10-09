"""AI review as a document (spec 2026-10-09 section 3.3): metrics, escaped HTML, publish."""
from __future__ import annotations

import os
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from html import escape
from typing import Any

SPACE_SLUG = "customer-reviews"
SPACE_NAME = "Customer reviews"
CATEGORY_NAME = "Customer review"
CATEGORY_PREFIX = "CR"
SENTIMENT = {-2: "Very negative", -1: "Negative", 0: "Neutral", 1: "Positive", 2: "Very positive"}
THEME_LABEL = {"turnaround": "Turnaround", "coa_quality": "COA quality", "communication": "Communication",
               "billing": "Billing", "other": "Other"}
SEVERITY_ORDER = {"high": 0, "medium": 1, "low": 2}


def _e(v: Any) -> str:
    return escape(str(v if v is not None else ""), quote=True)


def _base() -> str:
    return os.environ.get("MK1_PUBLIC_URL", "https://accumk1.valenceanalytical.com").rstrip("/")


def link_for(c: dict) -> str | None:
    kind = c.get("kind")
    if kind == "ticket":
        url = ((c.get("thread") or {}).get("plain_url") or "")
        return url if url.startswith("https://") else None
    if kind == "crm":
        lead = (c.get("item") or {}).get("lead_id")
        return f"https://app.close.com/lead/{lead}/" if lead else None
    if kind == "sample":
        return f"{_base()}/#dashboard/sample-details?id={c.get('id')}"
    if kind == "order" and c.get("order_id"):
        return f"{_base()}/#accumark-tools/order-explorer?id={c['order_id']}"
    return None


def _pct(v: float | None) -> str:
    return f"{round(v * 100)}%" if isinstance(v, (int, float)) else "n/a"


def metrics(d: dict | None) -> list[dict]:
    if not d:
        return []
    k = d.get("kpis") or {}
    cards = []
    try:  # money rounds half up (Python's format rounds half to even: $33,012.50 -> $33,012)
        lifetime = f"${Decimal(str(k.get('lifetime') or 0)).quantize(Decimal('1'), ROUND_HALF_UP):,}"
    except (InvalidOperation, TypeError, ValueError):
        lifetime = "n/a"
    cards.append({"label": "Lifetime spend", "value": lifetime,
                  "note": f"rank {k['rank']} of {k['customers']}" if k.get("rank") and k.get("customers") else None})
    delta = d.get("spend_delta_pct")
    cards.append({"label": "Spend vs prior", "value": (("+" if delta > 0 else "") + _pct(delta)) if isinstance(delta, (int, float)) else "n/a",
                  "tone": "bad" if isinstance(delta, (int, float)) and delta < -0.1 else None})
    cards.append({"label": "On time", "value": _pct(k.get("on_time_rate")),
                  "note": f"lab {_pct(k.get('lab_on_time_rate'))}" if k.get("lab_on_time_rate") is not None else None})
    days = d.get("days_since_last")
    gap = k.get("usual_gap_days")
    cards.append({"label": "Last order", "value": f"{round(days)} days" if isinstance(days, (int, float)) else "n/a",
                  "note": f"usual gap {round(gap)} days" if isinstance(gap, (int, float)) else None})
    return cards


_CSS = """
.cr-head{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:6px}
.cr-chip{display:inline-block;padding:1px 10px;border-radius:999px;font-size:12px}
.cr-bad{background:#fcebeb;color:#a32d2d}.cr-warn{background:#faeeda;color:#854f0b}
.cr-ok{background:#eaf3de;color:#3b6d11}.cr-muted{color:#6b6b6b;font-size:13px}
.cr-headline{font-family:Georgia,serif;font-size:19px;line-height:1.6;margin:14px 0 18px}
.cr-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:22px}
.cr-card{border:1px solid #e5e3dc;border-radius:10px;padding:10px 12px}
.cr-card .v{font-size:22px;font-weight:600}.cr-card .v.bad{color:#a32d2d}.cr-card .l{font-size:12px;color:#6b6b6b}
.cr-issues{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px;margin-bottom:22px}
.cr-issue{border:1px solid #e5e3dc;border-left:4px solid #b4b2a9;padding:10px 12px}
.cr-issue.high{border-left-color:#e24b4a}.cr-issue.medium{border-left-color:#ef9f27}
.cr-issue h4{margin:4px 0;font-size:15px}.cr-issue p{margin:4px 0 6px;font-size:14px}
.cr-cite{display:inline-block;margin:2px 4px 0 0;padding:0 8px;border-radius:999px;background:#e6f1fb;color:#0c447c;font-size:12px;text-decoration:none}
.cr-list{list-style:none;padding:0;margin:0 0 20px}.cr-list li{padding:8px 0;border-bottom:1px solid #eeece6}
.cr-theme{font-size:11px;color:#6b6b6b;text-transform:uppercase;letter-spacing:.04em}
.cr-foot{margin-top:24px;font-size:12px;color:#6b6b6b}
"""


def _cites(cs: list[dict]) -> str:
    out = []
    for c in cs or []:
        url = link_for(c)
        label = _e(c.get("label") or c.get("id"))
        out.append(f'<a class="cr-cite" href="{_e(url)}" target="_blank" rel="noopener">{label}</a>' if url
                   else f'<span class="cr-cite">{label}</span>')
    return "".join(out)


def _sev_chip(sev: str) -> str:
    cls = {"high": "cr-bad", "medium": "cr-warn"}.get(sev, "cr-ok")
    return f'<span class="cr-chip {cls}">{_e(sev.capitalize())}</span>'


def render_html(review: dict, *, customer_name: str, customer_key: str, generated_at: str, model: str,
                lookups: int, cost_usd: float, metric_cards: list[dict]) -> str:
    s = review.get("sentiment") or {}
    score = s.get("score", 0)
    tone = "cr-bad" if score < 0 else ("cr-ok" if score > 0 else "")
    parts = [f"<style>{_CSS}</style>",
             f'<h1>{_e(customer_name)}</h1>',
             '<div class="cr-head">'
             f'<span class="cr-chip {tone}">{_e(SENTIMENT.get(score, "Neutral"))} · {_e(s.get("trend", ""))}</span>'
             f'<span class="cr-muted">AI review · {_e(customer_key)} · generated {_e(generated_at[:10])}</span></div>',
             f'<p class="cr-headline">{_e(review.get("headline"))}</p>']
    if metric_cards:
        cards = []
        for c in metric_cards:
            value_cls = "v bad" if c.get("tone") == "bad" else "v"
            note = f'<div class="l">{_e(c["note"])}</div>' if c.get("note") else ""
            cards.append(f'<div class="cr-card"><div class="l">{_e(c["label"])}</div>'
                         f'<div class="{value_cls}">{_e(c["value"])}</div>{note}</div>')
        parts.append('<div class="cr-cards">' + "".join(cards) + "</div>")
    issues = sorted(review.get("open_issues") or [], key=lambda i: SEVERITY_ORDER.get(i.get("severity"), 1))
    parts.append("<h2>Needs attention</h2>")
    parts.append('<div class="cr-issues">' + "".join(
        f'<div class="cr-issue {_e(i.get("severity"))}">{_sev_chip(i.get("severity", "medium"))}'
        f'<h4>{_e(i["title"])}</h4><p>{_e(i.get("detail"))}</p>{_cites(i.get("citations"))}</div>'
        for i in issues) + "</div>" if issues else '<p class="cr-muted">No open issues found.</p>')
    parts.append("<h2>Where we fell short</h2>")
    falls = sorted(review.get("shortfalls") or [], key=lambda i: (i.get("theme", "other"), SEVERITY_ORDER.get(i.get("severity"), 1)))
    parts.append('<ul class="cr-list">' + "".join(
        f'<li><div class="cr-theme">{_e(THEME_LABEL.get(i.get("theme"), "Other"))} · {_e(i.get("severity", "medium"))}</div>'
        f'<strong>{_e(i["title"])}</strong> {_e(i.get("detail"))} {_cites(i.get("citations"))}</li>'
        for i in falls) + "</ul>" if falls else '<p class="cr-muted">Nothing found.</p>')
    for heading, key, mark in (("Next steps", "next_steps", "&#9744;"), ("Going well", "strengths", "&#10003;")):
        rows = review.get(key) or []
        parts.append(f"<h2>{heading}</h2>")
        parts.append('<ul class="cr-list">' + "".join(
            f'<li>{mark} <strong>{_e(i["title"])}</strong> {_e(i.get("detail"))} {_cites(i.get("citations"))}</li>'
            for i in rows) + "</ul>" if rows else '<p class="cr-muted">None.</p>')
    parts.append(f'<p class="cr-muted">Sentiment: {_e(s.get("reason"))} {_cites(s.get("citations"))}</p>')
    parts.append(f'<p class="cr-foot">Generated by {_e(model)} from {_e(lookups)} lookups (${_e(f"{cost_usd:.2f}")}). '
                 "Findings cite what the agent read; verify before acting.</p>")
    return "<!doctype html><html><head><meta charset=\"utf-8\"></head><body>" + "".join(parts) + "</body></html>"

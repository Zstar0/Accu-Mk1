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


def _sources(cs: list[dict], lead: str = "") -> str:
    """The guide's idiom for references: a small .where line of teal links, no pills."""
    out = []
    for c in cs or []:
        url = link_for(c)
        label = _e(c.get("label") or c.get("id"))
        out.append(f'<a href="{_e(url)}" target="_blank" rel="noopener">{label}</a>' if url else label)
    if not out and not lead:
        return ""
    body = " &nbsp;·&nbsp; ".join(out)
    return f'<span class="where">{_e(lead)}{" &nbsp;·&nbsp; " if lead and out else ""}{"Source: " + body if out else ""}</span>'


_NOTE_FOR = {"high": "note stop", "medium": "note warn", "low": "note"}


def render_html(review: dict, *, customer_name: str, customer_key: str, generated_at: str, model: str,
                lookups: int, cost_usd: float, metric_cards: list[dict]) -> str:
    """The review as an accumark-docs v2 page. Markup only: the server inlines the theme, so the page carries
    no CSS of its own. Every string from the model or the data sources goes through _e()."""
    s = review.get("sentiment") or {}
    score = s.get("score", 0)
    parts = ['<main>', '<header class="top">',
             '<p class="eyebrow">Accumark Labs · AI review</p>',
             f'<h1>{_e(customer_name)}</h1>',
             f'<p class="lede">{_e(review.get("headline"))}</p>',
             '<ul class="meta">'
             f'<li><b>Sentiment</b> {_e(SENTIMENT.get(score, "Neutral"))} · {_e(s.get("trend", ""))}</li>'
             f'<li><b>Customer</b> {_e(customer_key)}</li>'
             f'<li><b>Generated</b> {_e(generated_at[:10])}</li>'
             f'<li><b>Model</b> {_e(model)}</li></ul>',
             '</header>']
    if metric_cards:
        cards = [f'<div class="path-card"><span class="k">{_e(c["label"])}</span><h3>{_e(c["value"])}</h3>'
                 + (f'<p>{_e(c["note"])}</p>' if c.get("note") else "") + "</div>" for c in metric_cards]
        parts.append(f'<section><h2>At a glance</h2><div class="paths">{"".join(cards)}</div></section>')

    issues = sorted(review.get("open_issues") or [], key=lambda i: SEVERITY_ORDER.get(i.get("severity"), 1))
    parts.append("<section><h2>Needs attention</h2>")
    if issues:
        for i in issues:
            sev = i.get("severity", "medium")
            parts.append(f'<div class="{_NOTE_FOR.get(sev, "note")}"><strong>{_e(sev.capitalize())} · {_e(i["title"])}</strong>'
                         f'<span>{_e(i.get("detail"))}</span>{_sources(i.get("citations"))}</div>')
    else:
        parts.append("<p>No open issues found.</p>")
    parts.append("</section>")

    parts.append("<section><h2>Where we fell short</h2>")
    falls = review.get("shortfalls") or []
    if falls:
        for theme in THEME_LABEL:
            rows = sorted((f for f in falls if f.get("theme", "other") == theme),
                          key=lambda f: SEVERITY_ORDER.get(f.get("severity"), 1))
            if not rows:
                continue
            parts.append(f"<h3>{_e(THEME_LABEL[theme])}</h3><ul>")
            for f in rows:
                sev = f.get("severity", "medium")
                parts.append(f'<li><b>{_e(f["title"])}</b> {_e(f.get("detail"))} '
                             f'{_sources(f.get("citations"), lead=sev.capitalize())}</li>')
            parts.append("</ul>")
    else:
        parts.append("<p>Nothing found.</p>")
    parts.append("</section>")

    steps = review.get("next_steps") or []
    parts.append("<section><h2>Next steps</h2>")
    parts.append('<ul class="check">' + "".join(
        f'<li><b>{_e(n["title"])}</b> {_e(n.get("detail"))} {_sources(n.get("citations"))}</li>' for n in steps)
        + "</ul>" if steps else "<p>None.</p>")
    parts.append("</section>")

    wins = review.get("strengths") or []
    parts.append("<section><h2>Going well</h2>")
    parts.append('<div class="note ok"><strong>What is working</strong><ul>' + "".join(
        f'<li><b>{_e(w["title"])}</b> {_e(w.get("detail"))} {_sources(w.get("citations"))}</li>' for w in wins)
        + "</ul></div>" if wins else "<p>None recorded.</p>")
    parts.append("</section>")

    parts.append(f'<section><h2>Why this sentiment</h2><p>{_e(s.get("reason"))}</p>{_sources(s.get("citations"))}</section>')
    parts.append(f'<footer>Generated by {_e(model)} from {_e(lookups)} lookups (${_e(f"{cost_usd:.2f}")}). '
                 "Every finding cites what the agent read; check the source before acting on it.</footer>")
    parts.append("</main>")
    return ("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>"
            + _e(f"Customer review: {customer_name}") + "</title></head><body>" + "".join(parts) + "</body></html>")


def ensure_space_and_category(db):
    from sqlalchemy import select

    from documents.models import DocumentCategory, DocumentSpace
    from documents.service import create_category, create_space
    space = db.execute(select(DocumentSpace).where(DocumentSpace.slug == SPACE_SLUG)).scalar_one_or_none()
    if space is None:
        space = create_space(db, slug=SPACE_SLUG, name=SPACE_NAME,
                             description="AI customer reviews, one document per customer", visibility="company")
    category = db.execute(select(DocumentCategory).where(DocumentCategory.code_prefix == CATEGORY_PREFIX)
                          ).scalar_one_or_none()
    if category is None:
        category = create_category(db, name=CATEGORY_NAME, code_prefix=CATEGORY_PREFIX,
                                   description="AI customer review")
    return space, category


def publish(db, *, review: dict, customer_key: str, customer_name: str, author: str | None, run_id: int,
            model: str, lookups: int, cost_usd: float, metric_cards: list[dict], code: str | None) -> tuple[int, str]:
    from datetime import datetime, timezone

    from documents.service import create_document
    space, category = ensure_space_and_category(db)
    html = render_html(review, customer_name=customer_name, customer_key=customer_key,
                       generated_at=datetime.now(timezone.utc).isoformat(), model=model, lookups=lookups,
                       cost_usd=cost_usd, metric_cards=metric_cards)
    doc, _created = create_document(
        db, title=f"Customer review: {customer_name}", html=html, category=category,
        description=f"AI review {_marker(customer_key)} · {model} · {lookups} lookups · ${cost_usd:.2f}",
        code=code, author=author, source_session=f"ai-review-run-{run_id}",
        space=None if code else space)  # a revision stays wherever an admin moved the document
    return doc.id, doc.code


def _marker(customer_key: str) -> str:
    return f"[{customer_key}]"


def existing_code(db, customer_key: str) -> str | None:
    """The customer's CR code from the documents themselves, for when the run row never recorded it."""
    from sqlalchemy import select

    from documents.models import Document
    return db.execute(select(Document.code).where(Document.code.like(f"{CATEGORY_PREFIX}-%"),
                                                  Document.description.contains(_marker(customer_key)))
                      .order_by(Document.id.desc()).limit(1)).scalar_one_or_none()

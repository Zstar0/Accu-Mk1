"""customer_review.document: escaped HTML report, metrics from the dossier, links per citation kind."""
from customer_review import document

REVIEW = {
    "headline": "Cooling off <script>alert(1)</script> & \"quoted\"",
    "sentiment": {"score": -1, "trend": "steady", "reason": "r", "citations": [], "unsupported": True},
    "open_issues": [
        {"title": "Low thing", "detail": "d", "severity": "low", "citations": [{"kind": "sample", "id": "P-1", "label": "P-1"}]},
        {"title": "High thing</div>", "detail": "<b>x</b>", "severity": "high",
         "citations": [{"kind": "ticket", "id": "T-9", "label": "T-9", "thread": {"plain_url": "https://app.plain.com/w/t/th_9"}}]}],
    "shortfalls": [{"title": "Slow COA", "detail": "d", "severity": "medium", "theme": "coa_quality",
                    "citations": [{"kind": "order", "id": "8642", "label": "Order 8642", "order_id": "501"}]}],
    "strengths": [{"title": "Fast replies", "detail": "", "citations": [{"kind": "crm", "id": "acti_1", "label": "Email",
                                                                         "item": {"lead_id": "lead_A"}}]}],
    "next_steps": [{"title": "Call them", "detail": "", "citations": []}],
}


def render(**kw):
    args = dict(customer_name="Triumphant <Labs>", customer_key="wc:1572", generated_at="2026-10-09T03:00:00Z",
                model="claude-sonnet-5-5", lookups=17, cost_usd=0.18, metric_cards=[{"label": "On time", "value": "56%"}])
    args.update(kw)
    return document.render_html(REVIEW, **args)


def test_model_text_is_escaped():
    html = render()
    assert "<script>" not in html and "&lt;script&gt;" in html
    assert "High thing&lt;/div&gt;" in html and "&lt;b&gt;x&lt;/b&gt;" in html
    assert "Triumphant &lt;Labs&gt;" in html and "&quot;quoted&quot;" in html


def test_sections_order_and_severity_sort():
    html = render()
    for heading in ("Needs attention", "Where we fell short", "Next steps", "Going well"):
        assert heading in html
    assert html.index("High thing") < html.index("Low thing")
    assert "COA quality" in html and "Negative" in html and "56%" in html


def test_links_per_kind(monkeypatch):
    monkeypatch.setenv("MK1_PUBLIC_URL", "https://mk1.example")
    assert document.link_for({"kind": "ticket", "thread": {"plain_url": "https://app.plain.com/w/t/th_9"}}) == "https://app.plain.com/w/t/th_9"
    assert document.link_for({"kind": "crm", "item": {"lead_id": "lead_A"}}) == "https://app.close.com/lead/lead_A/"
    assert document.link_for({"kind": "sample", "id": "P-1"}) == "https://mk1.example/#dashboard/sample-details?id=P-1"
    assert document.link_for({"kind": "order", "id": "8642", "order_id": "501"}) == "https://mk1.example/#accumark-tools/order-explorer?id=501"
    assert document.link_for({"kind": "crm", "item": {}}) is None
    assert document.link_for({"kind": "ticket", "thread": {"plain_url": "javascript:alert(1)"}}) is None


def test_metrics_from_dossier():
    d = {"kpis": {"lifetime": "33012.50", "rank": 7, "customers": 814, "on_time_rate": 0.56, "lab_on_time_rate": 0.58,
                  "usual_gap_days": 14.0},
         "spend_delta_pct": -0.65, "days_since_last": 27.2}
    cards = document.metrics(d)
    labels = [c["label"] for c in cards]
    assert labels == ["Lifetime spend", "Spend vs prior", "On time", "Last order"]
    assert cards[0]["value"] == "$33,013" and cards[0]["note"] == "rank 7 of 814"
    assert cards[1]["value"] == "-65%" and cards[1]["tone"] == "bad"
    assert cards[2]["value"] == "56%" and cards[2]["note"] == "lab 58%"
    assert cards[3]["value"] == "27 days" and cards[3]["note"] == "usual gap 14 days"
    assert document.metrics(None) == []


def test_uses_theme_v2_components_and_no_private_css():
    html = render()
    assert "<style" not in html, "the server-inlined theme styles the page; no private CSS"
    for marker in ('class="eyebrow"', 'class="lede"', 'class="meta"', 'class="kpis"', 'class="kpi"',
                   'class="note stop"', 'class="note ok"', 'class="check"', "<main"):
        assert marker in html, marker
    assert 'class="note stop"' in html and html.index('class="note stop"') < html.index("Low thing")

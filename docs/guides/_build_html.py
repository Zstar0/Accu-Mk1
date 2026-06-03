"""Convert the markdown guides in docs/guides/ to friendly self-contained HTML.

Run inside the backend container (has the markdown library installed):
    docker exec accumark-subvial-accu-mk1-backend python /app/../docs/guides/_build_html.py
Or from the host with markdown installed:
    python docs/guides/_build_html.py

Output: docs/guides/<name>.html for each .md file. Each output is a single self-
contained file with inline CSS so it can be emailed, dropped on SharePoint, or
served from any static host without dependencies.
"""
from __future__ import annotations

import html
import re
import sys
from pathlib import Path

try:
    import markdown
except ImportError:
    sys.stderr.write("Missing dependency: pip install markdown\n")
    sys.exit(2)


# Resolve paths whether the script is run from the repo root or from
# inside the docs/guides directory.
HERE = Path(__file__).resolve().parent
GUIDES_DIR = HERE if HERE.name == "guides" else HERE / "docs" / "guides"
# Also publish each HTML next to the static assets Vite serves at the
# webroot so the running app can deep-link to a guide (e.g. an SOP link
# inside the Receive Wizard). Vite copies files under `public/` verbatim
# into the build output, so `public/guides/<name>.html` is reachable at
# `/guides/<name>.html` in dev and prod.
REPO_ROOT = GUIDES_DIR.parent.parent
PUBLIC_GUIDES_DIR = REPO_ROOT / "public" / "guides"


def derive_title(md_path: Path, html_body: str) -> str:
    """Pull the first <h1> for the page title; fall back to the filename."""
    match = re.search(r"<h1[^>]*>(.*?)</h1>", html_body, re.IGNORECASE | re.DOTALL)
    if match:
        # Strip nested HTML and decode entities for the <title>
        bare = re.sub(r"<[^>]+>", "", match.group(1))
        return html.unescape(bare).strip()
    return md_path.stem.replace("-", " ").title()


CSS = """
:root {
  color-scheme: light dark;
  --bg: #fbfbfa;
  --fg: #1a1a1a;
  --muted: #5a5a5a;
  --border: #e0ddd6;
  --accent: #2563eb;        /* royal blue */
  --accent-soft: #dbeafe;
  --callout-bg: #fef3c7;    /* amber-100 */
  --callout-border: #f59e0b;
  --callout-fg: #78350f;
  --table-header-bg: #f3f1ec;
  --table-row-alt: #faf8f3;
  --code-bg: #f5f2eb;
  --kbd-bg: #ffffff;
  --kbd-border: #cbc7bd;
  --link: #1d4ed8;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #181816;
    --fg: #ededed;
    --muted: #a8a8a8;
    --border: #2e2c28;
    --accent: #60a5fa;
    --accent-soft: #1e3a8a;
    --callout-bg: #3f2f0c;
    --callout-border: #d97706;
    --callout-fg: #fde68a;
    --table-header-bg: #232220;
    --table-row-alt: #1f1e1c;
    --code-bg: #232220;
    --kbd-bg: #1f1e1c;
    --kbd-border: #3f3d38;
    --link: #93c5fd;
  }
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen,
    Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", sans-serif;
  font-size: 16px;
  line-height: 1.65;
}

main {
  max-width: 840px;
  margin: 0 auto;
  padding: 48px 28px 96px;
}

header.page {
  border-bottom: 1px solid var(--border);
  padding-bottom: 16px;
  margin-bottom: 36px;
}
header.page .kicker {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
  margin-bottom: 4px;
}

h1 {
  font-size: 32px;
  line-height: 1.2;
  margin: 0;
  font-weight: 700;
}

h2 {
  font-size: 22px;
  line-height: 1.3;
  margin: 40px 0 12px;
  font-weight: 700;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--border);
}

h3 {
  font-size: 18px;
  line-height: 1.4;
  margin: 28px 0 8px;
  font-weight: 600;
  color: var(--fg);
}

h4 {
  font-size: 15px;
  margin: 20px 0 6px;
  font-weight: 600;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

p { margin: 8px 0 12px; }

a {
  color: var(--link);
  text-decoration: underline;
  text-underline-offset: 2px;
  text-decoration-thickness: 1px;
}
a:hover { text-decoration-thickness: 2px; }

ul, ol { padding-left: 24px; margin: 8px 0 16px; }
li { margin: 4px 0; }
li > p { margin: 4px 0; }

blockquote {
  margin: 18px 0;
  padding: 14px 18px;
  background: var(--callout-bg);
  border-left: 4px solid var(--callout-border);
  color: var(--callout-fg);
  border-radius: 4px;
}
blockquote p:first-child { margin-top: 0; }
blockquote p:last-child { margin-bottom: 0; }
blockquote strong { color: var(--callout-fg); }
blockquote ul, blockquote ol { padding-left: 22px; }

code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono",
    monospace;
  font-size: 0.88em;
  background: var(--code-bg);
  padding: 1px 5px;
  border-radius: 3px;
  border: 1px solid var(--border);
}
pre {
  background: var(--code-bg);
  padding: 14px 16px;
  border-radius: 6px;
  border: 1px solid var(--border);
  overflow-x: auto;
  font-size: 13px;
}
pre code {
  background: transparent;
  padding: 0;
  border: 0;
}

kbd {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.85em;
  background: var(--kbd-bg);
  border: 1px solid var(--kbd-border);
  border-bottom-width: 2px;
  border-radius: 4px;
  padding: 1px 6px;
}

table {
  width: 100%;
  margin: 16px 0;
  border-collapse: collapse;
  font-size: 0.95em;
}
thead th {
  background: var(--table-header-bg);
  text-align: left;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  font-weight: 600;
}
tbody td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}
tbody tr:nth-child(even) td {
  background: var(--table-row-alt);
}

hr {
  border: 0;
  border-top: 1px solid var(--border);
  margin: 36px 0;
}

/* Inline screenshot placeholders rendered from HTML comments */
.screenshot-placeholder {
  display: block;
  margin: 14px 0;
  padding: 14px 18px;
  border: 1px dashed var(--border);
  border-radius: 6px;
  background: var(--accent-soft);
  color: var(--muted);
  font-size: 13px;
  font-style: italic;
}
.screenshot-placeholder::before {
  content: "Screenshot — ";
  font-weight: 600;
  font-style: normal;
}

footer.page {
  margin-top: 64px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
  color: var(--muted);
  font-size: 13px;
  display: flex;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

@media print {
  body { background: #fff; color: #000; }
  main { max-width: 100%; padding: 24px; }
  blockquote { background: #fff8e1; }
  .screenshot-placeholder { display: none; }
  a { color: #000; text-decoration: underline; }
}
"""

PAGE_TMPL = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title}</title>
  <style>{css}</style>
</head>
<body>
  <main>
    <header class="page">
      <div class="kicker">Accu-Mk1 user guide</div>
    </header>
    {body}
    <footer class="page">
      <span>Source: <code>{src_rel}</code></span>
      <span>Generated {generated_label}</span>
    </footer>
  </main>
</body>
</html>
"""


SCREENSHOT_RE = re.compile(r"<!--\s*screenshot:\s*(.*?)\s*-->", re.IGNORECASE | re.DOTALL)


def render_screenshots(html_body: str) -> str:
    """Strip `<!-- screenshot: ... -->` markers from the HTML output.

    The markers stay in the markdown source as editor hints — anyone updating
    the guide can see exactly where a screenshot belongs. But end readers
    shouldn't see "screenshot goes here" affordances in the published HTML,
    so we drop them at render time. A trailing newline cleanup avoids leaving
    a blank gap where the marker used to be."""
    return re.sub(r"\s*" + SCREENSHOT_RE.pattern + r"\s*", "\n\n", html_body, flags=re.IGNORECASE | re.DOTALL)


def convert(md_path: Path) -> Path:
    src = md_path.read_text(encoding="utf-8")
    body = markdown.markdown(
        src,
        extensions=[
            "extra",              # tables, fenced code, def lists
            "sane_lists",
            "smarty",
            "toc",
            "admonition",
        ],
        output_format="html5",
    )
    body = render_screenshots(body)
    title = derive_title(md_path, body)
    rendered = PAGE_TMPL.format(
        title=html.escape(title),
        css=CSS,
        body=body,
        src_rel=md_path.name,
        # Static label — workflows can't call Date.now(); keep this stable
        # across rebuilds. Edit by hand at release time if precise dating is
        # wanted.
        generated_label="from the latest markdown source",
    )
    out_path = md_path.with_suffix(".html")
    out_path.write_text(rendered, encoding="utf-8")
    # Mirror into public/guides/ so the running app can serve and deep-link.
    PUBLIC_GUIDES_DIR.mkdir(parents=True, exist_ok=True)
    public_path = PUBLIC_GUIDES_DIR / out_path.name
    public_path.write_text(rendered, encoding="utf-8")
    return out_path


def main() -> int:
    md_files = sorted(GUIDES_DIR.glob("*.md"))
    if not md_files:
        sys.stderr.write(f"No markdown files in {GUIDES_DIR}\n")
        return 1
    for md in md_files:
        if md.name.startswith("_"):
            continue
        out = convert(md)
        print(f"wrote {out.relative_to(out.parents[2])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

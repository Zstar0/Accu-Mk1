#!/usr/bin/env python3
"""Publish an HTML document to the Accu-Mk1 documents library (spec §6).

Usage:
  publish_document.py PAGE.html --title T --category ART [--description D]
      [--code ART-0012] [--author "Forrest Parker"] [--session ID] [--draft]
      [--effective YYYY-MM-DD] [--base-url URL]
      [--allow-secrets] [--dry-run]
  publish_document.py --self-test

Env: MK1_API_BASE_URL (e.g. http://100.73.137.3:5892), ACCUMK1_INTERNAL_SERVICE_TOKEN.
Exit: 0 ok · 1 HTTP/transport error · 2 secret-shaped content found · 3 usage/env error.
Stdlib only, on purpose: it must run from any checkout with no venv.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

# The house theme is inlined by the SERVER at create time (documents.service.inline_theme),
# so this script sends the page as written. Canonical file: backend/documents/accumark-docs.css.

# (label, pattern). Labels are printed; matched VALUES never are.
SECRET_PATTERNS = [
    ("aws access key", re.compile(r"AKIA[0-9A-Z]{16}")),
    ("stripe key", re.compile(r"sk_(?:live|test)_[0-9A-Za-z]{8,}")),
    ("private key block", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY")),
    ("github token", re.compile(r"ghp_[A-Za-z0-9]{36}")),
    ("slack token", re.compile(r"xox[abp]-[0-9A-Za-z-]{10,}")),
    ("bearer token", re.compile(r"Bearer [A-Za-z0-9._-]{20,}")),
    ("password assignment", re.compile(r"password\s*[:=]\s*\S+", re.IGNORECASE)),
]


def find_secrets(html: str) -> list[str]:
    return [label for label, rx in SECRET_PATTERNS if rx.search(html)]


def wrap_fragment(html: str) -> str:
    """Artifact-style fragments (no <html>) become a full document. A <title>
    in the fragment is hoisted into <head>; everything else stays in <body>."""
    if re.search(r"<html\b", html, re.IGNORECASE):
        return html
    title = ""
    m = re.search(r"<title>.*?</title>", html, re.IGNORECASE | re.DOTALL)
    if m:
        title = m.group(0)
        html = html.replace(title, "", 1)
    return ("<!doctype html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n"
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
            f"{title}\n</head>\n<body>\n{html}\n</body>\n</html>\n")



def post_document(base_url: str, token: str, payload: dict) -> dict:
    req = urllib.request.Request(
        f"{base_url.rstrip('/')}/api/documents",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "X-Service-Token": token},
        method="POST")
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def self_test() -> None:
    frag = "<title>T</title><style>.x{}</style><p>hi</p>"
    doc = wrap_fragment(frag)
    head = doc.split("</head>")[0]
    assert doc.startswith("<!doctype html>") and "<title>T</title>" in head, doc
    assert "<p>hi</p>" in doc.split("<body>")[1]
    assert wrap_fragment(doc) == doc, "full documents are left alone"
    assert find_secrets("key AKIAABCDEFGHIJKLMNOP here") == ["aws access key"]
    assert find_secrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123") == ["bearer token"]
    assert find_secrets("<p>password: hunter2</p>") == ["password assignment"]
    assert find_secrets(doc) == []
    print("self-test ok")


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Publish an HTML document to Accu-Mk1.")
    p.add_argument("file", nargs="?", help="HTML file (full document or artifact fragment)")
    p.add_argument("--title")
    p.add_argument("--category", help="category code prefix or name, e.g. ART or SOP")
    p.add_argument("--description")
    p.add_argument("--code", help="existing code => publishes the next revision")
    p.add_argument("--author", default=os.environ.get("MK1_DOC_AUTHOR"),
                   help="the person who instructed this document "
                        "(not the agent; provenance goes in --session)")
    p.add_argument("--session", default=os.environ.get("MK1_DOC_SESSION"),
                   help="provenance: the Claude Code session id")
    p.add_argument("--draft", action="store_true", help="publish as draft (activate=false)")
    p.add_argument("--effective", help="effective date YYYY-MM-DD")
    p.add_argument("--base-url", default=os.environ.get("MK1_API_BASE_URL"))
    p.add_argument("--allow-secrets", action="store_true")
    p.add_argument("--dry-run", action="store_true", help="print the payload summary, do not POST")
    p.add_argument("--self-test", action="store_true")
    args = p.parse_args(argv)

    if args.self_test:
        self_test()
        return 0
    if not args.file or not args.title or not args.category:
        p.print_usage(sys.stderr)
        print("file, --title and --category are required", file=sys.stderr)
        return 3

    src = Path(args.file)
    if not src.is_file():
        print(f"no such file: {src}", file=sys.stderr)
        return 3
    try:
        page = wrap_fragment(src.read_text(encoding="utf-8"))
    except UnicodeDecodeError:
        print(f"not valid UTF-8: {src}", file=sys.stderr)
        return 3

    found = find_secrets(page)
    if found and not args.allow_secrets:
        print("refusing to publish: secret-shaped content found (" + ", ".join(found) +
              "). Pass --allow-secrets only after a human has checked it.", file=sys.stderr)
        return 2

    html = page

    payload = {
        "title": args.title, "html": html, "category": args.category,
        "description": args.description, "code": args.code, "author": args.author,
        "source_session": args.session, "effective_date": args.effective,
        "activate": not args.draft,
    }
    if args.dry_run:
        summary = {k: v for k, v in payload.items() if k != "html"}
        summary["html_bytes"] = len(html.encode("utf-8"))
        print(json.dumps(summary, indent=2))
        return 0

    token = os.environ.get("ACCUMK1_INTERNAL_SERVICE_TOKEN")
    if not args.base_url or not token:
        print("MK1_API_BASE_URL (or --base-url) and ACCUMK1_INTERNAL_SERVICE_TOKEN must be set",
              file=sys.stderr)
        return 3
    try:
        doc = post_document(args.base_url, token, payload)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:500]
        print(f"publish failed: HTTP {e.code} {body}", file=sys.stderr)
        return 1
    except urllib.error.URLError as e:
        print(f"publish failed: {e.reason}", file=sys.stderr)
        return 1
    except (TimeoutError, OSError, json.JSONDecodeError) as e:
        print(f"publish failed: {type(e).__name__}: {e}", file=sys.stderr)
        return 1
    print(f"{doc['code']} r{doc['revision']} id={doc['id']} status={doc['status']}"
          f"  open: #reports/documents?id={doc['id']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

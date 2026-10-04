"""Anchor validation and quote verification (spec 2026-10-03 §5).

A Python port of the caps in src/vendor/plannotator/html-anchor.ts. Fail closed:
anything over a cap is a BadRequestError, never a silent truncation, so what is
stored is exactly what the viewer can read back.
"""
from __future__ import annotations

import json
import math
import re
from html import unescape
from html.parser import HTMLParser
from typing import Any, Optional

from documents.errors import BadRequestError

MAX_TEXT = 400
MAX_SELECTOR = 1024
MAX_TAG = 64
MAX_LABEL = 64
MAX_TARGETS = 16
MAX_CONTEXT_BYTES = 2048
MAX_ANCHOR_BYTES = 16 * 1024
CONTEXT_KEYS = frozenset({"tag", "id", "classes", "path", "role", "name", "attrs", "text",
                          "outline", "children", "rect", "landmark", "heading", "component",
                          "page"})
_WS = re.compile(r"\s+")


def _utf8_len(obj: Any) -> int:
    return len(json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def _text(value: Any, cap: int, field: str, *, required: bool) -> Optional[str]:
    if value is None:
        if required:
            raise BadRequestError(f"anchor.{field} is required")
        return None
    if not isinstance(value, str):
        raise BadRequestError(f"anchor.{field} must be a string")
    if len(value) > cap:
        raise BadRequestError(f"anchor.{field} is {len(value)} chars; the cap is {cap}")
    return value


def _point(value: Any) -> Optional[dict]:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise BadRequestError("anchor point must be an object")
    out = {}
    for k in ("x", "y"):
        v = value.get(k)
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
            raise BadRequestError(f"anchor point.{k} must be a finite number")
        out[k] = float(v)
    return out


def _element_anchor(value: Any, field: str = "htmlAnchor") -> dict:
    if not isinstance(value, dict):
        raise BadRequestError(f"anchor.{field} must be an object")
    selector = _text(value.get("selector"), MAX_SELECTOR, f"{field}.selector", required=True)
    tag = _text(value.get("tagName"), MAX_TAG, f"{field}.tagName", required=True)
    if not selector.strip() or not tag.strip():
        raise BadRequestError(f"anchor.{field} needs a selector and a tagName")
    out: dict = {"selector": selector, "tagName": tag}
    text = _text(value.get("text"), MAX_TEXT, f"{field}.text", required=False)
    if text is not None:
        out["text"] = text
    point = _point(value.get("point"))
    if point is not None:
        out["point"] = point
    return out


def _context(value: Any, field: str = "elementContext") -> dict:
    if not isinstance(value, dict):
        raise BadRequestError(f"anchor.{field} must be an object")
    out = {k: v for k, v in value.items() if k in CONTEXT_KEYS}
    size = _utf8_len(out)
    if size > MAX_CONTEXT_BYTES:
        raise BadRequestError(f"anchor.{field} is {size} bytes; the cap is {MAX_CONTEXT_BYTES}")
    return out


def _target(value: Any, i: int) -> dict:
    field = f"htmlAdditionalTargets[{i}]"
    if not isinstance(value, dict):
        raise BadRequestError(f"anchor.{field} must be an object")
    out: dict = {"text": _text(value.get("text"), MAX_TEXT, f"{field}.text", required=True)}
    label = _text(value.get("label"), MAX_LABEL, f"{field}.label", required=False)
    if label is not None:
        out["label"] = label
    if value.get("anchor") is not None:
        out["anchor"] = _element_anchor(value["anchor"], f"{field}.anchor")
    if value.get("context") is not None:
        out["context"] = _context(value["context"], f"{field}.context")
    return out


def validate_anchor(raw: Any) -> Optional[dict]:
    """None stays None (a document-level comment). Anything else must be a
    PersistedHtmlAnchor within every cap; unknown keys are dropped."""
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise BadRequestError("anchor must be an object or null")
    text = _text(raw.get("originalText"), MAX_TEXT, "originalText", required=True)
    out: dict = {"originalText": text}
    if raw.get("htmlAnchor") is not None:
        out["htmlAnchor"] = _element_anchor(raw["htmlAnchor"])
    targets = raw.get("htmlAdditionalTargets")
    if targets is not None:
        if not isinstance(targets, list):
            raise BadRequestError("anchor.htmlAdditionalTargets must be a list")
        if len(targets) > MAX_TARGETS:
            raise BadRequestError(
                f"anchor has {len(targets)} additional targets; the cap is {MAX_TARGETS}")
        out["htmlAdditionalTargets"] = [_target(t, i) for i, t in enumerate(targets)]
    if raw.get("elementContext") is not None:
        out["elementContext"] = _context(raw["elementContext"])
    if "htmlAnchor" not in out and not text.strip():
        raise BadRequestError("anchor needs quoted text or an element anchor")
    size = _utf8_len(out)
    if size > MAX_ANCHOR_BYTES:
        raise BadRequestError(f"anchor is {size} bytes; the cap is {MAX_ANCHOR_BYTES}")
    return out


def is_quote_only(anchor: Optional[dict]) -> bool:
    """True for an anchor that must be verified against the document text: a
    quote with no element anchor (the agent path, spec §5)."""
    return anchor is not None and "htmlAnchor" not in anchor


class _TextExtractor(HTMLParser):
    _SKIP = {"script", "style", "template", "noscript"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in self._SKIP:
            self._skip += 1

    def handle_endtag(self, tag):
        if tag in self._SKIP and self._skip:
            self._skip -= 1

    def handle_data(self, data):
        if not self._skip:
            self.parts.append(data)


def normalize(text: str) -> str:
    """Entities decoded, NBSP and every whitespace run collapsed to one space.
    Both sides of a comparison go through this, so what an agent read in
    rendered text matches the source however it was wrapped or escaped."""
    return _WS.sub(" ", unescape(text).replace("\xa0", " ")).strip()


def document_text(html: str) -> str:
    p = _TextExtractor()
    p.feed(html)
    p.close()
    return normalize("".join(p.parts))


def quote_occurs(quote: str, html: str) -> bool:
    q = normalize(quote)
    return bool(q) and q in document_text(html)

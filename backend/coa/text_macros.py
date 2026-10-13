"""COA text macros (endo slice 4, spec
docs/superpowers/specs/2026-10-13-endo-slice4-coa-text-macros-design.md).

An analysis profile's COA text (basis note, method, prep, footnote text) may
carry macros such as {lod}. Mk1 fills them from the section's results when it
builds the COA wire, so the PDF, the verify page and the badge print finished
text. A [ ... ] segment that holds a known macro disappears when any known
macro in it has no value. Text with no known macro is returned exactly as
typed, so every existing profile text is unchanged. Pure: no database."""
from __future__ import annotations

import math
import re
from typing import Iterable, Mapping, Optional

MACROS: tuple[str, ...] = ("lod",)

_MACRO = re.compile(r"\{([a-z_]+)\}")
# Any brace token, for save validation: {LOD} and { lod } are typos of {lod}.
_BRACE = re.compile(r"\{([^{}]*)\}")
_NAME = re.compile(r"[a-z_]+")
# A segment is a bracket pair with no bracket inside it, so segments never nest.
_SEGMENT = re.compile(r"\[([^\[\]]*)\]")
# One pass over a segment (group 1) or a bare macro (group 2), so a value that
# was just filled in is never scanned again: a value holding "{lod}" must not
# expand twice.
_PIECE = re.compile(_SEGMENT.pattern + "|" + _MACRO.pattern)
_SPACES = re.compile(r" {2,}")


def unknown_macros(text: Optional[str]) -> list[str]:
    """Brace tokens in text that Mk1 cannot fill, in order, each once: a
    lowercase name it does not know ("lot"), or a near miss of a known macro
    that only differs by case or spaces ("LOD", " lod "), reported as typed.
    Other brace text ({Upper}, {}) is allowed. resolve() leaves all of these
    as typed; this is for save validation."""
    out: list[str] = []
    for inner in _BRACE.findall(text or ""):
        if inner in MACROS or inner in out:
            continue
        if _NAME.fullmatch(inner) or inner.strip().lower() in MACROS:
            out.append(inner)
    return out


def format_number(v: float) -> str:
    """Up to 6 decimals, no trailing zeros, no exponent: 0.005, 0.05, 25."""
    s = f"{v:.6f}".rstrip("0").rstrip(".")
    return s if s not in ("", "-0") else "0"


def format_lod(limits: Iterable[tuple[Optional[float], Optional[str]]]) -> str:
    """The section's {lod}: each row's "<number> <unit>", distinct, in row
    order, joined with ", ". Rows without a finite LOD are skipped."""
    out: list[str] = []
    for value, unit in limits:
        if value is None or not math.isfinite(value):
            continue
        text = format_number(value)
        if unit and unit.strip():
            text = f"{text} {unit.strip()}"
        if text not in out:
            out.append(text)
    return ", ".join(out)


def _has_known_macro(text: str) -> bool:
    return any(name in MACROS for name in _MACRO.findall(text))


def unbalanced_brackets(text: Optional[str]) -> bool:
    """True when text holds a known macro and a [ or ] that is not part of an
    innermost [...] pair (an unclosed segment would print its bracket and drop
    nothing). Text with no known macro is never flagged. For save validation."""
    if not text or not _has_known_macro(text):
        return False
    rest = _SEGMENT.sub("", text)
    return "[" in rest or "]" in rest


def resolve(text: Optional[str], values: Mapping[str, str]) -> Optional[str]:
    """Fill known macros from values (a missing or empty value is empty),
    drop optional segments whose known macros are not all filled, and tidy
    spaces. Text with no known macro is returned exactly as typed; text that
    resolves to nothing becomes None."""
    if text is None or not _has_known_macro(text):
        return text

    def fill_name(name: str, typed: str) -> str:
        return (values.get(name) or "") if name in MACROS else typed

    def fill(m: re.Match) -> str:
        return fill_name(m.group(1), m.group(0))

    def piece(m: re.Match) -> str:
        if m.group(2) is not None:  # a bare macro; group 1 is a segment's inner text
            return fill_name(m.group(2), m.group(0))
        inner = m.group(1)
        names = [n for n in _MACRO.findall(inner) if n in MACROS]
        if not names:
            return m.group(0)
        if any(not values.get(n) for n in names):
            return ""
        return _MACRO.sub(fill, inner)

    out = _PIECE.sub(piece, text)
    out = "\n".join(_SPACES.sub(" ", line).strip() for line in out.split("\n")).strip()
    return out or None

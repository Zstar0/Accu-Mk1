"""Typed service exceptions; routes map them to HTTP codes (404/400/409)."""


class NotFoundError(LookupError):
    """Document or category not found."""


class BadRequestError(ValueError):
    """Structurally OK but semantically invalid input."""


class ConflictError(Exception):
    """Illegal state transition, duplicate, or referenced row."""

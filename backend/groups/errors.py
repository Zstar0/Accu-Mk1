"""Typed service exceptions for groups and boards; routes map them to HTTP codes."""


class NotFoundError(LookupError):
    """Group, board, node or edge not found (also used when the caller may not see it)."""


class BadRequestError(ValueError):
    """Structurally OK but semantically invalid input."""


class ConflictError(Exception):
    """Duplicate, referenced row, or stale version."""


class PermissionDeniedError(Exception):
    """Visible but not editable / not admin."""

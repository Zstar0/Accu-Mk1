"""Typed service exceptions; routes map them to HTTP codes."""


class NotFoundError(LookupError):
    """Flag (or related entity) not found."""


class BadRequestError(ValueError):
    """Structurally OK but semantically invalid."""


class PermissionDeniedError(Exception):
    """Caller lacks permission for the action."""


class ConflictError(Exception):
    """Illegal state transition or duplicate."""

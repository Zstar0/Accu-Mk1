"""Typed service exceptions; routes map them to HTTP codes (404/400/409)."""


class NotFoundError(LookupError):
    """Document or category not found."""


class BadRequestError(ValueError):
    """Structurally OK but semantically invalid input."""


class ConflictError(Exception):
    """Illegal state transition, duplicate, or referenced row."""


class DuplicateContentError(ConflictError):
    """New-code create whose stored (themed) bytes already exist in the category and space."""

    def __init__(self, message: str, document):
        super().__init__(message)
        self.document = document


class ForbiddenError(Exception):
    """The actor exists but may not do this (edit another author's comment, etc.)."""

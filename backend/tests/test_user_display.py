"""user_display_name: 'First Last' with single-name and email fallbacks."""
from types import SimpleNamespace

from users_display import user_display_name


def _u(first=None, last=None, email="x@lab.test"):
    return SimpleNamespace(first_name=first, last_name=last, email=email)


def test_both_names():
    assert user_display_name(_u("Ada", "Lovelace")) == "Ada Lovelace"


def test_first_only():
    assert user_display_name(_u(first="Ada")) == "Ada"


def test_last_only():
    assert user_display_name(_u(last="Lovelace")) == "Lovelace"


def test_neither_falls_back_to_email():
    assert user_display_name(_u(email="ada@lab.test")) == "ada@lab.test"


def test_whitespace_only_falls_back_to_email():
    assert user_display_name(_u(first="  ", last="\t", email="ada@lab.test")) == "ada@lab.test"


def test_strips_surrounding_whitespace():
    assert user_display_name(_u(first=" Ada ", last=" Lovelace ")) == "Ada Lovelace"


def test_none_user_returns_empty_string():
    assert user_display_name(None) == ""

from slack_notify.emails import candidate_emails


def test_original_first_then_alias_domains():
    out = candidate_emails("forrest@valenceanalytical.com",
                           ["accumarklabs.com", "valenceanalytical.com"])
    assert out == ["forrest@valenceanalytical.com",
                   "forrest@accumarklabs.com"]


def test_no_swap_when_login_domain_not_in_set():
    out = candidate_emails("bob@gmail.com",
                           ["accumarklabs.com", "valenceanalytical.com"])
    assert out == ["bob@gmail.com"]


def test_no_swap_when_alias_set_empty():
    assert candidate_emails("bob@lab.com", []) == ["bob@lab.com"]


def test_malformed_email_is_returned_unchanged():
    assert candidate_emails("not-an-email", ["lab.com"]) == ["not-an-email"]


def test_case_insensitive_domain_match_and_dedup():
    out = candidate_emails("A@Valence.COM",
                           ["valence.com", "accu.com", "accu.com"])
    assert out == ["A@Valence.COM", "A@accu.com"]

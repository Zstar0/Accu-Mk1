"""Test/QA customer emails excluded from reports and the inbox. One copy (was 2 in main.py)."""
# Lowercase. Also mirrored in the Integration Service (app/api/desktop.py) for the
# Customers list "hide test accounts" toggle; change both together.
TEST_EMAILS: frozenset[str] = frozenset({
    "forrestp@outlook.com",
    "forrest@valenceanalytical.com",
    "levi@valenceanalytical.com",  # Handler 2026-10-07: internal, $0 orders
    "drpeptide@harmonypeptide.com",  # Handler 2026-10-07: internal (Harmony Fried), $0 orders
})

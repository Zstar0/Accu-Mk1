"""Customer CRM tab (Close) definitions. Spec: docs/superpowers/specs/2026-10-07-customer-crm-tab-design.md."""
import re

KEPT_TYPES = {"Email": "email", "Call": "call", "SMS": "sms", "Meeting": "meeting", "Note": "note"}
AUTOMATED_SUBJECT = re.compile(r"^\[Accumark Labs\]: You've got a new order", re.I)
# Senders seen sending only system mail. Filled from live data (plan Task 6); lowercase.
AUTOMATED_SENDERS: frozenset[str] = frozenset()
PLAIN_URL = re.compile(r"https://app\.plain\.com/\S*?/thread/[A-Za-z0-9_]+/?")

MATCH_TTL = 3600
TIMELINE_TTL = 300
USERS_TTL = 3600
REFRESH_COOLDOWN = 10
PAGE_SIZE = 50
MAX_PAGE_SIZE = 200
PREVIEW_CHARS = 160

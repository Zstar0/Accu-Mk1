"""Customer CRM tab (Close) definitions. Spec: docs/superpowers/specs/2026-10-07-customer-crm-tab-design.md."""
import re

KEPT_TYPES = {"Email": "email", "Call": "call", "SMS": "sms", "Meeting": "meeting", "Note": "note"}
# WooCommerce admin notifications all carry this prefix (new order, failed, cancelled...).
# Replies start with "Re:" and stay visible. Live data 2026-10-07.
AUTOMATED_SUBJECT = re.compile(r"^\[Accumark Labs\]:", re.I)
# Senders that ONLY send system mail (lowercase). Empty on purpose: the order mails come from
# info@accumarklabs.com, which is also the shared inbox people reply from.
AUTOMATED_SENDERS: frozenset[str] = frozenset()
# Close email activity fields that mark sequence, bulk or AI-agent sends (Close email activity reference, 2026-10-19).
AUTOMATED_FIELDS: tuple[str, ...] = ("sequence_id", "sequence_subscription_id", "bulk_email_action_id", "agent_config_id")
PLAIN_URL = re.compile(r"https://app\.plain\.com/\S*?/thread/[A-Za-z0-9_]+/?")

MATCH_TTL = 3600
TIMELINE_TTL = 300
USERS_TTL = 3600
REFRESH_COOLDOWN = 10
PAGE_SIZE = 50
MAX_PAGE_SIZE = 200
PREVIEW_CHARS = 160

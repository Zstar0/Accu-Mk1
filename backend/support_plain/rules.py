"""Constants for the Support (Plain) tab (spec 3.2-3.5)."""
MATCH_TTL = 3600
LIST_TTL = 300
THREAD_TTL = 300
REFRESH_COOLDOWN = 10
PAGE_SIZE = 50
MAX_PAGE_SIZE = 200
PREVIEW_CHARS = 160
MAX_THREADS = 500
MAX_ENTRIES = 1000
STATUS = {"TODO": "open", "SNOOZED": "snoozed", "DONE": "done"}
PRIORITY = {0: "urgent", 1: "high", 2: "normal", 3: "low"}
THREAD_ID_PATTERN = r"^th_[A-Za-z0-9]+$"

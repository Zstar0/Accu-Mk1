"""Mk1 fixture backend for the Paperclip-app acceptance run (dev only).

REAL: the Mk1 FastAPI app (`main.app`): its /auth/login, auth dependency, documents routes,
service, access rules and filesystem storage. FIXTURE: a throwaway SQLite file and documents
dir under MK1_FIXTURE_DIR, one synthetic reader login, one restricted space with no grants.
`lifespan` is off (no init_db, no startup jobs); the Postgres URL points at a closed port so
any path that bypasses get_db fails instead of reaching a real database. No .env is read.
Secrets (JWT_SECRET, agent token, reader password, optional admin password) are generated per run
by the calling harness.
"""
import os
import sys
import types
from pathlib import Path

work = Path(os.environ["MK1_FIXTURE_DIR"])
for k in ("JWT_SECRET", "MK1_DOCUMENT_AGENT_TOKENS", "MK1_READER_PASSWORD"):
    assert os.environ.get(k), k
os.environ.update({"MK1_DB_HOST": "127.0.0.1", "MK1_DB_PORT": "9",
                   "MK1_DOCUMENTS_DIR": str(work / "documents")})
for k in ("MK1_PHOTO_S3_BUCKET", "MK1_DOCUMENTS_S3_PREFIX", "ACCUMK1_INTERNAL_SERVICE_TOKEN"):
    os.environ.pop(k, None)
dotenv = types.ModuleType("dotenv")
dotenv.load_dotenv = lambda *a, **k: False  # never read a .env from the tree
sys.modules["dotenv"] = dotenv
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))

import uvicorn  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402

import main  # noqa: E402
import models  # noqa: E402
import documents.models  # noqa: E402,F401
from auth import get_password_hash  # noqa: E402
from database import Base, get_db  # noqa: E402
from documents import service  # noqa: E402
from documents.models import DocumentSpace  # noqa: E402

engine = create_engine(f"sqlite:///{(work / 'mk1.db').as_posix()}",
                       connect_args={"check_same_thread": False})
Base.metadata.create_all(engine)
Session = sessionmaker(bind=engine)


def _db():
    s = Session()
    try:
        yield s
    finally:
        s.close()


main.app.dependency_overrides[get_db] = _db
with Session() as s:
    service.seed_categories(s)
    service.seed_spaces(s)
    s.add(DocumentSpace(slug="leadership", name="Leadership", visibility="restricted"))
    s.add(models.User(email="reader@example.test", role="standard", is_active=True,
                      hashed_password=get_password_hash(os.environ["MK1_READER_PASSWORD"])))
    if os.environ.get("MK1_FIXTURE_ADMIN_PASSWORD"):  # e2e/agents/agents-pane.mjs signs in as this admin
        s.add(models.User(email="admin@example.test", role="admin", is_active=True,
                          first_name="Ada", last_name="Admin",
                          hashed_password=get_password_hash(os.environ["MK1_FIXTURE_ADMIN_PASSWORD"])))
    s.commit()

uvicorn.run(main.app, host="127.0.0.1", port=8563, lifespan="off", log_level="warning")

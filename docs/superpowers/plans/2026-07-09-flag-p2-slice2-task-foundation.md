# Flag P2 Slice 2 — Task Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** General (entity-less) tasks, entity reference links, flag↔flag links, and due dates with overdue treatment.

**Architecture:** Relax the anchor (`flag_flags.entity_type/entity_id` nullable) instead of restructuring; two additive link tables render as navigational chips (NOT counted in rollups — spec §2 link model (b)); `due_at` is a plain nullable column with computed overdue. All migrations are idempotent SQL in `database.py`'s `_run_migrations` list (the codebase's established mechanism — no alembic in Mk1).

**Tech Stack:** FastAPI + SQLAlchemy + idempotent-DDL migrations; React/TS frontend. Spec: `docs/superpowers/specs/2026-07-09-flag-system-phase2-design.md` §5.

## Global Constraints

- **npm only**; no new frontend dependencies in this slice (native `<input type="date">` for due dates).
- **Additive only**; module purity (`backend/flags/` never imports host models; new host knowledge only via `seams.py` closures — none needed this slice).
- **Analytics readiness:** every mutation here emits `flag_events` (`due_set`/`due_changed`/`due_cleared`, `entity_link_added`/`entity_link_removed`, `flag_link_added`/`flag_link_removed`) with real `actor_id`.
- Links are **navigation only** — do NOT touch `EntityFlagButton` counts, `include_descendants` rollups, or `FlagIndicator` logic.
- **Depends on Slice 1** (`FlagFilterState` gained `assignee`; filter bar layout changed): branch `feat/flag-p2-tasks` off `feat/flag-p2-filters`; retarget the PR to master once Slice 1 merges.
- Gates identical to Slice 1 (vitest/tsc per task; `npm run check:all` + build + backend suite at the end; NEW-failure diff only).

---

### Task 1: Migration + model — nullable anchor, `due_at`

**Files:**
- Modify: `backend/flags/models.py` (FlagFlag), `backend/database.py` (append to the flags migration block, after the `flag_types` seeds ~line 900)
- Test: `backend/tests/test_flags_general_tasks.py` (create)

**Interfaces:**
- Produces: `FlagFlag.entity_type: Optional[str]`, `FlagFlag.entity_id: Optional[str]`, `FlagFlag.due_at: Optional[datetime]`. Every later task relies on these.

- [ ] **Step 1: Failing test**

```python
def test_flag_row_allows_null_anchor_and_due(db):
    from flags.models import FlagFlag
    f = FlagFlag(entity_type=None, entity_id=None, kind="issue", type="task",
                 status="open", title="general", created_by=1, due_at=None)
    db.add(f); db.commit(); db.refresh(f)
    assert f.id and f.entity_type is None and f.due_at is None
```

(Reuse the sibling flag tests' sqlite `db` fixture.)

- [ ] **Step 2: Run — FAIL** (`IntegrityError: NOT NULL constraint failed`).
Run: `python -m pytest backend/tests/test_flags_general_tasks.py -q`

- [ ] **Step 3: Implement.** `models.py` — the two anchor columns become:

```python
    # Nullable since Phase 2: a NULL anchor = a "general task" (spec §5).
    entity_type: Mapped[Optional[str]] = mapped_column(Text, nullable=True, index=True)
    entity_id: Mapped[Optional[str]] = mapped_column(Text, nullable=True, index=True)
```

and after `resolved_by` add:

```python
    due_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True, index=True)
```

`database.py` — append to the flags migration list (same string-list idiom as the `flag_types` block):

```python
        # --- Phase 2 slice 2: general tasks + due dates ---
        "ALTER TABLE flag_flags ALTER COLUMN entity_type DROP NOT NULL",
        "ALTER TABLE flag_flags ALTER COLUMN entity_id DROP NOT NULL",
        "ALTER TABLE flag_flags ADD COLUMN IF NOT EXISTS due_at TIMESTAMP",
        "CREATE INDEX IF NOT EXISTS ix_flag_flags_due ON flag_flags (due_at)",
```

(`DROP NOT NULL` is naturally idempotent in Postgres; the CREATE TABLE IF NOT EXISTS for fresh installs must ALSO lose the NOT NULL on those two columns and gain `due_at TIMESTAMP` — edit the `CREATE TABLE IF NOT EXISTS flag_flags (...)` string in the same block so new databases match migrated ones.)

- [ ] **Step 4: Run — PASS.** Full `-k flag` suite: no new failures.
- [ ] **Step 5: Commit** — `git commit -m "feat(flags): nullable entity anchor + due_at column"`

---

### Task 2: `create_flag` accepts a general (no-entity) task

**Files:**
- Modify: `backend/flags/service.py` (create_flag), `backend/flags/types_service.py` (is_allowed_for_entity), `backend/flags/schemas.py` (CreateFlagRequest + response fields), `backend/flags/routes.py` (`_with_entity` guard if needed)
- Test: `backend/tests/test_flags_general_tasks.py`

**Interfaces:**
- Produces: `service.create_flag(db, user=..., entity_type=None, entity_id=None, type=..., title=..., due_at=None, ...)` — entity checks skipped when anchor is None; type must be GLOBAL-scoped (`entity_types == []`). `FlagResponse.entity_type/entity_id: Optional[str]`; `FlagResponse.due_at: Optional[datetime]`.

- [ ] **Step 1: Failing tests**

```python
def test_create_general_task(db, actor):
    seed_builtins_plus_p2(db)  # helper: types_service.seed_builtins(db)
    f = service.create_flag(db, user=actor, entity_type=None, entity_id=None,
                            type="task", title="pick up equipment")
    assert f.entity_type is None and f.kind == "issue"

def test_general_task_rejects_entity_scoped_type(db, actor):
    # a type restricted to sample must not be raisable as general
    t = types_service.create_type(db, label="Sample only", color="#111",
                                  kind="issue", entity_types=["sample"])
    import pytest
    from flags.errors import BadRequestError
    with pytest.raises(BadRequestError):
        service.create_flag(db, user=actor, entity_type=None, entity_id=None,
                            type=t.slug, title="x")
```

(Match `create_type`'s real signature from `types_service.py` — adjust kwargs if it differs.)

- [ ] **Step 2: Run — FAIL** (`unknown entity_type None` BadRequest from the `is_registered` check).

- [ ] **Step 3: Implement.** `service.create_flag` — replace the entity validation block with:

```python
    if entity_type is None:
        if entity_id is not None:
            raise BadRequestError("entity_id requires entity_type")
    else:
        if not seams.is_registered(entity_type):
            raise BadRequestError(f"unknown entity_type {entity_type!r}")
    if not types_service.is_valid_type(db, type):
        raise BadRequestError(f"unknown flag type {type!r}")
    if not permissions.can(user, "create", None):
        raise PermissionDeniedError("not allowed to create flags")
    if entity_type is not None:
        spec = seams.get_entity_spec(entity_type)
        if not spec.can_flag(user, str(entity_id)):
            raise PermissionDeniedError(f"not allowed to flag {entity_type} {entity_id}")
    if not types_service.is_allowed_for_entity(db, type, entity_type):
        raise BadRequestError(
            f"flag type {type!r} is not allowed for {entity_type or 'general tasks'}")
```

and construct with `entity_id=str(entity_id) if entity_id is not None else None`.

`types_service.is_allowed_for_entity(db, type, entity_type)` — extend: when `entity_type is None`, return True **only if** the type's `entity_types` list is empty (global). Show the diff against its current body when you open the file; keep the existing behavior for non-None.

`schemas.py`: `CreateFlagRequest.entity_type/entity_id` → `Optional[str] = None`; `FlagResponse.entity_type/entity_id` → `Optional[str]`; add `due_at: Optional[datetime] = None` to `FlagResponse` (and thus the detail).

`routes.py`: wherever `_with_entity` resolves context, it must skip resolution when `flag.entity_type is None` (check `seams.resolve_context` — it already returns None for unregistered; `None` type-key must not raise; guard before calling if needed).

- [ ] **Step 4: Run — PASS**; full `-k flag` suite: no new failures.
- [ ] **Step 5: Commit** — `git commit -m "feat(flags): general tasks — create_flag with null anchor"`

---

### Task 3: Seed `task` + `feature_request` builtin types

**Files:**
- Modify: `backend/flags/types_service.py` (`_BUILTINS`), `backend/database.py` (two INSERT migrations)
- Test: `backend/tests/test_flags_general_tasks.py`

**Interfaces:**
- Produces: builtin slugs `task` (teal `#0ea5a5`) and `feature_request` (pink `#ec4899`), both kind `issue`, non-blocking, global scope, sort_order 5 and 6. Frontend type pickers get them via the existing `useFlagTypes()` — no FE change needed.

- [ ] **Step 1: Failing test**

```python
def test_p2_builtins_seeded(db):
    types_service.seed_builtins(db)
    assert types_service.get_type_by_slug(db, "task").is_builtin
    assert types_service.get_type_by_slug(db, "feature_request").color == "#ec4899"
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.** Append to `_BUILTINS`:

```python
    ("task", "Task", "#0ea5a5", "issue", False, 5),
    ("feature_request", "Feature Request", "#ec4899", "issue", False, 6),
```

`database.py`: two more idempotent INSERTs in the same style as the existing five (copy the `WHERE NOT EXISTS` pattern verbatim with the new values).

- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(flags): seed Task + Feature Request builtin types"`

---

### Task 4: Due-date service + route + events

**Files:**
- Modify: `backend/flags/service.py`, `backend/flags/routes.py`, `backend/flags/schemas.py`
- Test: `backend/tests/test_flags_due_dates.py` (create)

**Interfaces:**
- Produces: `service.set_due(db, *, user, flag_id, due_at: Optional[datetime]) -> FlagFlag` emitting `due_set` (from None), `due_changed`, `due_cleared` (to None) with ISO strings in from_value/to_value; `PUT /api/flags/{flag_id}/due` body `{"due_at": "<iso>" | null}` → FlagResponse; `create_flag(..., due_at=None)` param that stamps the column and emits `due_set` when provided.

- [ ] **Step 1: Failing tests**

```python
def test_set_change_clear_due(db, actor):
    types_service.seed_builtins(db)
    f = service.create_flag(db, user=actor, entity_type=None, entity_id=None,
                            type="task", title="t")
    d1 = datetime(2026, 7, 15); d2 = datetime(2026, 7, 20)
    service.set_due(db, user=actor, flag_id=f.id, due_at=d1)
    service.set_due(db, user=actor, flag_id=f.id, due_at=d2)
    service.set_due(db, user=actor, flag_id=f.id, due_at=None)
    evs = [e.event_type for e in service.get_flag(db, f.id).events]
    assert evs.count("due_set") == 1 and "due_changed" in evs and "due_cleared" in evs
    assert service.get_flag(db, f.id).due_at is None

def test_create_with_due_emits_due_set(db, actor):
    types_service.seed_builtins(db)
    f = service.create_flag(db, user=actor, entity_type=None, entity_id=None,
                            type="task", title="t", due_at=datetime(2026, 8, 1))
    assert any(e.event_type == "due_set" for e in f.events)
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.** `service.py`:

```python
def set_due(db: Session, *, user, flag_id: int,
            due_at: Optional[datetime]) -> FlagFlag:
    """Set/change/clear a flag's due date; no-op if unchanged."""
    flag = get_flag(db, flag_id)
    if not permissions.can(user, "update", flag):
        raise PermissionDeniedError("not allowed to edit this flag")
    if flag.due_at == due_at:
        return flag
    old = flag.due_at
    flag.due_at = due_at
    event = ("due_set" if old is None else
             "due_cleared" if due_at is None else "due_changed")
    _audit(db, flag, getattr(user, "id", None), event,
           from_value=old.isoformat() if old else None,
           to_value=due_at.isoformat() if due_at else None)
    _commit_and_emit(db)
    db.refresh(flag)
    return flag
```

(Use the same permission action string the status-change path uses — open `change_status` and copy its `permissions.can(...)` call exactly; if it uses a different action name than `"update"`, match it.)

`create_flag`: add `due_at=None` kwarg; set on the constructed row; after the `raised` audit, `if due_at is not None: _audit(db, flag, actor_id, "due_set", to_value=due_at.isoformat())`.

`schemas.py`:

```python
class DueRequest(BaseModel):
    due_at: Optional[datetime] = None
```

`CreateFlagRequest` gains `due_at: Optional[datetime] = None` (route passes through).

`routes.py`:

```python
@router.put("/{flag_id}/due", response_model=FlagResponse)
def set_due(flag_id: int, req: DueRequest, db: Session = Depends(get_db),
            user=Depends(get_current_user)):
    try:
        return _with_entity(db, service.set_due(db, user=user, flag_id=flag_id,
                                                due_at=req.due_at), FlagResponse)
    except Exception as e:
        raise _http(e)
```

(Place ABOVE any `/{flag_id}` catch-all route registrations, same ordering rule the file already follows.)

- [ ] **Step 4: Run — PASS**; suite green (baseline diff).
- [ ] **Step 5: Commit** — `git commit -m "feat(flags): due dates — set/change/clear with audit events"`

---

### Task 5: Entity reference links (backend)

**Files:**
- Modify: `backend/flags/models.py`, `backend/database.py`, `backend/flags/service.py`, `backend/flags/schemas.py`, `backend/flags/routes.py`
- Test: `backend/tests/test_flags_links.py` (create)

**Interfaces:**
- Produces: model `FlagEntityLink(id, flag_id, entity_type, entity_id, added_by, created_at)`; `service.add_entity_link(db, *, user, flag_id, entity_type, entity_id) -> FlagEntityLink`, `service.remove_entity_link(db, *, user, flag_id, link_id) -> None`; routes `POST /api/flags/{flag_id}/links/entities` body `{"entity_type": str, "entity_id": str}` (201), `DELETE /api/flags/{flag_id}/links/entities/{link_id}` (204); `FlagDetailResponse.entity_links: List[EntityLinkOut]` where `EntityLinkOut = {id, entity_type, entity_id, entity: Optional[EntityContext]}` (context resolved like the anchor). Task 8 mirrors `EntityLinkOut` in TS.

- [ ] **Step 1: Failing tests**

```python
def test_entity_link_lifecycle(db, actor):
    types_service.seed_builtins(db)
    f = service.create_flag(db, user=actor, entity_type="sample",
                            entity_id="PB-1", type="blocker", title="t")
    link = service.add_entity_link(db, user=actor, flag_id=f.id,
                                   entity_type="worksheet", entity_id="17")
    assert link.id
    evs = [e.event_type for e in service.get_flag(db, f.id).events]
    assert "entity_link_added" in evs
    # duplicate → BadRequest
    import pytest
    from flags.errors import BadRequestError
    with pytest.raises(BadRequestError):
        service.add_entity_link(db, user=actor, flag_id=f.id,
                                entity_type="worksheet", entity_id="17")
    service.remove_entity_link(db, user=actor, flag_id=f.id, link_id=link.id)
    assert "entity_link_removed" in [e.event_type
                                     for e in service.get_flag(db, f.id).events]
```

(The sqlite test session registers entities via the test conftest — check how sibling tests register `sample`/`worksheet` specs and reuse.)

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.** `models.py`:

```python
class FlagEntityLink(Base):
    """A navigational 'related item' reference — NOT a rollup anchor (spec §2)."""
    __tablename__ = "flag_entity_links"
    __table_args__ = (UniqueConstraint("flag_id", "entity_type", "entity_id",
                                       name="uq_flag_entity_link"),)

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    flag_id: Mapped[int] = mapped_column(Integer, ForeignKey("flag_flags.id", ondelete="CASCADE"),
                                         nullable=False, index=True)
    entity_type: Mapped[str] = mapped_column(Text, nullable=False)
    entity_id: Mapped[str] = mapped_column(Text, nullable=False)
    added_by: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
```

`database.py` migration:

```python
        """
        CREATE TABLE IF NOT EXISTS flag_entity_links (
            id          SERIAL PRIMARY KEY,
            flag_id     INTEGER NOT NULL REFERENCES flag_flags(id) ON DELETE CASCADE,
            entity_type TEXT NOT NULL,
            entity_id   TEXT NOT NULL,
            added_by    INTEGER,
            created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
            CONSTRAINT uq_flag_entity_link UNIQUE (flag_id, entity_type, entity_id)
        )
        """,
        "CREATE INDEX IF NOT EXISTS ix_flag_entity_links_flag ON flag_entity_links (flag_id)",
```

`service.py`:

```python
def add_entity_link(db: Session, *, user, flag_id: int, entity_type: str,
                    entity_id: str) -> FlagEntityLink:
    flag = get_flag(db, flag_id)
    if not seams.is_registered(entity_type):
        raise BadRequestError(f"unknown entity_type {entity_type!r}")
    dup = db.execute(select(FlagEntityLink).where(
        FlagEntityLink.flag_id == flag_id,
        FlagEntityLink.entity_type == entity_type,
        FlagEntityLink.entity_id == str(entity_id))).scalar_one_or_none()
    if dup is not None:
        raise BadRequestError("already linked")
    link = FlagEntityLink(flag_id=flag_id, entity_type=entity_type,
                          entity_id=str(entity_id),
                          added_by=getattr(user, "id", None))
    db.add(link)
    _audit(db, flag, getattr(user, "id", None), "entity_link_added",
           to_value=f"{entity_type}:{entity_id}")
    _commit_and_emit(db)
    db.refresh(link)
    return link


def remove_entity_link(db: Session, *, user, flag_id: int, link_id: int) -> None:
    flag = get_flag(db, flag_id)
    link = db.get(FlagEntityLink, link_id)
    if link is None or link.flag_id != flag_id:
        raise NotFoundError(f"link {link_id} not found on flag {flag_id}")
    db.delete(link)
    _audit(db, flag, getattr(user, "id", None), "entity_link_removed",
           from_value=f"{link.entity_type}:{link.entity_id}")
    _commit_and_emit(db)


def list_entity_links(db: Session, flag_id: int) -> list[FlagEntityLink]:
    return list(db.execute(select(FlagEntityLink)
        .where(FlagEntityLink.flag_id == flag_id)
        .order_by(FlagEntityLink.created_at.asc())).scalars().all())
```

(import `FlagEntityLink` at the top with the other model imports.)

`schemas.py`:

```python
class EntityLinkOut(BaseModel):
    id: int
    entity_type: str
    entity_id: str
    entity: Optional[EntityContext] = None
    model_config = ConfigDict(from_attributes=True)


class EntityLinkRequest(BaseModel):
    entity_type: str
    entity_id: str
```

`FlagDetailResponse.entity_links: List[EntityLinkOut] = Field(default_factory=list)`.

`routes.py` — in `get_flag`, after the watchers attach (Slice 1), resolve links:

```python
        resp.entity_links = []
        for l in service.list_entity_links(db, flag_id):
            out = EntityLinkOut.model_validate(l)
            ctx = seams.resolve_context(db, l.entity_type, l.entity_id)
            out.entity = EntityContext(**ctx) if ctx else None
            resp.entity_links.append(out)
```

plus the two routes (same try/`_http` idiom as `add_watcher`, 201/204).

- [ ] **Step 4: Run — PASS**; suite baseline-diff green.
- [ ] **Step 5: Commit** — `git commit -m "feat(flags): entity reference links (backend)"`

---

### Task 6: Flag↔flag links (backend)

**Files:**
- Modify: `backend/flags/models.py`, `backend/database.py`, `backend/flags/service.py`, `backend/flags/schemas.py`, `backend/flags/routes.py`
- Test: `backend/tests/test_flags_links.py`

**Interfaces:**
- Produces: model `FlagLink(id, flag_id, linked_flag_id, relation='related', added_by, created_at)` stored NORMALIZED (`flag_id < linked_flag_id` enforced in service, one row per pair); `service.add_flag_link(db, *, user, flag_id, other_id)`, `service.remove_flag_link(db, *, user, flag_id, link_id)`, `service.list_flag_links(db, flag_id)` (matches either column); routes `POST /api/flags/{flag_id}/links/flags` body `{"flag_id": int}`, `DELETE /api/flags/{flag_id}/links/flags/{link_id}`; `FlagDetailResponse.flag_links: List[FlagLinkOut]` where `FlagLinkOut = {id, flag_id, title, status, type}` — flag_id here is THE OTHER flag, pre-resolved for symmetric rendering. Events on BOTH flags.

- [ ] **Step 1: Failing tests**

```python
def test_flag_link_symmetric(db, actor):
    types_service.seed_builtins(db)
    a = service.create_flag(db, user=actor, entity_type=None, entity_id=None,
                            type="task", title="A")
    b = service.create_flag(db, user=actor, entity_type=None, entity_id=None,
                            type="task", title="B")
    service.add_flag_link(db, user=actor, flag_id=a.id, other_id=b.id)
    assert [l.id for l in service.list_flag_links(db, a.id)] == \
           [l.id for l in service.list_flag_links(db, b.id)]
    # both directions raise on duplicate
    import pytest
    from flags.errors import BadRequestError
    with pytest.raises(BadRequestError):
        service.add_flag_link(db, user=actor, flag_id=b.id, other_id=a.id)
    with pytest.raises(BadRequestError):
        service.add_flag_link(db, user=actor, flag_id=a.id, other_id=a.id)  # self
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.** `models.py`:

```python
class FlagLink(Base):
    """Flag↔flag 'related' link, one row per unordered pair (lo/hi normalized)."""
    __tablename__ = "flag_links"
    __table_args__ = (UniqueConstraint("flag_id", "linked_flag_id",
                                       name="uq_flag_link"),)

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    flag_id: Mapped[int] = mapped_column(Integer, ForeignKey("flag_flags.id", ondelete="CASCADE"),
                                         nullable=False, index=True)
    linked_flag_id: Mapped[int] = mapped_column(Integer, ForeignKey("flag_flags.id", ondelete="CASCADE"),
                                                nullable=False, index=True)
    relation: Mapped[str] = mapped_column(Text, nullable=False, default="related",
                                          server_default="related")
    added_by: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
```

`database.py`:

```python
        """
        CREATE TABLE IF NOT EXISTS flag_links (
            id             SERIAL PRIMARY KEY,
            flag_id        INTEGER NOT NULL REFERENCES flag_flags(id) ON DELETE CASCADE,
            linked_flag_id INTEGER NOT NULL REFERENCES flag_flags(id) ON DELETE CASCADE,
            relation       TEXT NOT NULL DEFAULT 'related',
            added_by       INTEGER,
            created_at     TIMESTAMP NOT NULL DEFAULT NOW(),
            CONSTRAINT uq_flag_link UNIQUE (flag_id, linked_flag_id),
            CONSTRAINT ck_flag_link_no_self CHECK (flag_id <> linked_flag_id)
        )
        """,
        "CREATE INDEX IF NOT EXISTS ix_flag_links_flag   ON flag_links (flag_id)",
        "CREATE INDEX IF NOT EXISTS ix_flag_links_linked ON flag_links (linked_flag_id)",
```

`service.py`:

```python
def add_flag_link(db: Session, *, user, flag_id: int, other_id: int) -> FlagLink:
    if flag_id == other_id:
        raise BadRequestError("cannot link a flag to itself")
    flag = get_flag(db, flag_id)
    other = get_flag(db, other_id)
    lo, hi = sorted((flag_id, other_id))
    dup = db.execute(select(FlagLink).where(
        FlagLink.flag_id == lo, FlagLink.linked_flag_id == hi)).scalar_one_or_none()
    if dup is not None:
        raise BadRequestError("already linked")
    link = FlagLink(flag_id=lo, linked_flag_id=hi,
                    added_by=getattr(user, "id", None))
    db.add(link)
    actor = getattr(user, "id", None)
    _audit(db, flag, actor, "flag_link_added", to_value=str(other_id))
    _audit(db, other, actor, "flag_link_added", to_value=str(flag_id))
    _commit_and_emit(db)
    db.refresh(link)
    return link


def remove_flag_link(db: Session, *, user, flag_id: int, link_id: int) -> None:
    flag = get_flag(db, flag_id)
    link = db.get(FlagLink, link_id)
    if link is None or flag_id not in (link.flag_id, link.linked_flag_id):
        raise NotFoundError(f"link {link_id} not found on flag {flag_id}")
    other_id = link.linked_flag_id if link.flag_id == flag_id else link.flag_id
    other = get_flag(db, other_id)
    db.delete(link)
    actor = getattr(user, "id", None)
    _audit(db, flag, actor, "flag_link_removed", from_value=str(other_id))
    _audit(db, other, actor, "flag_link_removed", from_value=str(flag_id))
    _commit_and_emit(db)


def list_flag_links(db: Session, flag_id: int) -> list[FlagLink]:
    return list(db.execute(select(FlagLink).where(
        or_(FlagLink.flag_id == flag_id, FlagLink.linked_flag_id == flag_id))
        .order_by(FlagLink.created_at.asc())).scalars().all())
```

`schemas.py`:

```python
class FlagLinkOut(BaseModel):
    id: int
    flag_id: int        # the OTHER flag (resolved for the viewer)
    title: str
    status: str
    type: str


class FlagLinkRequest(BaseModel):
    flag_id: int
```

`FlagDetailResponse.flag_links: List[FlagLinkOut] = Field(default_factory=list)`.

`routes.py` `get_flag` — after entity_links:

```python
        resp.flag_links = []
        for l in service.list_flag_links(db, flag_id):
            oid = l.linked_flag_id if l.flag_id == flag_id else l.flag_id
            o = service.get_flag(db, oid)
            resp.flag_links.append(FlagLinkOut(
                id=l.id, flag_id=o.id, title=o.title, status=o.status, type=o.type))
```

plus POST/DELETE routes in the watcher idiom.

- [ ] **Step 4: Run — PASS**; suite baseline-diff green.
- [ ] **Step 5: Commit** — `git commit -m "feat(flags): flag-to-flag related links (backend)"`

---

### Task 7: Frontend — general-task compose + due date field

**Files:**
- Modify: `src/lib/flags-api.ts` (`CreateFlagBody`, `FlagResponse` mirror: nullable anchor + `due_at`), `src/components/flags/RaiseFlagButton.tsx`, `src/components/flags/FlagsFlyout.tsx` (Add Flag visibility)
- Test: `src/components/flags/__tests__/RaiseFlagButton-general.test.tsx` (create)

**Interfaces:**
- Consumes: backend Task 2/4 (`entity_type: null` create; `due_at` on create).
- Produces: `CreateFlagBody.entity_type: string | null`, `entity_id: string | null`, `due_at?: string | null`; `FlagResponse.entity_type: string | null`, `entity_id: string | null`, `due_at: string | null`. RaiseFlagButton new behavior: with NO preset and NO candidates it no longer hides the flow — it composes a GENERAL task (anchor selector shows "General (no item)"). With a preset, a two-option selector: the preset entity (default) / "General (no item)". Optional native date input labeled "Due date".

- [ ] **Step 1: Failing test** — render RaiseFlagButton with no preset/candidates (mock `useFlagTypes` returning the builtin list incl. `task` with `entity_types: []`, and mock `createFlag`); open the dialog; fill title; submit; assert `createFlag` called with `{ entity_type: null, entity_id: null, type: 'task', ... }`. Follow the mocking idiom of the EXISTING RaiseFlagButton tests in `__tests__` (they exist — extend, don't fork the style). Also assert setting the date input adds `due_at` (ISO string) to the payload.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.**
- `flags-api.ts`: types per Interfaces above (mechanical).
- `RaiseFlagButton.tsx`: the component currently derives `presetEntity`/`candidates` modes. Add a third mode `general`: an anchor `<Select>` at the top of the compose form whose options are the preset/candidates (when present) plus always `General (no item)` (value `__general__`). When general is selected: type options filter to types with `entity_types.length === 0`, and submit posts `entity_type: null, entity_id: null`. When NO preset and NO candidates exist, the compose defaults to general (this replaces the Phase 1 "hidden when stack empty" behavior — the manual entity-ID fallback form stays reachable for anchored raises exactly as today).
- Due field (inside the form, after the type picker):

```tsx
<div className="space-y-1">
  <Label htmlFor="flag-due" className="text-xs">Due date (optional)</Label>
  <Input id="flag-due" type="date" value={due}
         onChange={e => setDue(e.target.value)} className="h-8 w-40 text-xs" />
</div>
```

with `const [due, setDue] = useState('')` and on submit `due_at: due ? new Date(`${due}T17:00:00`).toISOString() : null` (5 pm local = end-of-workday semantics; comment it).
- `FlagsFlyout.tsx`: the Add Flag button's `activeFlagEntityStack`-empty guard is REMOVED — always render it; when the stack is empty it opens general compose (no `targetLabel`).

- [ ] **Step 4: Run — PASS** + `npx tsc --noEmit -p tsconfig.json` (nullable `entity_type` will surface consumers assuming `string` — e.g. `filterFlags` entityType compare and `flag-entity.ts` helpers; fix each surfaced site null-safely, keeping behavior for anchored flags identical).
- [ ] **Step 5: Commit** — `git commit -m "feat(flags): general-task compose + due date field"`

---

### Task 8: Frontend — link chips in the thread + General filter option

**Files:**
- Create: `src/components/flags/FlagLinkChips.tsx`
- Modify: `src/lib/flags-api.ts` (mirrors + 4 API fns), `src/components/flags/FlagThread.tsx` (mount), `src/components/flags/FlagsFilterBar.tsx` + `src/components/flags/flag-filter.ts` (General entity option)
- Test: `src/components/flags/__tests__/FlagLinkChips.test.tsx`, extend `flag-filter.test.ts`

**Interfaces:**
- Consumes: Task 5/6 response shapes.
- Produces:

```ts
export interface EntityLink { id: number; entity_type: string; entity_id: string; entity: EntityContext | null }
export interface FlagLink { id: number; flag_id: number; title: string; status: string; type: string }
export const addEntityLink = (id: number, entity_type: string, entity_id: string) =>
  apiFetch<EntityLink>(`/api/flags/${id}/links/entities`, { method: 'POST', body: JSON.stringify({ entity_type, entity_id }) })
export const removeEntityLink = (id: number, linkId: number) =>
  apiFetch<undefined>(`/api/flags/${id}/links/entities/${linkId}`, { method: 'DELETE' })
export const addFlagLink = (id: number, otherId: number) =>
  apiFetch<FlagLink>(`/api/flags/${id}/links/flags`, { method: 'POST', body: JSON.stringify({ flag_id: otherId }) })
export const removeFlagLink = (id: number, linkId: number) =>
  apiFetch<undefined>(`/api/flags/${id}/links/flags/${linkId}`, { method: 'DELETE' })
```

  plus `entity_links: EntityLink[]` / `flag_links: FlagLink[]` on the detail mirror; `<FlagLinkChips flagId currentFlag={detail} />` rendering both chip rows with remove ✕ and two small add-pickers; filter literal `'general'` for `FlagFilterState.entityType` matching `entity_type === null`.

- [ ] **Step 1: Failing tests.** FlagLinkChips: render with one entity link (`entity: { label: 'PB-0077-S01', ... }`) and one flag link (`title: 'Pump seal'`); assert both labels render; click the flag-link chip → assert the ui-store thread-open action was called with the other flag id (mock the store the way FlagCard's tests mock opening a thread — mirror that idiom). flag-filter: `entityType: 'general'` keeps only `entity_type === null` rows.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.**
- `flag-filter.ts` — in the entityType branch:

```ts
    if (entityType === 'general') {
      if (flag.entity_type != null) return false
    } else if (entityType !== 'all' && flag.entity_type !== entityType) return false
```

- `FlagsFilterBar.tsx` — append `<SelectItem value="general">General</SelectItem>` after the mapped `ENTITY_TYPES` items.
- `FlagLinkChips.tsx` — chips row component: entity chips label = `entity?.label ?? \`${entity_type} ${entity_id}\``, navigate via the existing deep-link helper used by the thread breadcrumb (find it in `flag-entity.ts` — `entityMeta(...)`/deep-link util) with the flyout-close behavior FlagCard uses; flag chips open the linked thread via the ui-store's open-thread action; remove ✕ calls the API fn + invalidates `['flags']`; "＋ item" picker = entity-type Select + free id Input (the Phase 1 manual form pattern); "＋ flag" picker = numeric flag id Input (v1 — no search dropdown, note it in the UI placeholder "Flag #"). Keep it one focused ~150-line component; reuse `Dot`/badge styling from `FlagCard` chips.
- `FlagThread.tsx` — mount `<FlagLinkChips ... />` directly below the Slice-1 watcher row.

- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(flags): link chips + General entity filter"`

---

### Task 9: Frontend — overdue treatment + Overdue toggle + due sort

**Files:**
- Modify: `src/components/flags/flag-format.ts` (add `dueLabel`), `src/components/flags/FlagCard.tsx`, `src/components/flags/FlagTable.tsx`, `src/components/flags/flag-filter.ts` + `src/components/flags/FlagsFilterBar.tsx` (overdue toggle)
- Test: `src/components/flags/__tests__/flag-due.test.ts`

**Interfaces:**
- Produces: `dueLabel(due_at: string | null, now?: Date): { text: string; overdue: boolean } | null` (`"due in 2d"` / `"overdue 3d"` / `"due today"`); `FlagFilterState.overdueOnly: boolean` (default `false`, persisted by the Slice-1 hook automatically since it spreads state); FlagTable gains a due column sorted ascending-nulls-last when the user clicks its header (follow FlagTable's existing GRID_TEMPLATE pattern — widen the template by one `88px` column).

- [ ] **Step 1: Failing tests**

```ts
import { dueLabel } from '@/components/flags/flag-format'
const now = new Date('2026-07-09T12:00:00Z')
it('future', () => expect(dueLabel('2026-07-11T17:00:00Z', now))
  .toEqual({ text: 'due in 2d', overdue: false }))
it('past', () => expect(dueLabel('2026-07-06T17:00:00Z', now))
  .toEqual({ text: 'overdue 3d', overdue: true }))
it('today', () => expect(dueLabel('2026-07-09T17:00:00Z', now))
  .toEqual({ text: 'due today', overdue: false }))
it('null', () => expect(dueLabel(null, now)).toBeNull())
```

plus filter: `{ overdueOnly: true }` keeps only rows whose `dueLabel(...).overdue` (closed/resolved flags NEVER count as overdue — status in `OPEN_STATUSES` required; test it).

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.** `flag-format.ts`:

```ts
/** Relative due-date label. Day-granular: floor(diff / 86_400_000). */
export function dueLabel(
  due_at: string | null, now: Date = new Date()
): { text: string; overdue: boolean } | null {
  if (!due_at) return null
  const days = Math.floor(
    (new Date(due_at).getTime() - now.getTime()) / 86_400_000)
  if (days < 0) return { text: `overdue ${-days}d`, overdue: true }
  if (days === 0) return { text: 'due today', overdue: false }
  return { text: `due in ${days}d`, overdue: false }
}
```

`flag-filter.ts`: add `overdueOnly: boolean` to the state (+ `EMPTY_FLAG_FILTER.overdueOnly = false`); predicate (after the assignee branch):

```ts
    if (filter.overdueOnly) {
      const d = dueLabel(flag.due_at, now)
      if (!d?.overdue) return false
      if (!OPEN_STATUSES.includes(flag.status as FlagStatus)) return false
    }
```

(`filterFlags` gains an optional `now: Date = new Date()` third param for testability; import `dueLabel`.)

`FlagsFilterBar.tsx`: a small toggle button after the selects — `variant={value.overdueOnly ? 'default' : 'ghost'}`, label "Overdue", `onClick={() => onChange({ ...value, overdueOnly: !value.overdueOnly })}`, `aria-pressed`.

`FlagCard.tsx` / `FlagTable.tsx`: render `dueLabel(flag.due_at)` when non-null — red text (`text-destructive`) + red left-edge treatment on the row when overdue AND status is open (reuse how the card already color-codes; keep hunks surgical). FlagTable due column header click toggles due-ascending sort (nulls last) — local `useState` sort like any existing column sort in that file; if FlagTable has NO sort today, add only this one (a `sortByDue` boolean state, no generic sort framework — YAGNI).

- [ ] **Step 4: Run — PASS** + flag suite + tsc.
- [ ] **Step 5: Commit** — `git commit -m "feat(flags): overdue labels, filter toggle, due sort"`

---

### Task 10: Slice gates

- [ ] **Step 1:** `npm run check:all` — baseline-diff green.
- [ ] **Step 2:** `npm run build` — succeeds.
- [ ] **Step 3:** `python -m pytest backend/tests -q` — failure set matches baseline.
- [ ] **Step 4:** Final commit; stop. (Orchestrator reviews before push/PR.)

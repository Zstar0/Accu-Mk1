# Technology Stack: User Authentication Addition

**Project:** Accu-Mk1 User Authentication
**Milestone Type:** Subsequent (adding to existing app)
**Researched:** 2026-02-09
**Overall Confidence:** HIGH

## Executive Summary

Adding FastAPI Users to existing FastAPI 0.115.0 + SQLAlchemy 2.0.35 stack. FastAPI Users is in maintenance mode (security updates only) but production-stable. Core pattern: JWT access/refresh tokens, bcrypt password hashing, role-based authorization, SQLAlchemy async with SQLite.

**Key finding:** FastAPI Users v15.0.4 uses pwdlib (modern bcrypt/argon2 wrapper) NOT passlib (unmaintained). PyJWT 2.11.0 handles JWT operations. React frontend uses in-memory access tokens + auth context pattern with TanStack Query v5 for API calls.

## Backend Stack Additions

### Core Authentication Framework

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| fastapi-users | ^15.0.4 | User management framework | Production-stable, SQLAlchemy 2.0 native support, JWT strategy built-in. In maintenance mode but actively maintained for security. Eliminates boilerplate for registration, login, password reset. |
| fastapi-users-db-sqlalchemy | ^7.0.0 | SQLAlchemy adapter for fastapi-users | Required for SQLAlchemy 2.0 async integration. v7.0.0+ requires Python 3.9+. Provides SQLAlchemyBaseUserTable mixin for User model. |
| pyjwt[crypto] | ^2.11.0 | JWT token generation/validation | FastAPI Users dependency. [crypto] extra includes cryptography library for asymmetric algorithms (RS256, ES256). Latest stable release (Jan 2026). Simpler API than python-jose. |
| pwdlib[argon2,bcrypt] | ==0.3.0 | Password hashing | FastAPI Users switched from passlib (unmaintained) to pwdlib in v13.0. Modern bcrypt implementation. [bcrypt] extra ensures bcrypt support; [argon2] for future upgrade path. |
| email-validator | ^2.3.0 | Email validation | Required by FastAPI Users for user email validation. Strict RFC compliance. |
| python-multipart | ^0.1.0 | Form data parsing | Required for OAuth2PasswordRequestForm in login endpoints. FastAPI Users dependency. |

### Database Driver

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| aiosqlite | ^0.20.0 | Async SQLite driver | Required for SQLAlchemy 2.0 async engine with SQLite. Existing sync SQLite won't work with FastAPI Users async patterns. |

**Database migration note:** Existing SQLAlchemy 2.0.35 setup must migrate from sync to async patterns. FastAPI Users requires async session management with `expire_on_commit=False`.

## Frontend Stack Additions

### Authentication Management

| Library | Version | Purpose | Why |
|---------|---------|---------|-----|
| (none) | N/A | Authentication state | Use existing React Context API + TypeScript. No additional library needed. |
| (none) | N/A | Protected routes | Use existing React Router pattern (likely through Tauri routing). Implement ProtectedRoute wrapper component. |

**Rationale for no new frontend libraries:** Existing stack (React 19.2.3, TanStack Query 5.90.12, Zustand 5.0.9) provides all primitives needed:
- TanStack Query for API calls with automatic token injection
- React Context for auth state (user, login, logout, token refresh)
- Zustand could be used but Context API is simpler for auth-only state
- No router library detected in package.json; likely using Tauri's routing or manual URL management

### Token Storage Strategy

**Recommendation:** Hybrid in-memory + httpOnly cookie approach

| Token Type | Storage | Security Rationale |
|------------|---------|-------------------|
| Access token (JWT) | In-memory (React Context state) | Short-lived (15-30 min). Lost on page refresh. Immune to XSS attacks (not in localStorage). |
| Refresh token | httpOnly cookie (backend-set) | Long-lived (7 days). Cannot be accessed by JavaScript. Protected against XSS. Requires SameSite=Strict for CSRF protection. |

**localStorage/sessionStorage:** AVOID. Highly vulnerable to XSS attacks. If XSS vulnerability exists, attacker can steal tokens and impersonate user.

**Why NOT cookies for access tokens:** Tauri desktop app may not handle cookies consistently across embedded webview. In-memory state works in both browser and Tauri modes.

### API Client Configuration

| Pattern | Implementation | Purpose |
|---------|---------------|---------|
| Request interceptor | TanStack Query custom fetcher | Inject access token into Authorization header |
| Response interceptor | 401 error handler | Detect expired access token, attempt refresh, retry original request |
| Token refresh flow | Dedicated refresh endpoint | Call /auth/refresh with httpOnly refresh cookie, receive new access token |

**Alternative considered:** Axios interceptors (common pattern in React JWT tutorials). Rejected because project already uses TanStack Query v5. Adding Axios creates redundant HTTP client.

## Integration Points with Existing Stack

### FastAPI 0.115.0

**Compatibility:** HIGH confidence. FastAPI Users requires `fastapi >=0.65.2`. Version 0.115.0 well-supported.

**Integration pattern:**
```python
from fastapi import FastAPI
from fastapi_users import FastAPIUsers

app = FastAPI()
fastapi_users = FastAPIUsers[User, int](
    get_user_manager,
    [auth_backend],
)

# Add routes
app.include_router(
    fastapi_users.get_auth_router(auth_backend),
    prefix="/auth",
    tags=["auth"],
)
```

### SQLAlchemy 2.0.35

**Compatibility:** HIGH confidence. FastAPI Users v15.0+ native SQLAlchemy 2.0 support via fastapi-users-db-sqlalchemy v7.0.0.

**Breaking change required:** Existing sync SQLAlchemy code must migrate to async:
- `create_engine` → `create_async_engine`
- `sessionmaker` → `async_sessionmaker`
- `session.commit()` → `await session.commit()`
- Database models must inherit from `SQLAlchemyBaseUserTable[int]` (User) or `SQLAlchemyBaseUserTableUUID` (UUID)

**Session configuration:**
```python
async_session_maker = async_sessionmaker(
    bind=async_engine,
    expire_on_commit=False,  # CRITICAL for async sessions
)
```

### Pydantic 2.9.0

**Compatibility:** HIGH confidence. FastAPI Users uses Pydantic v2 for schemas. No conflicts expected.

### Current API Key System

**Migration path:** Preserve X-API-Key header system for backward compatibility. Add JWT authentication as alternative.

**Implementation:**
```python
# Dual authentication dependency
async def get_current_user_or_api_key(
    user: User | None = Depends(optional_current_user),
    api_key: str | None = Header(None, alias="X-API-Key")
):
    if user:
        return user  # JWT auth succeeded
    if api_key and validate_api_key(api_key):
        return get_api_key_user(api_key)  # Legacy API key
    raise HTTPException(401)
```

## NOT Adding (and Why)

### python-jose

**Why NOT:** FastAPI Users uses PyJWT directly. python-jose is older, less maintained. PyJWT 2.11.0 simpler API, equivalent functionality.

### passlib

**Why NOT:** FastAPI Users v13.0+ migrated to pwdlib. passlib unmaintained (last update 4+ years ago). pwdlib modern replacement with bcrypt/argon2 support.

### Argon2-cffi (direct)

**Why NOT:** pwdlib[argon2] includes argon2 dependency. Project uses bcrypt for v1 (user requirement). Argon2 included via pwdlib for future upgrade path if needed.

### React Router

**Why NOT:** No react-router dependency detected in package.json. Tauri app may use native routing or manual implementation. Adding full router unnecessary for protected routes (can implement with conditional rendering).

### Axios

**Why NOT:** TanStack Query already handles HTTP requests. Adding Axios creates duplicate client. Token injection achievable via TanStack Query custom fetcher.

### Redux / Redux Toolkit

**Why NOT:** Auth state localized to user + token. React Context sufficient. Zustand already available if global state needed. Redux overhead unnecessary for single-domain state.

### react-query-auth

**Why NOT:** Pre-built auth hooks for TanStack Query. Opinionated patterns don't match project requirements (console-based password reset, dual API key auth). Manual implementation with TanStack Query more flexible.

## Installation Commands

### Backend

```bash
# Core authentication
pip install "fastapi-users[sqlalchemy]==15.0.4"
pip install "fastapi-users-db-sqlalchemy==7.0.0"

# Database async driver
pip install "aiosqlite==0.20.0"

# Note: pyjwt, pwdlib, email-validator, python-multipart installed as fastapi-users dependencies
```

**Version pinning strategy:** Pin fastapi-users to exact version (maintenance mode, no new features). Pin database adapter to major version. Allow minor updates for security patches.

### Frontend

```bash
# No additional packages required
# Use existing: React Context, TanStack Query
```

## Version Compatibility Matrix

| Component | Current Version | New/Updated Version | Breaking Changes |
|-----------|----------------|---------------------|------------------|
| Python | (unknown) | ≥3.10 required | If <3.10, MUST upgrade |
| FastAPI | 0.115.0 | (no change) | None |
| SQLAlchemy | 2.0.35 | (no change) | Sync → Async migration required |
| Pydantic | 2.9.0 | (no change) | None |
| React | 19.2.3 | (no change) | None |
| TanStack Query | 5.90.12 | (no change) | None |

## Architecture Implications

### Backend Changes

**New models:**
- `User` (inherits from `SQLAlchemyBaseUserTable[int]`)
- `Role` or use `is_superuser` boolean (fastapi-users built-in)

**New endpoints:**
- `POST /auth/register` - User registration
- `POST /auth/login` - JWT token issuance
- `POST /auth/logout` - Token invalidation
- `POST /auth/refresh` - Access token refresh
- `POST /auth/forgot-password` - Initiate password reset (console/log output)
- `POST /auth/reset-password` - Complete password reset

**New dependencies (FastAPI Depends):**
- `current_user` - Require authenticated user
- `current_active_user` - Require active (non-disabled) user
- `current_superuser` - Require admin role

### Frontend Changes

**New components:**
- `AuthProvider` - Context provider for auth state
- `ProtectedRoute` - Wrapper for authenticated routes
- `LoginForm` - User login UI
- `RegisterForm` - User registration UI

**New hooks:**
- `useAuth()` - Access auth context (user, login, logout, refresh)
- `useProtectedQuery()` - TanStack Query wrapper with auth

**New API client logic:**
- Token injection in request headers
- 401 error handling with refresh attempt
- Automatic logout on refresh failure

## Security Considerations

### Token Lifecycle

**Access token:**
- Lifetime: 15-30 minutes (configurable via `JWTStrategy(lifetime_seconds=1800)`)
- Audience: `["fastapi-users:auth"]` (prevents token reuse across services)
- Algorithm: HS256 (symmetric, sufficient for single-server deployment)

**Refresh token:**
- Lifetime: 7 days (recommended for desktop app)
- Storage: httpOnly cookie with SameSite=Strict
- Rotation: Issue new refresh token on each refresh (optional, enhanced security)

### Password Hashing

**Default:** bcrypt via pwdlib (user requirement)
**Cost factor:** bcrypt default (12 rounds)
**Upgrade path:** pwdlib[argon2] included for future migration to argon2id

### CORS Configuration

**Critical for browser mode:**
```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],  # Vite dev server
    allow_credentials=True,  # Required for httpOnly cookies
    allow_methods=["*"],
    allow_headers=["*"],
)
```

**Tauri mode:** CORS not applicable (embedded webview, same origin)

## Migration Strategy

### Phase 1: Add User Model and Auth Backend

1. Add aiosqlite dependency
2. Convert SQLAlchemy to async (engine, sessions, queries)
3. Create User model (inherits SQLAlchemyBaseUserTable[int])
4. Add FastAPI Users routes (/auth/*)
5. Test registration + login in isolation

### Phase 2: Protect Existing API Endpoints

1. Add `Depends(current_active_user)` to protected routes
2. Maintain X-API-Key as fallback (dual auth)
3. Update OpenAPI docs to show both auth methods

### Phase 3: Frontend Auth Integration

1. Create AuthContext + useAuth hook
2. Add login/register forms
3. Implement token refresh logic
4. Wrap protected routes with ProtectedRoute component

### Phase 4: Role-Based Authorization

1. Add role check logic (admin vs standard)
2. Protect admin-only endpoints with `Depends(current_superuser)`
3. Add frontend role checks for UI elements

## Known Gotchas

### 1. Async SQLAlchemy Migration

**Problem:** FastAPI Users requires async sessions. Existing sync code breaks.

**Solution:** Systematic migration. Start with database connection, then models, then routes. Use `asyncio.run()` for scripts/migrations.

### 2. expire_on_commit=False

**Problem:** Async SQLAlchemy sessions with `expire_on_commit=True` (default) cause lazy-loading errors.

**Solution:** Set `expire_on_commit=False` in `async_sessionmaker`. Explicitly refresh objects if needed.

```python
async_session_maker = async_sessionmaker(
    bind=async_engine,
    expire_on_commit=False,  # MUST be False for async
)
```

### 3. Token Storage in Tauri

**Problem:** httpOnly cookies may not persist correctly in Tauri webview.

**Solution:** Test refresh token cookie behavior early. Fallback: Store refresh token in Tauri secure storage (rust-side) if cookies unreliable.

### 4. CORS with Credentials

**Problem:** Browser blocks httpOnly cookies without `allow_credentials=True` in CORS.

**Solution:** Set `allow_credentials=True` in CORSMiddleware. Frontend must use `credentials: 'include'` in fetch/axios.

### 5. Password Reset in Desktop App

**Problem:** Email-based password reset requires SMTP server. Desktop app context makes email setup complex.

**Solution:** V1 uses console/log output (user requirement). Admin copies reset link from logs. V2+ could use Tauri native dialog or WebSocket push to app.

### 6. FastAPI Users Maintenance Mode

**Problem:** No new features. Security updates only.

**Solution:** Acceptable for stable auth patterns. If custom features needed later, may need to fork or migrate to manual JWT implementation. For v1 requirements (basic JWT + roles), FastAPI Users sufficient.

## Sources (High Confidence)

### Official Documentation
- [FastAPI Users SQLAlchemy Configuration](https://fastapi-users.github.io/fastapi-users/latest/configuration/databases/sqlalchemy/)
- [FastAPI Users JWT Strategy](https://fastapi-users.github.io/fastapi-users/10.3/configuration/authentication/strategies/jwt/)
- [FastAPI Users Password Hashing](https://fastapi-users.github.io/fastapi-users/10.3/configuration/password-hash/)
- [FastAPI OAuth2 with JWT](https://fastapi.tiangolo.com/tutorial/security/oauth2-jwt/)

### Package Repositories
- [fastapi-users PyPI](https://pypi.org/project/fastapi-users/) - v15.0.4, Python ≥3.10
- [fastapi-users-db-sqlalchemy Releases](https://github.com/fastapi-users/fastapi-users-db-sqlalchemy/releases) - v7.0.0
- [fastapi-users pyproject.toml](https://github.com/fastapi-users/fastapi-users/blob/master/pyproject.toml) - Exact dependency versions
- [PyJWT PyPI](https://pypi.org/project/PyJWT/) - v2.11.0, Python 3.9+
- [bcrypt PyPI](https://pypi.org/project/bcrypt/) - v5.0.0

### Authentication Patterns
- [TestDriven.io - Securing FastAPI with JWT](https://testdriven.io/blog/fastapi-jwt-auth/)
- [FreeCodeCamp - JWT Authentication in FastAPI](https://www.freecodecamp.org/news/how-to-add-jwt-authentication-in-fastapi/)
- [React Router Protected Routes](https://react.wiki/router/protected-routes/)
- [LogRocket - Authentication with React Router v6](https://blog.logrocket.com/authentication-react-router-v6/)

### Security Best Practices
- [JWT Storage Security Battle](https://cybersierra.co/blog/react-jwt-storage-guide/)
- [Syncfusion - JWT Authentication in React](https://www.syncfusion.com/blogs/post/implement-jwt-authentication-in-react)
- [Descope - Developer's Guide to JWT Storage](https://www.descope.com/blog/post/developer-guide-jwt-storage)

### React Integration
- [TanStack Query Authentication Discussion](https://github.com/TanStack/query/discussions/3253)
- [React Query + Axios Interceptors JWT](https://codevoweb.com/react-query-context-api-axios-interceptors-jwt-auth/)
- [Axios JWT Token Refresh](https://blog.theashishmaurya.me/handling-jwt-access-and-refresh-token-using-axios-in-react-app)

### Maintenance & Migration
- [FastAPI Users v13.0.0 Discussion](https://github.com/fastapi-users/fastapi-users/discussions/1372) - pwdlib migration
- [passlib maintenance discussion](https://github.com/fastapi/fastapi/discussions/11773) - Why pwdlib
- [pwdlib introduction](https://www.francoisvoron.com/blog/introducing-pwdlib-a-modern-password-hash-helper-for-python)

## Confidence Assessment

| Area | Confidence | Reason |
|------|-----------|--------|
| FastAPI Users compatibility | HIGH | v15.0.4 explicitly supports FastAPI 0.115.0, SQLAlchemy 2.0. Official docs verified. |
| PyJWT version | HIGH | Exact version from pyproject.toml: `>=2.11.0,<3.0.0`. v2.11.0 released Jan 2026. |
| Password hashing (pwdlib) | HIGH | FastAPI Users v13.0+ uses pwdlib. Official migration documented. bcrypt support confirmed. |
| SQLAlchemy async migration | HIGH | Official fastapi-users docs specify async patterns. Multiple sources confirm expire_on_commit=False requirement. |
| React patterns | HIGH | TanStack Query v5 + Context API established patterns. No new libraries needed. Multiple 2026 sources on protected routes. |
| Token storage security | HIGH | Industry consensus on httpOnly cookies for refresh tokens, in-memory for access tokens. Multiple authoritative sources (2025-2026). |
| Tauri cookie behavior | MEDIUM | Limited 2026 sources on Tauri + httpOnly cookies. Requires testing. Fallback plan documented. |

## Ready for Roadmap

Research complete. Stack decisions are prescriptive with rationale. Integration points with existing stack documented. Security patterns established. Migration path clear. Gotchas catalogued with solutions.

**Next steps for roadmap creation:**
1. Phase 1: Backend async migration + User model
2. Phase 2: FastAPI Users integration + auth endpoints
3. Phase 3: Frontend auth context + protected routes
4. Phase 4: Role-based authorization

**Estimated effort:** Medium complexity. FastAPI Users reduces boilerplate significantly. Main effort: SQLAlchemy sync→async migration.

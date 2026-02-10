# Architecture: JWT Authentication Integration

**Project:** Accu-Mk1 User Authentication
**Domain:** FastAPI + SQLAlchemy + React SPA + Tauri Desktop
**Researched:** 2026-02-09
**Overall Confidence:** HIGH

## Executive Summary

Adding JWT authentication to an existing FastAPI + SQLAlchemy + React (Tauri) app requires integrating fastapi-users library on the backend and replacing the current X-API-Key header pattern with Bearer token authentication on the frontend. The architecture follows a layered dependency injection pattern where database adapters feed into a UserManager, which provides current_user dependencies for route protection.

**Key Integration Points:**
- Backend: Add User model to existing database.py, mount auth routers alongside existing endpoints, replace `Depends(verify_api_key)` with `Depends(current_active_user)`
- Frontend: Replace X-API-Key header with Authorization: Bearer {token}, add token refresh logic via Axios interceptors
- Storage: Use localStorage for tokens in both browser and Tauri (desktop apps can safely use localStorage, unlike web SPAs that face XSS risks)

**Critical Consideration:** FastAPI Users does not include built-in roles/permissions. Must extend the User model manually with a `role` field (enum: standard/admin).

## Current Architecture

### Backend (FastAPI)

```
backend/
├── main.py               # FastAPI app with ~1900 lines
│   ├── API_KEY env var   # Current auth: os.environ.get("ACCU_MK1_API_KEY")
│   └── verify_api_key()  # Dependency checking X-API-Key header
├── database.py           # SQLAlchemy 2.0 setup
│   ├── Base              # DeclarativeBase for models
│   ├── engine            # SQLite at ./data/accu-mk1.db
│   ├── SessionLocal      # Session maker
│   └── get_db()          # FastAPI dependency
└── models.py             # Existing models: AuditLog, Job, Sample, etc.
```

**Current Auth Pattern:**
```python
async def verify_api_key(x_api_key: Optional[str] = Header(None, alias="X-API-Key")):
    if not secrets.compare_digest(x_api_key, API_KEY):
        raise HTTPException(status_code=401, detail="Invalid API key")
```

**Protected endpoints:**
```python
@app.get("/explorer/environments")
async def get_explorer_environments(api_key: str = Depends(verify_api_key)):
    # Only 5 endpoints currently protected
```

### Frontend (React + Tauri)

```
src/
├── lib/
│   ├── api.ts            # ~1550 lines, fetch-based API client
│   │   └── getApiKey()   # Gets key from api-profiles module
│   ├── api-key.ts        # localStorage management for API key
│   │   ├── getApiKey()
│   │   ├── setApiKey()
│   │   └── clearApiKey()
│   └── config.ts         # API base URL configuration
└── store/
    └── ui-store.ts       # Zustand state (no auth state currently)
```

**Current Auth Pattern:**
```typescript
// In api.ts makeRequest helper
if (apiKey) {
  headers['X-API-Key'] = apiKey
}
```

**Storage:** API key stored in `localStorage.getItem('accu_mk1_api_key')`

## Target Architecture with JWT

### Backend Components

#### 1. New Files

**backend/auth/models.py** - User model extending fastapi-users base
```python
from fastapi_users.db import SQLAlchemyBaseUserTable
from sqlalchemy import String, Enum
from sqlalchemy.orm import Mapped, mapped_column
import enum

class UserRole(enum.Enum):
    STANDARD = "standard"
    ADMIN = "admin"

class User(SQLAlchemyBaseUserTable[int], Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False)
    hashed_password: Mapped[str] = mapped_column(String(1024), nullable=False)
    is_active: Mapped[bool] = mapped_column(default=True)
    is_superuser: Mapped[bool] = mapped_column(default=False)
    is_verified: Mapped[bool] = mapped_column(default=False)

    # Custom field for role-based access
    role: Mapped[UserRole] = mapped_column(Enum(UserRole), default=UserRole.STANDARD)
```

**backend/auth/schemas.py** - Pydantic schemas for user operations
```python
from fastapi_users import schemas

class UserRead(schemas.BaseUser[int]):
    role: str

class UserCreate(schemas.BaseUserCreate):
    role: str = "standard"

class UserUpdate(schemas.BaseUserUpdate):
    role: Optional[str] = None
```

**backend/auth/manager.py** - User management logic
```python
from fastapi_users import BaseUserManager, IntegerIDMixin
from typing import Optional

SECRET = os.environ.get("JWT_SECRET", "CHANGE_THIS_SECRET")

class UserManager(IntegerIDMixin, BaseUserManager[User, int]):
    reset_password_token_secret = SECRET
    verification_token_secret = SECRET

    async def on_after_register(self, user: User, request: Optional[Request] = None):
        print(f"User {user.id} has registered.")
```

**backend/auth/config.py** - Authentication configuration
```python
from fastapi_users.authentication import (
    AuthenticationBackend,
    BearerTransport,
    JWTStrategy,
)

bearer_transport = BearerTransport(tokenUrl="auth/jwt/login")

def get_jwt_strategy() -> JWTStrategy:
    return JWTStrategy(
        secret=SECRET,
        lifetime_seconds=3600,  # 1 hour access token
        algorithm="HS256"
    )

auth_backend = AuthenticationBackend(
    name="jwt",
    transport=bearer_transport,
    get_strategy=get_jwt_strategy,
)
```

**backend/auth/dependencies.py** - FastAPI dependencies for auth
```python
from fastapi import Depends, HTTPException, status
from fastapi_users import FastAPIUsers
from backend.auth.config import auth_backend
from backend.auth.manager import UserManager, get_user_manager
from backend.auth.models import User

fastapi_users = FastAPIUsers[User, int](
    get_user_manager,
    [auth_backend],
)

# Reusable dependencies
current_active_user = fastapi_users.current_user(active=True)
current_superuser = fastapi_users.current_user(active=True, superuser=True)

# Custom role checker
def require_admin(user: User = Depends(current_active_user)) -> User:
    if user.role != UserRole.ADMIN:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required"
        )
    return user
```

#### 2. Modified Files

**backend/database.py** - No major changes
- User model imports from auth/models.py
- init_db() will create users table automatically

**backend/main.py** - Mount auth routers, update dependencies
```python
from backend.auth.dependencies import (
    fastapi_users,
    current_active_user,
    require_admin,
    auth_backend
)
from backend.auth.schemas import UserRead, UserCreate, UserUpdate

# Mount auth routers (add these includes)
app.include_router(
    fastapi_users.get_auth_router(auth_backend),
    prefix="/auth/jwt",
    tags=["auth"],
)
app.include_router(
    fastapi_users.get_register_router(UserRead, UserCreate),
    prefix="/auth",
    tags=["auth"],
)
app.include_router(
    fastapi_users.get_reset_password_router(),
    prefix="/auth",
    tags=["auth"],
)
app.include_router(
    fastapi_users.get_verify_router(UserRead),
    prefix="/auth",
    tags=["auth"],
)
app.include_router(
    fastapi_users.get_users_router(UserRead, UserUpdate),
    prefix="/users",
    tags=["users"],
)

# Update protected endpoints
@app.get("/explorer/environments")
async def get_explorer_environments(
    user: User = Depends(current_active_user)  # Changed from verify_api_key
):
    # Existing logic

# Admin-only endpoints
@app.post("/admin/settings")
async def update_settings(
    setting: SettingUpdate,
    user: User = Depends(require_admin)  # Admin check
):
    # Existing logic
```

**backend/models.py** - Optionally link AuditLog to User
```python
# Add user_id to AuditLog for tracking who performed actions
user_id: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id"), nullable=True)
```

### Frontend Components

#### 1. New Files

**src/lib/auth.ts** - Auth state and token management
```typescript
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface AuthState {
  accessToken: string | null
  user: { email: string; role: string; id: number } | null

  setAuth: (token: string, user: AuthState['user']) => void
  clearAuth: () => void
  isAuthenticated: () => boolean
  isAdmin: () => boolean
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      accessToken: null,
      user: null,

      setAuth: (token, user) => set({ accessToken: token, user }),
      clearAuth: () => set({ accessToken: null, user: null }),
      isAuthenticated: () => get().accessToken !== null,
      isAdmin: () => get().user?.role === 'admin',
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({
        accessToken: state.accessToken,
        user: state.user,
      }),
    }
  )
)
```

**src/lib/api-auth.ts** - Auth-specific API calls
```typescript
import { getApiBaseUrl } from './config'
import { useAuthStore } from './auth'

export interface LoginRequest {
  username: string  // fastapi-users uses username field for email
  password: string
}

export interface LoginResponse {
  access_token: string
  token_type: string
}

export interface UserResponse {
  id: number
  email: string
  role: string
  is_active: boolean
  is_superuser: boolean
  is_verified: boolean
}

export async function login(email: string, password: string): Promise<void> {
  const response = await fetch(`${getApiBaseUrl()}/auth/jwt/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: email, password }),
  })

  if (!response.ok) {
    throw new Error('Login failed')
  }

  const data: LoginResponse = await response.json()

  // Fetch user details
  const userResponse = await fetch(`${getApiBaseUrl()}/users/me`, {
    headers: { Authorization: `Bearer ${data.access_token}` },
  })

  const user: UserResponse = await userResponse.json()

  useAuthStore.getState().setAuth(data.access_token, {
    id: user.id,
    email: user.email,
    role: user.role,
  })
}

export async function logout(): Promise<void> {
  const token = useAuthStore.getState().accessToken
  if (token) {
    await fetch(`${getApiBaseUrl()}/auth/jwt/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
  }
  useAuthStore.getState().clearAuth()
}

export async function register(email: string, password: string, role: string = 'standard'): Promise<void> {
  const response = await fetch(`${getApiBaseUrl()}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, role }),
  })

  if (!response.ok) {
    throw new Error('Registration failed')
  }
}
```

**src/components/LoginForm.tsx** - Login UI component
```typescript
import { useState } from 'react'
import { login } from '../lib/api-auth'

export function LoginForm() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      await login(email, password)
      // Navigate to main app
    } catch (err) {
      setError('Invalid email or password')
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Email"
      />
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Password"
      />
      {error && <div>{error}</div>}
      <button type="submit">Login</button>
    </form>
  )
}
```

#### 2. Modified Files

**src/lib/api.ts** - Update to use Bearer tokens
```typescript
import { useAuthStore } from './auth'

// Update makeRequest helper (around line 752)
function makeRequest(endpoint: string, options: RequestInit = {}): Promise<Response> {
  const token = useAuthStore.getState().accessToken

  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  }

  // Replace X-API-Key with Bearer token
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  return fetch(`${API_BASE_URL()}${endpoint}`, {
    ...options,
    headers,
  })
}
```

**src/lib/api-key.ts** - Deprecate or remove
```typescript
// This file can be removed or marked as deprecated
// Token management now in auth.ts
```

**src/App.tsx** - Add route protection
```typescript
import { useAuthStore } from './lib/auth'
import { LoginForm } from './components/LoginForm'

function App() {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated())

  if (!isAuthenticated) {
    return <LoginForm />
  }

  return (
    // Existing app layout
  )
}
```

## Data Flow

### Authentication Flow

```
1. User enters credentials
   └→ LoginForm.tsx

2. POST /auth/jwt/login (username + password as form data)
   └→ FastAPI Users processes login
   └→ Validates credentials via UserManager
   └→ Returns { access_token, token_type }

3. Frontend stores token
   └→ useAuthStore.setAuth(token, user)
   └→ Token saved to localStorage via zustand persist

4. GET /users/me with Bearer token
   └→ Fetch user details (id, email, role)
   └→ Store user info in auth state
```

### Request Flow (Authenticated)

```
Frontend Request:
  api.ts makeRequest()
  └→ Get token from useAuthStore
  └→ Add Authorization: Bearer {token} header
  └→ fetch(endpoint, { headers })

Backend Processing:
  FastAPI receives request
  └→ Bearer transport extracts token from Authorization header
  └→ JWT strategy validates token signature & expiration
  └→ UserManager loads User from database
  └→ Depends(current_active_user) injects User into handler
  └→ Handler checks user.role if needed
  └→ Return response

Frontend Response:
  ✓ 200-299: Process response
  ✗ 401: Token expired → Clear auth, redirect to login
  ✗ 403: Insufficient permissions → Show error
```

### Token Refresh Flow (Optional Enhancement)

```
1. Request fails with 401
   └→ Axios response interceptor catches error

2. POST /auth/jwt/refresh (with current token)
   └→ Backend validates refresh token
   └→ Returns new access_token

3. Retry original request
   └→ Update Authorization header with new token
   └→ Return response to caller
```

**Note:** fastapi-users does NOT include token refresh by default. Must implement manually or use short-lived tokens (1 hour) and require re-login.

## Component Boundaries

### Backend Layers

| Layer | Components | Responsibility |
|-------|-----------|---------------|
| **Transport** | BearerTransport | Extract token from Authorization header |
| **Strategy** | JWTStrategy | Validate token signature, decode payload |
| **User Manager** | UserManager | Load user from DB, handle registration/password reset |
| **Database** | SQLAlchemy User model | Persist user data, query users |
| **Route Protection** | current_active_user dependency | Inject authenticated user into handlers |
| **Authorization** | require_admin dependency | Check user.role for permission |

### Frontend Layers

| Layer | Components | Responsibility |
|-------|-----------|---------------|
| **State Management** | useAuthStore (Zustand) | Store token and user info, persist to localStorage |
| **API Client** | api.ts makeRequest() | Add Bearer token to all requests |
| **Auth API** | api-auth.ts | Login, logout, register functions |
| **UI Components** | LoginForm, ProtectedRoute | User authentication flows |
| **Route Guards** | App.tsx isAuthenticated check | Redirect unauthenticated users |

## Migration Strategy

### Phase 1: Backend Auth Infrastructure
**Goal:** Add User model and auth routers without breaking existing API

1. Create auth/ directory with models, schemas, manager, config
2. Add User table to database (run alembic migration or manual CREATE TABLE)
3. Mount fastapi-users routers under /auth/ and /users/ prefixes
4. Keep existing verify_api_key endpoints working (dual auth temporarily)

**Validation:** POST /auth/register creates user, POST /auth/jwt/login returns token, GET /users/me returns user with Bearer token

### Phase 2: Frontend Auth State
**Goal:** Add login UI and token storage without breaking existing features

1. Create useAuthStore with Zustand persist
2. Create api-auth.ts with login/logout/register functions
3. Build LoginForm component
4. Keep existing API calls working (api.ts still uses X-API-Key if present)

**Validation:** User can login, token stored in localStorage, token visible in Zustand devtools

### Phase 3: Migrate API Client
**Goal:** Switch from X-API-Key to Bearer tokens

1. Update api.ts makeRequest() to use Authorization header
2. Update all fetch calls to check useAuthStore instead of api-key.ts
3. Handle 401 responses (clear auth, redirect to login)
4. Deprecate api-key.ts functions

**Validation:** All API calls use Bearer token, 401 errors redirect to login

### Phase 4: Migrate Backend Endpoints
**Goal:** Replace verify_api_key with current_active_user

1. Replace `Depends(verify_api_key)` with `Depends(current_active_user)` on protected endpoints
2. Add admin checks with `Depends(require_admin)` where needed
3. Remove verify_api_key function
4. Remove API_KEY environment variable

**Validation:** All protected endpoints require valid JWT, admin endpoints check user.role

### Phase 5: Role-Based Features
**Goal:** Add role-specific UI and permissions

1. Add isAdmin() checks in frontend for admin-only UI elements
2. Add admin-only routes/pages
3. Update audit logs to track user_id
4. Add user management UI (admin only)

**Validation:** Standard users cannot access admin features, audit logs show user_id

## Architecture Patterns to Follow

### Pattern 1: Dependency Factory
**What:** Create dependencies as module-level variables, not inline

**Example:**
```python
# Good
current_active_user = fastapi_users.current_user(active=True)

@app.get("/protected")
def protected(user: User = Depends(current_active_user)):
    pass

# Bad - creates new dependency on every route definition
@app.get("/protected")
def protected(user: User = Depends(fastapi_users.current_user(active=True))):
    pass
```

**Why:** Improves testability, allows dependency overriding, reduces memory

### Pattern 2: Layered Authorization
**What:** Separate authentication (who are you) from authorization (what can you do)

**Example:**
```python
# Authentication layer
current_active_user = fastapi_users.current_user(active=True)

# Authorization layer
def require_admin(user: User = Depends(current_active_user)) -> User:
    if user.role != UserRole.ADMIN:
        raise HTTPException(403)
    return user

# Use in routes
@app.delete("/admin/users/{user_id}")
async def delete_user(user_id: int, admin: User = Depends(require_admin)):
    pass
```

**Why:** Reusable permission checks, clear separation of concerns, easy to extend

### Pattern 3: Frontend Token Abstraction
**What:** Centralize token access in Zustand store, never directly access localStorage

**Example:**
```typescript
// Good
const token = useAuthStore.getState().accessToken

// Bad
const token = localStorage.getItem('auth-storage')
```

**Why:** Single source of truth, easier to mock in tests, can change storage strategy

### Pattern 4: Graceful Auth Failure
**What:** Handle 401/403 gracefully without breaking UI

**Example:**
```typescript
try {
  const data = await fetchProtectedData()
  return data
} catch (error) {
  if (error.status === 401) {
    useAuthStore.getState().clearAuth()
    navigate('/login')
  } else if (error.status === 403) {
    toast.error('You do not have permission to perform this action')
  }
  throw error
}
```

**Why:** Better UX, clear error messages, automatic session cleanup

## Anti-Patterns to Avoid

### Anti-Pattern 1: Hardcoded JWT Secret
**What goes wrong:** Using default or predictable JWT_SECRET allows attackers to forge tokens

**Prevention:**
```python
# Bad
SECRET = "my-secret-key"

# Good
SECRET = os.environ.get("JWT_SECRET")
if not SECRET or SECRET == "CHANGE_THIS_SECRET":
    raise ValueError("JWT_SECRET must be set to a strong random value")
```

**Detection:** Check .env files into git, default secrets in code

### Anti-Pattern 2: Storing Sensitive Data in JWT
**What goes wrong:** JWTs are base64-encoded, not encrypted. Readable by anyone.

**Prevention:**
```python
# Bad - hashed password visible in JWT
payload = {"user_id": user.id, "hashed_password": user.hashed_password}

# Good - only identifiers
payload = {"user_id": user.id, "role": user.role}
```

**Detection:** Large JWT tokens, sensitive fields in token claims

### Anti-Pattern 3: No Token Expiration
**What goes wrong:** Stolen tokens remain valid forever

**Prevention:**
```python
# Good - 1 hour expiration
JWTStrategy(secret=SECRET, lifetime_seconds=3600)
```

**Detection:** Users never need to re-login, tokens work indefinitely

### Anti-Pattern 4: Mixing Auth Strategies
**What goes wrong:** Supporting both API keys and JWT creates security holes

**Prevention:**
- Use JWT for user authentication
- Use API keys only for service-to-service communication (if needed)
- Never allow same endpoint to accept both

**Detection:** Routes with multiple auth dependencies, OR logic in auth checks

### Anti-Pattern 5: Client-Side Authorization Only
**What goes wrong:** Hiding UI elements doesn't prevent API access

**Prevention:**
```typescript
// Frontend - hide admin UI
{isAdmin() && <AdminButton />}

// Backend - MUST enforce
@app.delete("/users/{id}")
async def delete_user(id: int, admin: User = Depends(require_admin)):
    pass
```

**Detection:** Admin features accessible via API without admin token

## Tauri-Specific Considerations

### Storage Security

**Desktop apps CAN safely use localStorage:**
- No XSS risk (single origin, no third-party scripts)
- File system access already trusted (app has access to OS)
- Tauri's IPC sandboxing prevents malicious webviews from accessing storage

**Alternative: Tauri Store Plugin**
```typescript
import { Store } from 'tauri-plugin-store-api'

const store = new Store('.auth.dat')
await store.set('access_token', token)
const token = await store.get('access_token')
```

**When to use:** If you need encrypted storage or OS keychain integration. For basic JWT tokens, localStorage is sufficient.

### CORS Configuration

Desktop app runs on `tauri://localhost`, which is a special origin. Backend must allow it:

```python
from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",    # Vite dev server
        "tauri://localhost",         # Tauri production
        "http://tauri.localhost",    # Tauri dev (Windows)
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

### API Base URL Detection

Tauri needs different API URLs for dev vs production:

```typescript
export function getApiBaseUrl(): string {
  // Check if running in Tauri
  if (window.__TAURI__) {
    return 'http://localhost:8000'  // Backend always on localhost for desktop
  }

  // Browser - use env var or relative path
  return import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000'
}
```

## Scalability Considerations

| Concern | At 10 Users | At 100 Users | At 1000+ Users |
|---------|------------|--------------|----------------|
| **Token Secret** | Single SECRET env var | Same | Rotate secrets with versioning |
| **Token Expiration** | 1 hour is fine | Same | Consider 15-30 min + refresh tokens |
| **Database** | SQLite works | SQLite works | Migrate to PostgreSQL for concurrent writes |
| **Session Storage** | In-memory JWT validation | Same | Consider Redis for token blacklisting |
| **Rate Limiting** | Not needed | Add to /auth/login | Add to all public endpoints |
| **User Management** | Manual via SQL | Build admin UI | Add user provisioning API |

## Security Checklist

Before deploying to production:

- [ ] JWT_SECRET is strong random value (not default)
- [ ] JWT_SECRET stored in environment variable (not committed to git)
- [ ] Token expiration set to reasonable value (≤1 hour)
- [ ] HTTPS enforced in production
- [ ] CORS restricted to known origins
- [ ] Password hashing uses strong algorithm (bcrypt/argon2)
- [ ] Rate limiting on /auth/login endpoint
- [ ] Admin routes protected with require_admin dependency
- [ ] Frontend hides admin UI from standard users
- [ ] Backend enforces authorization on all protected endpoints
- [ ] Sensitive data NOT stored in JWT payload
- [ ] 401/403 errors handled gracefully in UI

## Build Order (Dependencies)

```
Backend Phase 1: Auth Infrastructure
  ├─ User model (depends on: database.py Base)
  ├─ Auth schemas (depends on: User model)
  ├─ UserManager (depends on: User model)
  ├─ JWT config (depends on: UserManager)
  └─ Mount auth routers (depends on: JWT config)

Frontend Phase 2: Auth State
  ├─ useAuthStore (depends on: nothing - can start immediately)
  ├─ api-auth.ts (depends on: useAuthStore, backend auth routers)
  └─ LoginForm (depends on: api-auth.ts)

Integration Phase 3: Connect Frontend to Backend
  ├─ Update api.ts (depends on: useAuthStore)
  └─ Update App.tsx routing (depends on: useAuthStore, LoginForm)

Migration Phase 4: Replace Old Auth
  ├─ Update backend endpoints (depends on: current_active_user dependency)
  └─ Remove verify_api_key (depends on: all endpoints migrated)

Enhancement Phase 5: Role-Based Features
  ├─ require_admin dependency (depends on: current_active_user)
  ├─ Admin UI components (depends on: useAuthStore.isAdmin())
  └─ Audit log user tracking (depends on: User model)
```

## Testing Strategy

### Backend Tests

```python
# Test protected endpoint
def test_protected_endpoint_requires_auth(client):
    response = client.get("/explorer/environments")
    assert response.status_code == 401

def test_protected_endpoint_with_token(client, user_token):
    response = client.get(
        "/explorer/environments",
        headers={"Authorization": f"Bearer {user_token}"}
    )
    assert response.status_code == 200

def test_admin_endpoint_rejects_standard_user(client, standard_user_token):
    response = client.delete(
        "/admin/users/1",
        headers={"Authorization": f"Bearer {standard_user_token}"}
    )
    assert response.status_code == 403
```

### Frontend Tests

```typescript
// Test login flow
test('login stores token and user', async () => {
  await login('test@example.com', 'password123')

  expect(useAuthStore.getState().accessToken).toBeTruthy()
  expect(useAuthStore.getState().user?.email).toBe('test@example.com')
})

// Test API client adds Bearer token
test('API requests include Bearer token', async () => {
  useAuthStore.getState().setAuth('test-token', { id: 1, email: 'test@example.com', role: 'standard' })

  const mockFetch = vi.fn()
  global.fetch = mockFetch

  await healthCheck()

  expect(mockFetch).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: 'Bearer test-token'
      })
    })
  )
})
```

## Sources and Confidence

| Topic | Confidence | Sources |
|-------|-----------|---------|
| FastAPI Users architecture | HIGH | [Official docs](https://fastapi-users.github.io/fastapi-users/latest/configuration/overview/), [Full example](https://fastapi-users.github.io/fastapi-users/10.1/configuration/full-example/) |
| JWT authentication patterns | HIGH | [FastAPI JWT tutorial](https://fastapi.tiangolo.com/tutorial/security/oauth2-jwt/), [TestDriven.io guide](https://testdriven.io/blog/fastapi-jwt-auth/) |
| SQLAlchemy 2.0 integration | HIGH | [Medium: FastAPI + Async SQLAlchemy 2.0 + JWT](https://medium.com/algomart/fastapi-async-sqlalchemy-2-0-jwt-postgresql-boilerplate-setup-19e74d6bad5c) |
| React JWT storage | MEDIUM | [Dev.to: JWT storage guide](https://dev.to/zeeshanali0704/authentication-in-react-with-jwts-access-refresh-tokens-569i), [WorkOS: Secure JWT storage](https://workos.com/blog/secure-jwt-storage) |
| Tauri token storage | HIGH | [Tauri security docs](https://v2.tauri.app/security/), [Medium: Tauri token storage](https://vincenteliezer.medium.com/building-a-cross-platform-admin-desktop-app-with-next-js-tauri-rust-token-storage-234c6e88bf2d) |
| Roles/permissions patterns | MEDIUM | [GitHub discussion](https://github.com/fastapi-users/fastapi-users/discussions/454), [Dev.to: Modern permission management](https://dev.to/mochafreddo/building-a-modern-user-permission-management-system-with-fastapi-sqlalchemy-and-mariadb-5fp1) |
| Token refresh patterns | MEDIUM | [Medium: JWT refresh tokens](https://medium.com/@jagan_reddy/jwt-in-fastapi-the-secure-way-refresh-tokens-explained-f7d2d17b1d17), [Dev.to: Axios interceptors](https://dev.to/ayon_ssp/jwt-refresh-with-axios-interceptors-in-react-2bnk) |
| Dependency injection | HIGH | [FastAPI Users: current_user](https://fastapi-users.github.io/fastapi-users/10.0/usage/current-user/), [TheLinuxCode: DI playbook](https://thelinuxcode.com/dependency-injection-in-fastapi-2026-playbook-for-modular-testable-apis/) |

## Key Takeaways for Roadmap

1. **Backend can be built independently** - Add User model and auth routers without touching existing endpoints
2. **Frontend can be built independently** - Add login UI and token storage without breaking existing API calls
3. **Migration is gradual** - Can run dual auth (X-API-Key + JWT) during transition
4. **Roles require manual extension** - fastapi-users doesn't include RBAC, must add role field to User model
5. **Token refresh is optional** - fastapi-users doesn't include it, can defer or use short-lived tokens + re-login
6. **Tauri storage is safe** - localStorage works fine for desktop apps, no XSS risk

**Critical path:** User model → JWT config → Mount routers → Frontend token storage → Update API client → Migrate endpoints

**Likely research flags:**
- Token refresh implementation (if needed beyond 1-hour tokens)
- Admin user provisioning (how to create first admin)
- Migration strategy for existing data (if any user-specific data exists)

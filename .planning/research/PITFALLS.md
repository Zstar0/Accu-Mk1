# Domain Pitfalls: Adding JWT Authentication to Existing FastAPI + React App

**Domain:** Retrofitting user authentication onto existing unprotected system
**Researched:** 2026-02-09
**Context:** FastAPI + React (Tauri desktop) app, currently using X-API-Key, adding FastAPI Users with JWT Bearer tokens

---

## Critical Pitfalls

Mistakes that cause rewrites, security vulnerabilities, or major system breakage.

### Pitfall 1: Breaking All Existing Endpoints at Once

**What goes wrong:** Adding authentication dependencies to existing endpoints breaks all current API consumers immediately. The app becomes unusable until every single endpoint is migrated and every client is updated.

**Why it happens:**
- Developers add `Depends(current_user)` to existing routes thinking it's just "adding security"
- No migration strategy for gradual rollout
- Underestimating how many places call the API

**Consequences:**
- Complete system outage during migration
- Can't test authentication incrementally
- Rollback requires removing all auth changes
- Tauri desktop app and any other clients stop working instantly

**Prevention:**
1. **Phase endpoints migration, don't big-bang:**
   - Phase 1: Add new `/auth` endpoints (register, login, logout) - no breaking changes
   - Phase 2: Add optional authentication to existing endpoints (accept both X-API-Key and JWT)
   - Phase 3: Make authentication required on critical endpoints
   - Phase 4: Deprecate X-API-Key with timeline

2. **Create dual-auth dependency:**
   ```python
   async def get_current_user_optional(
       api_key: Optional[str] = Header(None, alias="X-API-Key"),
       token: Optional[str] = Depends(oauth2_scheme_optional)
   ):
       # Try JWT first, fall back to API key
       if token:
           return await verify_jwt_token(token)
       if api_key:
           return await verify_api_key(api_key)
       return None  # Allow anonymous for backward compatibility
   ```

3. **Use feature flags** to control rollout per endpoint

**Detection:**
- Running existing client code against new backend fails with 401/403
- Integration tests for existing flows break
- Tauri app can't fetch data after backend update

**Which phase:** Phase 1 (Auth Foundation) must establish dual-auth pattern BEFORE touching existing endpoints

---

### Pitfall 2: Token Storage in Tauri - Local Storage XSS Vulnerability

**What goes wrong:** Storing JWT tokens in localStorage makes them vulnerable to XSS attacks. In a Tauri app, this is a critical security issue since the app has filesystem access.

**Why it happens:**
- React tutorials typically show localStorage for simplicity
- Developers don't realize Tauri apps run in a webview with elevated privileges
- HttpOnly cookies don't work the same way in Tauri as in browsers

**Consequences:**
- If XSS vulnerability exists anywhere in React app, attacker can steal tokens
- Stolen token = full user impersonation
- In Tauri, XSS could potentially access filesystem, not just steal tokens
- Refresh tokens in localStorage = long-term persistent access for attackers

**Prevention:**

**For Tauri desktop app:**
1. Use Tauri's secure storage plugin (tauri-plugin-store) for tokens
2. Never store refresh tokens in localStorage or sessionStorage
3. Use Tauri's IPC to handle token storage in Rust backend

```typescript
// WRONG - vulnerable to XSS
localStorage.setItem('access_token', token);

// RIGHT - Tauri secure storage
import { Store } from 'tauri-plugin-store-api';
const store = new Store('.settings.dat');
await store.set('access_token', token);
```

**For browser deployment:**
1. Store access token in memory (React state/context)
2. Store refresh token in httpOnly cookie (requires backend to set it)
3. Accept that user must re-authenticate on page refresh OR
4. Use silent refresh pattern with httpOnly refresh token cookie

**Detection:**
- Security audit finds tokens in localStorage
- XSS vulnerability scan shows token theft is possible
- Tauri app stores sensitive data in plain text in localStorage

**Which phase:** Phase 1 (Auth Foundation) - must decide token storage strategy before implementing login

---

### Pitfall 3: CORS Configuration Breaks Credential Passing

**What goes wrong:** FastAPI CORS middleware isn't configured for credentials, causing JWT bearer tokens in Authorization headers to be blocked. Or worse, using `allow_origins=["*"]` with `allow_credentials=True` which browsers reject.

**Why it happens:**
- Default CORS config doesn't include `allow_credentials=True`
- Developers set `allow_origins=["*"]` which is incompatible with credentials
- Different config needed for development (localhost:3000) vs production

**Consequences:**
- Login works but subsequent authenticated requests fail with CORS error
- Browser silently drops Authorization header
- Error messages are cryptic: "CORS policy: Credentials flag is 'true', but the 'Access-Control-Allow-Credentials' header is ''"

**Prevention:**

```python
# WRONG - allows any origin but credentials won't work
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,  # IGNORED - browsers reject this combination
)

# RIGHT - specific origins with credentials
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",  # React dev server
        "https://yourdomain.com",  # Production
        "tauri://localhost",      # Tauri custom protocol
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

**Tauri-specific consideration:** Tauri uses custom protocol (`tauri://localhost`), must be in allowed origins.

**Detection:**
- Browser console shows CORS error when making authenticated requests
- Login succeeds but fetching user data fails
- Works in development but breaks in production (different origins)

**Which phase:** Phase 1 (Auth Foundation) - configure CORS before testing login flow

---

### Pitfall 4: Race Condition - React Router Renders Before Auth Check Completes

**What goes wrong:** On initial page load, React Router renders routes before authentication status is verified, causing protected routes to redirect to login, then immediately redirect back when auth loads.

**Why it happens:**
- AuthProvider initializes with `isLoading: true` but RouterProvider doesn't wait
- Token verification is async but route rendering is synchronous
- No loading state shown while checking authentication

**Consequences:**
- Flash of login page even when user is authenticated
- Infinite redirect loop between login and protected routes
- Poor UX - users see unauthorized page briefly before correct page loads
- Race condition makes testing unreliable

**Prevention:**

```typescript
// WRONG - Router renders immediately, auth state loads later
function App() {
  return (
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  );
}

// RIGHT - Wait for auth check before rendering routes
function App() {
  const { isLoading, isAuthenticated } = useAuth();

  if (isLoading) {
    return <LoadingSpinner />;  // Show spinner while verifying token
  }

  return <RouterProvider router={router} />;
}

// Protected route checks loading state first
function ProtectedRoute({ children }) {
  const { isLoading, isAuthenticated } = useAuth();

  if (isLoading) {
    return <LoadingSpinner />;  // Critical - check loading BEFORE auth
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" />;
  }

  return children;
}
```

**Detection:**
- Visual flash of wrong page on initial load
- Redirect loop in browser dev tools network tab
- Protected routes briefly show unauthorized state

**Which phase:** Phase 2 (Protected Routes) - structure auth context correctly before adding route protection

---

### Pitfall 5: JWT Can't Be Invalidated - No Server-Side Logout

**What goes wrong:** JWTs are stateless and can't be revoked. When user logs out, the token is removed from client but remains valid until expiration. If token is stolen, attacker can use it until it expires.

**Why it happens:**
- Developers assume deleting token from client = user is logged out
- No token blacklist/revocation mechanism implemented
- JWT expiration set too long (days/weeks)

**Consequences:**
- Compromised tokens remain valid for hours/days after "logout"
- Can't force logout of specific user (e.g., suspicious activity, password change)
- Can't invalidate all sessions when security incident occurs
- User expects logout to be immediate and complete

**Prevention:**

**Option 1: Short-lived access tokens + refresh tokens (recommended)**
- Access token: 15-30 minutes expiration
- Refresh token: stored server-side, can be revoked
- On logout, invalidate refresh token in database
- Stolen access token expires quickly

```python
# In database model
class RefreshToken(Base):
    token: str
    user_id: int
    expires_at: datetime
    revoked: bool = False  # Can set to True on logout
```

**Option 2: Token blacklist (Redis)**
- Store revoked tokens in Redis with TTL = token expiration time
- Check blacklist on every authenticated request
- Performance impact on every request

**Option 3: Token versioning**
- Add `token_version` to user model
- Include in JWT payload
- Increment version on logout/password change
- Verify version matches on each request

**Detection:**
- User logs out but can still access API with old token
- Security audit shows no token revocation mechanism
- No way to force logout specific user

**Which phase:** Phase 1 (Auth Foundation) - decide revocation strategy before implementing JWT

---

### Pitfall 6: Database Migration Breaks Production - No Rollback Plan

**What goes wrong:** Adding `users` table and foreign keys to existing tables in production fails mid-migration, leaving database in inconsistent state with no clear rollback path.

**Why it happens:**
- Testing migration on empty database, not production-like data
- No down() migration written
- Foreign key constraints conflict with existing data
- SQLite limitations with Alembic batch operations

**Consequences:**
- Production database corrupted
- Can't rollback migration cleanly
- Existing app can't run (missing tables) and new app can't run (partial migration)
- Data loss if migration is forced

**Prevention:**

1. **Always write reversible migrations:**
```python
def upgrade():
    # Add users table
    op.create_table('users', ...)

    # Add FK to existing table AFTER users table exists
    op.add_column('analyses', sa.Column('created_by_id', sa.Integer, nullable=True))
    op.create_foreign_key('fk_analyses_user', 'analyses', 'users', ['created_by_id'], ['id'])

def downgrade():
    # Reverse in opposite order
    op.drop_constraint('fk_analyses_user', 'analyses')
    op.drop_column('analyses', 'created_by_id')
    op.drop_table('users')
```

2. **Make foreign keys nullable initially:**
   - Don't require `created_by_id` to exist for old records
   - Add column as `nullable=True`
   - Optionally backfill with admin user ID
   - Make non-nullable in future migration if needed

3. **Test on production-like data:**
   - Copy production database to staging
   - Run migration on real data
   - Test rollback works

4. **SQLite batch mode for constraints:**
```python
with op.batch_alter_table('analyses') as batch_op:
    batch_op.add_column(sa.Column('created_by_id', sa.Integer, nullable=True))
    batch_op.create_foreign_key('fk_analyses_user', 'users', ['created_by_id'], ['id'])
```

**Detection:**
- Migration fails with foreign key constraint error
- `alembic downgrade` fails or doesn't exist
- Can't run either old or new version of app

**Which phase:** Phase 1 (Auth Foundation) - before running any migrations

---

## Moderate Pitfalls

Mistakes that cause delays, technical debt, or user frustration.

### Pitfall 7: Token Expiration Without Refresh = Poor UX

**What goes wrong:** Access token expires while user is actively using the app, forcing them to login again mid-session. No automatic refresh mechanism.

**Why it happens:**
- Only implementing access tokens, no refresh flow
- Not intercepting 401 responses to refresh token
- Token expiration too short without refresh strategy

**Consequences:**
- User filling out form, token expires, form submission fails
- User forced to login multiple times per day
- Data loss when token expires mid-operation

**Prevention:**

1. **Implement silent refresh pattern:**
```typescript
// Axios interceptor for automatic token refresh
axios.interceptors.response.use(
  response => response,
  async error => {
    if (error.response?.status === 401) {
      try {
        const newToken = await refreshAccessToken();
        // Retry original request with new token
        error.config.headers['Authorization'] = `Bearer ${newToken}`;
        return axios.request(error.config);
      } catch (refreshError) {
        // Refresh failed, redirect to login
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);
```

2. **Use appropriate token lifetimes:**
   - Access token: 15-30 minutes (short enough to be secure)
   - Refresh token: 7-30 days (user doesn't re-login frequently)

3. **Queue refresh requests to prevent race condition:**
   - Multiple concurrent requests with expired token
   - Only one should refresh, others should wait
   - Use promise queue pattern

**Detection:**
- Users complain about being logged out randomly
- 401 errors mid-session in logs
- No refresh endpoint in API

**Which phase:** Phase 1 (Auth Foundation) - implement refresh flow with initial auth

---

### Pitfall 8: Role Checks in Every Route Instead of Dependency

**What goes wrong:** Role-based access control logic is duplicated in every endpoint function instead of using reusable dependencies, leading to inconsistent permission checks.

**Why it happens:**
- Not understanding FastAPI dependency composition
- Copy-pasting permission checks
- No centralized permission system

**Consequences:**
- Inconsistent role checks (some endpoints check role, others forget)
- Hard to audit who can access what
- Changing role logic requires updating every endpoint
- Security vulnerabilities from missed checks

**Prevention:**

```python
# WRONG - permission check in endpoint
@router.get("/admin/users")
async def list_users(current_user: User = Depends(get_current_user)):
    if current_user.role != "admin":
        raise HTTPException(403, "Not authorized")
    return db.query(User).all()

# RIGHT - reusable permission dependency
async def require_admin(current_user: User = Depends(get_current_user)):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return current_user

@router.get("/admin/users")
async def list_users(admin: User = Depends(require_admin)):
    return db.query(User).all()
```

**Even better - role dependency factory:**
```python
def require_role(required_role: str):
    async def role_checker(current_user: User = Depends(get_current_user)):
        if current_user.role != required_role:
            raise HTTPException(403, f"{required_role} access required")
        return current_user
    return role_checker

@router.get("/admin/users", dependencies=[Depends(require_role("admin"))])
async def list_users(): ...
```

**Detection:**
- Role check logic scattered across endpoints
- Some endpoints missing permission checks
- Code review finds inconsistent patterns

**Which phase:** Phase 3 (Authorization/Roles) - establish dependency pattern before adding many protected endpoints

---

### Pitfall 9: Password Reset Without Email = Weak Security Model

**What goes wrong:** Console-based admin password reset for v1 (no email infrastructure) leads to poor security practices - admins resetting passwords and telling users the new password.

**Why it happens:**
- No email service configured yet
- Assuming console reset is "good enough for v1"
- Not considering security implications

**Consequences:**
- Passwords transmitted over insecure channels (Slack, email, phone)
- Admin knows user's password temporarily
- No audit trail of password resets
- Users don't change temporary password (security risk)

**Prevention:**

1. **Force password change on admin reset:**
```python
@router.post("/admin/reset-password/{user_id}")
async def admin_reset_password(
    user_id: int,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db)
):
    user = db.query(User).filter(User.id == user_id).first()
    temp_password = generate_secure_random_password()
    user.hashed_password = hash_password(temp_password)
    user.must_change_password = True  # Force change on next login
    db.commit()

    # Log action for audit
    log_admin_action(admin.id, "password_reset", user_id)

    return {"temporary_password": temp_password, "must_change": True}
```

2. **Audit trail:**
   - Log who reset password and when
   - Log IP address and user agent
   - Alert user that password was reset (if email available later)

3. **Secure delivery:**
   - Generate strong random temporary password
   - Show only once to admin
   - Expire temporary password after first use or 24 hours

4. **Plan for email v2:**
   - Design with email in mind
   - Use database-backed password reset tokens
   - Easy to switch to email-based reset later

**Detection:**
- Users keeping admin-set passwords indefinitely
- No audit trail of password resets
- Passwords shared over insecure channels

**Which phase:** Phase 1 (Auth Foundation) - implement secure console reset pattern from start

---

### Pitfall 10: FastAPI Users is in Maintenance Mode

**What goes wrong:** Choosing FastAPI Users library without knowing it's in maintenance mode (no new features, only security updates). Future features may not be possible without switching libraries.

**Why it happens:**
- Not checking project status before adopting
- Assuming active development from popularity
- Not reading documentation carefully

**Consequences:**
- Stuck with current feature set
- Must switch libraries later for new features
- Migration work if switching to successor library
- Security updates only, no bug fixes for non-security issues

**Prevention:**

1. **Acknowledge maintenance mode in architecture decision:**
   - Document that library is stable but not evolving
   - Plan for potential migration to successor (in development by same team)
   - Ensure core features needed are already present

2. **Abstract authentication layer:**
   - Don't couple entire codebase to FastAPI Users
   - Create internal auth interfaces
   - Easier to swap implementations later

3. **Monitor for successor library:**
   - FastAPI Users team is building replacement
   - Track progress on GitHub
   - Plan migration window when stable

**What FastAPI Users provides (stable):**
- JWT authentication ✅
- Database backend ✅
- User registration/login ✅
- Role system (basic) ✅
- SQLAlchemy integration ✅

**What may require workarounds:**
- Complex role hierarchies
- Fine-grained permissions
- OAuth providers
- MFA (not built-in)

**Detection:**
- Feature request can't be implemented without library changes
- GitHub issues closed with "won't fix, maintenance mode"
- Realizing limitation after significant development

**Which phase:** Phase 0 (Research/Planning) - evaluate library status before committing

---

### Pitfall 11: Not Testing Both Browser and Tauri Auth Flows

**What goes wrong:** Authentication works perfectly in browser development but breaks in Tauri desktop app due to different security contexts, storage mechanisms, and CORS behavior.

**Why it happens:**
- Developing and testing only in browser
- Assuming Tauri is "just a browser"
- Not understanding Tauri's custom protocol and security model

**Consequences:**
- Auth works in browser but fails in Tauri
- Token storage incompatible between platforms
- CORS issues specific to Tauri
- Deployment blocked by platform-specific bugs

**Prevention:**

1. **Test matrix from day 1:**
   - Browser (Chrome/Firefox/Safari)
   - Tauri development mode
   - Tauri production build

2. **Environment-aware token storage:**
```typescript
import { invoke } from '@tauri-apps/api/tauri';

// Detect environment
const isTauri = window.__TAURI__ !== undefined;

async function storeToken(token: string) {
  if (isTauri) {
    // Use Tauri secure storage
    await invoke('store_token', { token });
  } else {
    // Use browser storage (sessionStorage or memory)
    sessionStorage.setItem('token', token);
  }
}
```

3. **Tauri-specific CORS config:**
```python
# FastAPI CORS
allow_origins=[
    "http://localhost:3000",  # React dev
    "https://yourdomain.com", # Production web
    "tauri://localhost",      # Tauri custom protocol
    "http://tauri.localhost", # Alternative Tauri origin
]
```

**Detection:**
- Auth works in browser but 401 errors in Tauri
- Token storage errors in Tauri console
- CORS errors specific to Tauri

**Which phase:** Phase 2 (Protected Routes) - establish test matrix before deploying

---

## Minor Pitfalls

Mistakes that cause annoyance but are easily fixable.

### Pitfall 12: Weak Password Requirements Allow "password123"

**What goes wrong:** No password strength validation allows users to set weak passwords like "password", "123456", increasing security risk.

**Why it happens:**
- Using FastAPI Users default settings
- Not configuring custom password validator
- Assuming library handles it

**Prevention:**

```python
from fastapi_users import schemas
import re

class UserCreate(schemas.BaseUserCreate):
    @validator('password')
    def validate_password(cls, password):
        if len(password) < 8:
            raise ValueError('Password must be at least 8 characters')
        if not re.search(r'[A-Z]', password):
            raise ValueError('Password must contain uppercase letter')
        if not re.search(r'[a-z]', password):
            raise ValueError('Password must contain lowercase letter')
        if not re.search(r'\d', password):
            raise ValueError('Password must contain number')
        return password
```

**Detection:**
- Users registering with weak passwords
- Security audit flags weak password policy

**Which phase:** Phase 1 (Auth Foundation) - configure during schema setup

---

### Pitfall 13: No Username Display - Only Email

**What goes wrong:** Using email as the only identifier means user's email is displayed everywhere in UI, which users may not want (privacy concern).

**Why it happens:**
- FastAPI Users defaults to email-based auth
- Not adding username field to user model
- Assuming email is sufficient

**Prevention:**

```python
class User(SQLAlchemyBaseUserTable[int], Base):
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    username: Mapped[str] = mapped_column(String, unique=True, nullable=False)  # Add this
    hashed_password: Mapped[str] = mapped_column(String, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    is_superuser: Mapped[bool] = mapped_column(Boolean, default=False)
```

**Detection:**
- User feedback about displaying email everywhere
- Privacy concerns in UI

**Which phase:** Phase 1 (Auth Foundation) - decide user model fields before migrations

---

### Pitfall 14: Forgetting to Hash API Keys in Database

**What goes wrong:** During migration from X-API-Key to JWT, the existing API keys are stored in plain text in database, creating security vulnerability if database is compromised.

**Why it happens:**
- API keys were internal/development only, not considered sensitive
- Adding auth makes database more attractive to attackers
- Not treating API keys like passwords

**Prevention:**

1. **Hash API keys like passwords:**
```python
import secrets
import hashlib

def hash_api_key(api_key: str) -> str:
    return hashlib.sha256(api_key.encode()).hexdigest()

# When creating API key
raw_key = secrets.token_urlsafe(32)
hashed = hash_api_key(raw_key)
# Store hashed in database, show raw_key only once to user
```

2. **Migration plan:**
   - Generate new hashed API keys
   - Invalidate old plain-text keys
   - Notify users to update

**Detection:**
- Database dump shows API keys in plain text
- Security audit flags unencrypted credentials

**Which phase:** Phase 1 (Auth Foundation) - before creating API key migration

---

### Pitfall 15: No Rate Limiting on Login Endpoint

**What goes wrong:** Login endpoint has no rate limiting, allowing brute force password attacks.

**Why it happens:**
- Focusing on functionality, not security
- Assuming authentication library handles it
- Not considering attack vectors

**Prevention:**

```python
from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address)

@router.post("/auth/login")
@limiter.limit("5/minute")  # 5 attempts per minute
async def login(credentials: OAuth2PasswordRequestForm = Depends()):
    ...
```

**Better - account lockout:**
```python
# Track failed attempts in database
class User(Base):
    failed_login_attempts: int = 0
    locked_until: datetime | None = None

async def login(credentials):
    user = get_user_by_email(credentials.username)
    if user.locked_until and user.locked_until > datetime.now():
        raise HTTPException(429, "Account locked. Try again later")

    if not verify_password(credentials.password, user.hashed_password):
        user.failed_login_attempts += 1
        if user.failed_login_attempts >= 5:
            user.locked_until = datetime.now() + timedelta(minutes=15)
        db.commit()
        raise HTTPException(401, "Invalid credentials")

    # Reset on successful login
    user.failed_login_attempts = 0
    user.locked_until = None
    db.commit()
```

**Detection:**
- No rate limiting headers in login response
- Able to make unlimited login attempts
- Security audit flags brute force vulnerability

**Which phase:** Phase 1 (Auth Foundation) - add rate limiting before deployment

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| **Phase 1: Auth Foundation** | Breaking existing API with required auth | Use dual-auth pattern (JWT + API key), make endpoints gradually protected |
| **Phase 1: Auth Foundation** | CORS misconfiguration blocks credentials | Set `allow_credentials=True` with specific origins, include `tauri://localhost` |
| **Phase 1: Auth Foundation** | No token revocation mechanism | Implement refresh token strategy with server-side storage |
| **Phase 1: Auth Foundation** | Database migration fails in production | Test on production-like data, write reversible migrations, make FKs nullable |
| **Phase 2: Protected Routes** | Race condition - router renders before auth check | Wait for auth loading state before rendering routes |
| **Phase 2: Protected Routes** | Token storage vulnerable to XSS | Use Tauri secure storage for desktop, memory + httpOnly cookies for browser |
| **Phase 2: Protected Routes** | Token expires mid-session | Implement automatic token refresh with axios interceptor |
| **Phase 2: Protected Routes** | Browser and Tauri auth flows diverge | Test both platforms from day 1, abstract storage layer |
| **Phase 3: Authorization/Roles** | Permission checks duplicated in endpoints | Use dependency composition for role requirements |
| **Phase 3: Authorization/Roles** | N+1 queries checking permissions | Cache role in JWT payload, don't query DB for every permission check |
| **Phase 4: Migration** | X-API-Key consumers break when disabled | Provide deprecation timeline, support both auth methods during transition |
| **Phase 4: Migration** | No way to track who uses which auth method | Add logging/metrics to dual-auth dependency |

---

## Integration Pitfalls with Existing System

Specific to retrofitting auth onto Accu-Mk1's current architecture.

### Integration Pitfall 1: Explorer Endpoints Lose Access

**What:** The existing explorer functionality (currently using X-API-Key) breaks when auth is added to those endpoints.

**Prevention:**
- Keep explorer endpoints accessible with X-API-Key during Phase 1-3
- Add optional JWT support alongside X-API-Key
- Migrate explorer to use JWT in Phase 4 after main app is stable
- Consider if explorer needs authentication at all (read-only public data?)

### Integration Pitfall 2: Analysis Ownership Ambiguity

**What:** Existing analyses in database have no `created_by` field. When adding user authentication, unclear who owns historical data.

**Prevention:**
- Add `created_by_id` as nullable foreign key initially
- Create "System" or "Legacy" admin user
- Backfill historical records with system user ID
- Future analyses require authenticated user

### Integration Pitfall 3: Shared Desktop Sessions

**What:** Tauri desktop app may be installed on shared lab computers. Multiple users should be able to use same installation with different accounts.

**Prevention:**
- Implement proper logout that clears all stored credentials
- Don't persist tokens beyond app closure by default
- Add "Remember me" option that's opt-in, not default
- Clear session on app close unless explicitly kept

### Integration Pitfall 4: Offline Functionality Breaks

**What:** If Tauri app had any offline capabilities, requiring JWT authentication breaks them (can't verify token without server).

**Prevention:**
- Design token verification to gracefully fail offline
- Cache user data for offline access
- Queue authenticated actions when offline, sync when online
- Consider long-lived tokens with offline grace period

---

## Confidence Assessment

| Area | Confidence | Source Quality |
|------|-----------|----------------|
| **FastAPI JWT Security** | HIGH | Official FastAPI docs, Context7-equivalent sources, multiple 2026 guides |
| **React Auth Race Conditions** | HIGH | GitHub issues from React Router and Auth0 repos, documented patterns |
| **Tauri Token Storage** | MEDIUM | Tauri official security docs, inferred from general secure storage practices |
| **FastAPI Users Library** | HIGH | Official documentation, maintenance mode status confirmed |
| **Migration Strategies** | MEDIUM | Multiple real-world examples (Adobe, Google Cloud), API versioning guides |
| **Database Migrations** | HIGH | Alembic official documentation, SQLAlchemy patterns |
| **CORS + Credentials** | HIGH | FastAPI official docs, multiple verified sources |
| **Password Reset Security** | MEDIUM | Industry best practices from Google Workspace, Microsoft 365 admin guides |
| **Rate Limiting** | MEDIUM | Common patterns, library docs (slowapi) |

---

## Sources

### FastAPI JWT & Security
- [OAuth2 with Password (and hashing), Bearer with JWT tokens - FastAPI](https://fastapi.tiangolo.com/tutorial/security/oauth2-jwt/)
- [Securing FastAPI with JWT Token-based Authentication | TestDriven.io](https://testdriven.io/blog/fastapi-jwt-auth/)
- [Bulletproof JWT Authentication in FastAPI: A Complete Guide | Medium](https://medium.com/@ancilartech/bulletproof-jwt-authentication-in-fastapi-a-complete-guide-2c5602a38b4f)
- [JWT - FastAPI Users](https://fastapi-users.github.io/fastapi-users/10.3/configuration/authentication/strategies/jwt/)
- [Authentication and Authorization with FastAPI: A Complete Guide | Better Stack](https://betterstack.com/community/guides/scaling-python/authentication-fastapi/)

### Token Storage & Security
- [Security | Tauri](https://v2.tauri.app/security/)
- [Secure JWT Storage: Best Practices | Syncfusion](https://www.syncfusion.com/blogs/post/secure-jwt-storage-best-practices)
- [JWT Security Best Practices:Checklist for APIs | Curity](https://curity.io/resources/learn/jwt-best-practices/)
- [Token Storage - Auth0 Docs](https://auth0.com/docs/secure/security-guidance/data-security/token-storage)

### React Protected Routes & Race Conditions
- [Protected Routes in React Router: Secure Authentication Patterns](https://react.wiki/router/protected-routes/)
- [Race Condition, React Router flushes before React state updates · Issue #10232](https://github.com/remix-run/react-router/issues/10232)
- [Race condition between isAuthenticated and isLoading (redirects) · Issue #343](https://github.com/auth0/auth0-react/issues/343)
- [Building Reliable Protected Routes with React Router v7 - DEV Community](https://dev.to/ra1nbow1/building-reliable-protected-routes-with-react-router-v7-1ka0)

### API Migration & Backward Compatibility
- [Adobe: Migrating from Service Account (JWT) credential to OAuth](https://developer.adobe.com/developer-console/docs/guides/authentication/ServerToServerAuthentication/migration)
- [API key vs JWT: Secure B2B SaaS with modern M2M authentication](https://www.scalekit.com/blog/apikey-jwt-comparison)
- [Managing API Changes: 8 Strategies That Reduce Disruption | Theneo Blog](https://www.theneo.io/blog/managing-api-changes-strategies)
- [8 API Versioning Best Practices for Developers in 2026](https://getlate.dev/blog/api-versioning-best-practices)

### JWT Refresh Tokens
- [How do I handle JWT expiration and refresh token strategies? | CIAM Q&A](https://mojoauth.com/ciam-qna/how-to-handle-jwt-expiration-refresh-token-strategies)
- [Refresh Token Rotation | Auth.js](https://authjs.dev/guides/refresh-token-rotation)
- [What Are Refresh Tokens and How to Use Them Securely | Auth0](https://auth0.com/blog/refresh-tokens-what-are-they-and-when-to-use-them/)

### CORS Configuration
- [CORS (Cross-Origin Resource Sharing) - FastAPI](https://fastapi.tiangolo.com/tutorial/cors/)
- [Blocked by CORS in FastAPI? Here's How to Fix It](https://davidmuraya.com/blog/fastapi-cors-configuration/)

### Database Migrations
- [Database Migrations: What are the Types of DB Migrations? | Prisma](https://www.prisma.io/dataguide/types/relational/what-are-database-migrations)
- [Operation Reference — Alembic Documentation](https://alembic.sqlalchemy.org/en/latest/ops.html)
- [Auto Generating Migrations — Alembic Documentation](https://alembic.sqlalchemy.org/en/latest/autogenerate.html)
- [How to Handle Database Migration / Schema Change? | Bytebase](https://www.bytebase.com/blog/how-to-handle-database-schema-change/)

### Password Reset & Admin Security
- [Reset passwords - Microsoft 365 admin | Microsoft Learn](https://learn.microsoft.com/en-us/microsoft-365/admin/add-users/reset-passwords?view=o365-worldwide)
- [Reset a user's password | Google Workspace Help](https://knowledge.workspace.google.com/admin/users/reset-a-users-password)
- [3 Ways to Change a User Password in Google Workspace in 2026 | Torii](https://www.toriihq.com/articles/how-to-change-user-password-google-workspace)

### FastAPI Best Practices & Common Mistakes
- [Common Mistakes Developers Make While Building FastAPI Applications | Medium](https://medium.com/@rameshkannanyt0078/common-mistakes-developers-make-while-building-fastapi-applications-bec0a55fe48f)
- [FastAPI: 10 Common Mistakes to Avoid | Medium](https://medium.com/@kasperjuunge/fastapi-10-ways-not-to-use-it-de35875c9bc2)
- [How to Use Dependency Injection in FastAPI](https://oneuptime.com/blog/post/2026-02-02-fastapi-dependency-injection/view)
- [Dependency Injection in FastAPI: 2026 Playbook for Modular, Testable APIs](https://thelinuxcode.com/dependency-injection-in-fastapi-2026-playbook-for-modular-testable-apis/)

### Role-Based Access Control
- [Role Based Access Control (RBAC): 2026 Guide | Concentric AI](https://concentric.ai/how-role-based-access-control-rbac-helps-data-security-governance/)
- [How to Build a Role-Based Access Control Layer](https://www.osohq.com/learn/rbac-role-based-access-control)
- [Role-Based Access Control - Auth0 Docs](https://auth0.com/docs/manage-users/access-control/rbac)

---

## Summary

When adding JWT authentication to an existing FastAPI + React (Tauri) app:

**Top 3 Critical Pitfalls:**
1. **Breaking all endpoints at once** - Use dual-auth pattern (JWT + existing X-API-Key) for gradual migration
2. **Token storage security in Tauri** - Use Tauri secure storage, never localStorage for sensitive tokens
3. **Race condition in React Router** - Wait for auth loading state before rendering protected routes

**Key Prevention Strategies:**
- Phase the migration (don't big-bang)
- Test both browser and Tauri from day 1
- Implement token refresh from the start
- Write reversible database migrations
- Use dependency composition for consistent role checks
- Configure CORS correctly for credentials
- Plan for token revocation mechanism

**Library Awareness:**
- FastAPI Users is in maintenance mode (stable but no new features)
- Successor library in development by same team
- Abstract auth layer for easier future migration

The research reveals that **retrofitting authentication is more about migration strategy than authentication implementation**. The actual JWT/FastAPI Users setup is well-documented and straightforward. The complexity lies in:
- Not breaking existing functionality
- Supporting multiple client types (browser + Tauri)
- Handling token lifecycle properly
- Migrating data and access patterns safely

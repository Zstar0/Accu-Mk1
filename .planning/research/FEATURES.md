# Feature Landscape: User Authentication

**Domain:** Lab application authentication (FastAPI + React SPA)
**Context:** Small team (5-10 users), dual deployment (web + Tauri desktop), no email infrastructure v1
**Researched:** 2026-02-09

## Table Stakes

Features users expect in any authenticated application. Missing these = product feels incomplete or insecure.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Email + password login** | Standard authentication method, no learning curve | Low | JWT-based with access/refresh tokens |
| **Password hashing** | Security baseline — storing plaintext is negligent | Low | Use Argon2 (2026 standard, GPU-resistant) not bcrypt |
| **Logout functionality** | Users expect to explicitly end session | Low | Invalidate refresh token, clear client storage |
| **Protected routes** | Unauthenticated users must not access app pages | Low | React Router guards, redirect to login |
| **Protected API endpoints** | Backend must validate JWT on protected routes | Medium | FastAPI dependency injection pattern |
| **Role-based access (RBAC)** | Admin vs standard user permissions | Medium | Two roles sufficient for lab context |
| **Password strength requirements** | Prevent weak passwords (123456, etc.) | Low | Min 8 chars, require mix of char types |
| **Session timeout (idle)** | Auto-logout after inactivity for security | Medium | 30 min idle for lab apps (NIST guideline) |
| **"Remember me" state** | Session persists across browser/app restarts | Low | Refresh token with longer expiration |
| **Login error feedback** | Clear messaging on auth failures | Low | Generic "invalid credentials" (not "user not found") |
| **User profile view** | Users see their own account info | Low | Email, role, account creation date |
| **Password change (authenticated)** | Logged-in users change their password | Low | Require current password for security |

## Differentiators

Features that add polish and align with 2026 enterprise expectations. Not expected by all users, but valued.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Admin user management page** | Admins create/disable accounts without console | Medium | CRUD for users, role assignment |
| **Audit trail for auth events** | Track logins, failed attempts, password changes | Medium | Log to SQLite with timestamps, IP addresses |
| **Session timeout warning** | 2-min warning before auto-logout with extend option | Medium | Prevents data loss during long tasks |
| **Absolute session timeout** | Force re-auth after 8-12 hours regardless of activity | Low | Hybrid timeout (idle OR absolute) |
| **Rate limiting on login** | Prevent brute-force attacks | Medium | Max 5 attempts per 15 min per IP/email |
| **Account lockout** | Disable account after N failed login attempts | Medium | Admin must unlock, prevents automation attacks |
| **Password reset (admin-assisted)** | Admin generates reset token, shares via secure channel | Low | Console/log output for v1 (no email) |
| **Last login timestamp** | Show user when they last logged in | Low | Security awareness, detect unauthorized access |
| **Active session indicator** | Show user they're logged in, where | Medium | Display session start time, device info |
| **Token refresh transparency** | Auto-refresh tokens without user interaction | Medium | Refresh before expiration, seamless UX |
| **Console password reset** | Generate reset link in server logs/console | Low | Temporary solution until email infra added |

## Anti-Features

Features to explicitly NOT build. Common mistakes or scope creep for this context.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| **Email-based password reset** | Requires email infra (SMTP, templates, deliverability) | Use admin-assisted reset via console/logs for v1 |
| **OAuth/social login** | Adds complexity, unnecessary for closed lab environment | Stick to email+password, sufficient for 5-10 users |
| **Multi-factor authentication (MFA)** | Overkill for v1, adds friction for small trusted team | Defer to post-v1 if compliance requires it |
| **Security questions** | Weak security, easily guessable, poor UX | Use admin-assisted password reset instead |
| **Username field** | Email serves as unique identifier, extra field = confusion | Use email as login identifier |
| **Public registration** | Lab app = closed system, not open to internet | Admin creates accounts, no self-service signup |
| **Passwordless auth (magic links)** | Requires email infrastructure | Wait for v2 after email is implemented |
| **Biometric authentication** | Desktop/web support inconsistent, complex for Tauri | Future enhancement if strong demand |
| **Single Sign-On (SSO)** | Enterprise feature, unnecessary for 5-10 user lab | Defer until larger deployment or customer request |
| **Password expiration** | [Modern guidance](https://auth0.com/blog/balance-user-experience-and-security-to-retain-customers/) discourages forced rotation | Only implement if compliance requires it |
| **CAPTCHA on login** | Unnecessary with rate limiting, degrades UX | Use rate limiting + account lockout instead |
| **"Forgot username" flow** | Email is username, users know their email | Not needed |

## Feature Dependencies

```
Core Authentication Flow:
├── Email + password login → JWT access token
├── Access token → Protected routes (frontend)
├── Access token → Protected API endpoints (backend)
└── Refresh token → Seamless token renewal

Password Management:
├── Password hashing (Argon2) → Secure storage
├── Password strength validation → User registration/change
└── Console password reset → Admin-assisted recovery

Authorization:
├── Role assignment (admin/standard) → User creation
├── RBAC middleware → Protected endpoints
└── Admin user management page → Role changes

Session Management:
├── Idle timeout (30 min) → Auto-logout
├── Absolute timeout (8-12 hours) → Force re-auth
└── Session warning (2 min before timeout) → UX polish

Security:
├── Rate limiting → Brute-force prevention
├── Account lockout → Attack mitigation
└── Audit trail → Security monitoring
```

## MVP Recommendation

For v0.6.0 authentication milestone, prioritize:

### Must-Have (Table Stakes)
1. **Email + password login** with JWT (access + refresh tokens)
2. **Password hashing** with Argon2
3. **Logout** functionality
4. **Protected routes** (React) and **protected endpoints** (FastAPI)
5. **Two roles** (admin, standard) with RBAC
6. **Password strength** validation
7. **Session timeout** (30 min idle)
8. **Login error feedback**
9. **User profile view**
10. **Password change** (authenticated users)

### Nice-to-Have (Differentiators for v0.6.0)
1. **Admin user management page** (create/disable users, assign roles)
2. **Console password reset** (log-based token generation for admins)
3. **Audit trail** for auth events (login, logout, password change)
4. **Session timeout warning** (2 min before auto-logout)
5. **Rate limiting** on login endpoint (5 attempts per 15 min)

### Defer to Post-MVP
- **Absolute session timeout** (implement if 30-min idle insufficient)
- **Account lockout** (wait to see if rate limiting sufficient)
- **Last login timestamp** (polish feature)
- **Active session indicator** (polish feature)
- **Email-based password reset** (requires email infrastructure)
- **MFA** (implement only if compliance requires)
- **SSO** (enterprise feature for future)

## Integration with Existing Features

| Existing Feature | Auth Integration Required | Notes |
|------------------|---------------------------|-------|
| **HPLC file import** | Protected route, standard user can access | File operations allowed for all authenticated users |
| **Purity calculations** | Protected endpoint, standard user can access | Core workflow, all users need access |
| **Batch review UI** | Protected route, standard user can access | Operators perform reviews |
| **SENAITE integration** | Protected endpoint, consider admin-only | Push to LIMS may be admin privilege |
| **Settings management** | Protected route, likely admin-only | Configuration changes = admin permission |
| **Order Explorer** | Protected route, replace API key auth with JWT | Currently uses X-API-Key, migrate to JWT |
| **SQLite database** | Add users, roles, auth_events tables | Extend schema for auth data |
| **File cache** | User-scoped or shared? | Decide: shared cache or per-user isolation |

## Domain-Specific Considerations

### Lab Environment Security Balance
- **Low threat model**: Small trusted team (5-10 users), not internet-facing
- **Compliance aware**: Audit trail important for FDA/GMP validation later
- **Usability critical**: Operators use app daily, friction = non-adoption
- **Recommendation**: Strong baseline security (Argon2, JWT, RBAC) but avoid over-engineering (no MFA v1, no forced password rotation)

### Dual Deployment (Web + Tauri)
- **Token storage**: localStorage acceptable for Tauri desktop, consider httpOnly cookies for web
- **Session persistence**: Both modes should "remember me" across restarts
- **Security consideration**: Tauri apps can use localStorage safely (no XSS risk from external scripts)
- **Recommendation**: Use localStorage for simplicity, works consistently across both modes

### No Email Infrastructure (v1)
- **Password reset**: Admin-assisted via console-generated reset tokens
- **New user onboarding**: Admin creates account, shares temporary password securely
- **Account notifications**: None for v1, add after email implemented
- **Recommendation**: Document admin workflow clearly, plan email integration for v2

### Small Team Operations
- **User provisioning**: Admin creates accounts manually, acceptable for 5-10 users
- **Role changes**: Rare event, admin can update via management page
- **Password resets**: Infrequent, console-based acceptable
- **Recommendation**: Optimize for simplicity over self-service automation

## Complexity Assessment

| Complexity Tier | Features | Implementation Effort |
|-----------------|----------|----------------------|
| **Low** | Login, logout, password hashing, protected routes, password strength | 1-2 days |
| **Medium** | RBAC, protected endpoints, JWT refresh, admin user management, audit trail | 3-5 days |
| **High** | Rate limiting, account lockout, session timeout with warning, token refresh transparency | 2-3 days |

**Total MVP estimate**: 6-10 days for core auth system (table stakes + key differentiators)

## Sources

### FastAPI + JWT Authentication
- [OAuth2 with Password (and hashing), Bearer with JWT tokens - FastAPI](https://fastapi.tiangolo.com/tutorial/security/oauth2-jwt/)
- [Securing FastAPI with JWT Token-based Authentication | TestDriven.io](https://testdriven.io/blog/fastapi-jwt-auth/)
- [FastAPI Best Practices for Production: Complete 2026 Guide](https://fastlaunchapi.dev/blog/fastapi-best-practices-production-2026)
- [Authentication and Authorization with FastAPI: A Complete Guide](https://betterstack.com/community/guides/scaling-python/authentication-fastapi/)

### React SPA Authentication Patterns
- [How To Add Login Authentication to React Applications | DigitalOcean](https://www.digitalocean.com/community/tutorials/how-to-add-login-authentication-to-react-applications)
- [The Complete Guide to React User Authentication | Auth0](https://auth0.com/blog/complete-guide-to-react-user-authentication/)
- [Authentication in SPA (ReactJS and VueJS) the right way | Medium](https://medium.com/@jcbaey/authentication-in-spa-reactjs-and-vuejs-the-right-way-e4a9ac5cd9a3)

### Lab/Enterprise Authentication Requirements
- [LIMS Requirements | User, System & Functional Requirements Checklist](https://www.thelabhq.com/resource-centre/requirements)
- [Meet Your Lab's Regulatory Compliance Requirements with Lockbox LIMS](https://thirdwaveanalytics.com/blog/regulatory-compliance-with-lims/)
- [Role-Based Access Control: A Comprehensive Guide |2026 | Zluri](https://www.zluri.com/blog/role-based-access-control)

### Session Management Best Practices
- [Session Timeout Best Practices | Descope](https://www.descope.com/learn/post/session-timeout-best-practices)
- [Balance User Experience and Security to Retain Customers | Auth0](https://auth0.com/blog/balance-user-experience-and-security-to-retain-customers/)
- [Session Management | NIST](https://pages.nist.gov/800-63-3-Implementation-Resources/63B/Session/)

### Security and Anti-Patterns
- [sec-context/ANTI_PATTERNS_DEPTH.md | Arcanum-Sec](https://github.com/Arcanum-Sec/sec-context/blob/main/ANTI_PATTERNS_DEPTH.md)
- [Design Best Practices for an Authentication System | IEEE Cybersecurity](https://cybersecurity.ieee.org/blog/2016/06/02/design-best-practices-for-an-authentication-system/)
- [Forgot Password - OWASP Cheat Sheet Series](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)

### Tauri Desktop Authentication
- [Adding Auth0 to Your Tauri App: Secure Authentication | DEV Community](https://dev.to/yannamsellem/adding-auth0-to-your-tauri-app-secure-authentication-for-agx-on-web-and-desktop-1h4k)
- [Security | Tauri](https://v2.tauri.app/security/)
- [Tauri + oauth2 - DEV Community](https://dev.to/datner/tauri-oauth2-5f1h)

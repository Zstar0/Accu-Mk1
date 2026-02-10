# Requirements: Accu-Mk1 v0.6.0 — User Authentication

**Defined:** 2026-02-09
**Completed:** 2026-02-09
**Core Value:** Secure access control for production deployment

## v0.6.0 Requirements

### Authentication

- [x] **AUTH-01**: User can log in with email and password, receiving a JWT access token
- [x] **AUTH-02**: Passwords are hashed with bcrypt before storage (never stored plaintext)
- [x] **AUTH-03**: JWT access tokens expire after 1 hour, requiring re-authentication
- [x] **AUTH-04**: User sees generic "Invalid credentials" on login failure (no user enumeration)
- [x] **AUTH-05**: User can log out, clearing stored token from client

### User Management

- [x] **USER-01**: Admin can create new user accounts (email, password, role)
- [x] **USER-02**: Admin can view list of all users with email, role, active status
- [x] **USER-03**: Admin can deactivate/reactivate user accounts
- [x] **USER-04**: Admin can reset a user's password (generates temporary password shown in UI)
- [x] **USER-05**: User can change their own password (requires current password)

### Authorization

- [x] **AUTHZ-01**: Two roles exist: standard and admin
- [x] **AUTHZ-02**: All API endpoints require valid JWT (except /auth/login, /health)
- [x] **AUTHZ-03**: Admin-only endpoints reject standard users with 403
- [x] **AUTHZ-04**: Frontend hides admin-only UI elements from standard users
- [x] **AUTHZ-05**: Backend enforces authorization on all protected endpoints (not just frontend)

### Protected Routes

- [x] **ROUTE-01**: Unauthenticated users see login page instead of app
- [x] **ROUTE-02**: After login, user sees main application
- [x] **ROUTE-03**: Token stored in localStorage (works in both browser and Tauri)
- [x] **ROUTE-04**: Expired/invalid token redirects to login page
- [x] **ROUTE-05**: Auth state persists across page refresh / app restart

### Setup & Seed

- [x] **SEED-01**: First admin user created automatically on backend startup if no users exist
- [x] **SEED-02**: Default admin credentials logged to console on first run only
- [ ] **SEED-03**: Admin forced to change default password on first login (or at minimum, reminded)

## Future Requirements (Post v0.6.0)

- **EMAIL-01**: Password reset via email link
- **SESSION-01**: Session idle timeout (30 min auto-logout)
- **SESSION-02**: Session timeout warning (2 min before logout)
- **RATE-01**: Rate limiting on login endpoint (5 attempts per 15 min)
- **AUDIT-01**: Auth event audit trail (login, logout, password change)
- **MFA-01**: Multi-factor authentication (if compliance requires)

## Out of Scope

| Feature | Reason |
|---------|--------|
| OAuth/social login | Unnecessary for closed lab environment |
| Email-based password reset | No email infrastructure yet |
| Self-service registration | Admin creates accounts for closed lab team |
| Token refresh mechanism | 1-hour tokens sufficient for lab sessions, re-login acceptable |
| Tauri secure storage | localStorage sufficient for desktop app (no XSS risk) |
| Password expiration | Modern guidance discourages forced rotation |
| CAPTCHA | Unnecessary for internal lab app |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| AUTH-01 | Phase 5 | Done |
| AUTH-02 | Phase 5 | Done |
| AUTH-03 | Phase 5 | Done |
| AUTH-04 | Phase 5 | Done |
| AUTH-05 | Phase 5 | Done |
| USER-01 | Phase 7 | Done |
| USER-02 | Phase 7 | Done |
| USER-03 | Phase 7 | Done |
| USER-04 | Phase 7 | Done |
| USER-05 | Phase 7 | Done |
| AUTHZ-01 | Phase 5 | Done |
| AUTHZ-02 | Phase 6 | Done |
| AUTHZ-03 | Phase 6 | Done |
| AUTHZ-04 | Phase 6 | Done |
| AUTHZ-05 | Phase 6 | Done |
| ROUTE-01 | Phase 6 | Done |
| ROUTE-02 | Phase 6 | Done |
| ROUTE-03 | Phase 6 | Done |
| ROUTE-04 | Phase 6 | Done |
| ROUTE-05 | Phase 6 | Done |
| SEED-01 | Phase 5 | Done |
| SEED-02 | Phase 5 | Done |
| SEED-03 | Phase 6 | Deferred (reminder only, no forced change) |

**Coverage:**
- v0.6.0 requirements: 23 total
- Completed: 22
- Deferred: 1 (SEED-03 — forced password change on first login, will add post-v0.6.0)

---
*Requirements defined: 2026-02-09 | Completed: 2026-02-09*

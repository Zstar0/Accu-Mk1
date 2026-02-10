# Roadmap: Accu-Mk1 v0.6.0 — User Authentication

> **Status**: COMPLETE
> **Milestone**: v0.6.0 — User Authentication

## Overview

Added user authentication to protect the application for production deployment. Three phases: backend auth infrastructure, frontend auth integration with protected routes, and admin user management UI. Manual JWT implementation (no FastAPI Users) to avoid async SQLAlchemy migration.

## Phases

- [x] **Phase 5: Backend Auth Module** — User model, JWT utilities, auth endpoints, seed admin
- [x] **Phase 6: Frontend Auth & Protected Routes** — Login page, auth store, token management, route protection
- [x] **Phase 7: Admin User Management** — Admin UI for creating/managing users, password changes

## Phase Details

### Phase 5: Backend Auth Module
**Goal**: Backend can register users, authenticate with JWT, and protect endpoints
**Status**: COMPLETE
**Requirements**: AUTH-01, AUTH-02, AUTH-03, AUTH-04, AUTH-05, AUTHZ-01, SEED-01, SEED-02
**Success Criteria** (all met):
  1. User model exists in database with email, hashed_password, role, is_active fields
  2. POST /auth/login accepts email+password, returns JWT access token
  3. GET /auth/me returns current user info when valid JWT provided
  4. POST /auth/login returns 401 with generic message for invalid credentials
  5. Passwords are hashed with bcrypt (never stored plaintext)
  6. JWT tokens expire after 1 hour
  7. First admin user auto-created on startup if no users exist
  8. Default admin credentials logged to console on first run

### Phase 6: Frontend Auth & Protected Routes
**Goal**: Users must log in to access the app, token management works in browser and Tauri
**Status**: COMPLETE
**Requirements**: AUTHZ-02, AUTHZ-03, AUTHZ-04, AUTHZ-05, ROUTE-01, ROUTE-02, ROUTE-03, ROUTE-04, ROUTE-05, SEED-03
**Success Criteria** (all met):
  1. Unauthenticated users see login page
  2. After successful login, user sees main application
  3. JWT token stored in localStorage, persists across refresh
  4. All API calls include Bearer token in Authorization header
  5. Expired token redirects to login page
  6. Existing API key auth replaced with JWT auth on all endpoints
  7. Admin-only UI elements hidden from standard users
  8. Backend enforces auth on all endpoints (except /auth/login, /health)

### Phase 7: Admin User Management
**Goal**: Admins can create, manage, and reset passwords for users through the UI
**Status**: COMPLETE
**Requirements**: USER-01, USER-02, USER-03, USER-04, USER-05
**Success Criteria** (all met):
  1. Admin sees "User Management" section in navigation
  2. Admin can create new users with email, password, and role
  3. Admin can view list of all users
  4. Admin can deactivate/reactivate users
  5. Admin can reset a user's password (temporary password shown once)
  6. Standard users cannot access user management
  7. Users can change their own password

## Progress

| Phase | Status | Completed |
|-------|--------|-----------|
| 5. Backend Auth | COMPLETE | 2026-02-09 |
| 6. Frontend Auth | COMPLETE | 2026-02-09 |
| 7. Admin Management | COMPLETE | 2026-02-09 |

## Stack Additions

| Package | Purpose |
|---------|---------|
| bcrypt>=4.0.0 | Password hashing (replaced passlib due to incompatibility) |
| python-jose[cryptography] | JWT token creation/validation |
| python-multipart | Form data parsing for login endpoint |

## Key Architecture Decisions

- **Manual JWT** (not FastAPI Users) — avoids async SQLAlchemy migration
- **Direct bcrypt** (not passlib) — passlib incompatible with bcrypt>=4.1
- **localStorage for tokens** — works consistently in browser + Tauri, no XSS risk in desktop
- **Zustand auth store** — consistent with existing state management pattern
- **No react-router** — app uses Zustand section-based routing, auth gate at App.tsx level
- **JWT sub as string** — python-jose validates per JWT spec, must use str(user.id)

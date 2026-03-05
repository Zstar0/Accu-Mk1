# Deployment Guide

Complete deployment process for Accu-Mk1 covering the web application (DigitalOcean droplet) and the desktop application (GitHub Releases with auto-update).

## Architecture Overview

```
Internet
  │
  ├─ Desktop App (Tauri) ──→ https://accumk1.valenceanalytical.com/api
  │   └─ Auto-updates from GitHub Releases (latest.json)
  │
  └─ Web App ──→ https://accumk1.valenceanalytical.com
        │
  DigitalOcean Droplet (165.227.241.81)
        │
        ├─ Nginx (host) ──→ SSL termination, reverse proxy
        │
        └─ Docker Compose (docker-compose.prod.yml)
            ├─ frontend (port 3100) ─ Nginx serving Vite static files
            │     ├─ Image: ghcr.io/zstar0/accu-mk1-frontend:VERSION
            │     └─ /api/* proxied to backend
            └─ backend (port 8012) ─ FastAPI/Uvicorn
                  ├─ Image: ghcr.io/zstar0/accu-mk1-backend:VERSION
                  ├─ PostgreSQL accumark_mk1 (DigitalOcean Managed DB)
                  ├─ PostgreSQL accumark_integration (DigitalOcean Managed DB)
                  ├─ Integration Service (senaite_default network)
                  └─ SENAITE LIMS (Docker network)
```

### Deploy Flow

```
Local machine                              Production server
─────────────                              ─────────────────
1. docker build --platform linux/amd64
2. docker push → GHCR ──────────────→  3. docker pull from GHCR
                                        4. docker compose up -d
                                        5. Health check (10 retries)
                                           ├─ Pass → update version tracking
                                           └─ Fail → auto-rollback to previous
6. Git tag + GitHub release (optional)
7. New Relic deployment marker (optional)
```

---

## Part 1: Web Application (DigitalOcean Droplet)

### What Lives on the Server

| Path                                          | Purpose                                          | Managed By                               |
| --------------------------------------------- | ------------------------------------------------ | ---------------------------------------- |
| `/root/accu-mk1/docker-compose.prod.yml`      | Container orchestration (pulls from GHCR)        | `deploy.sh` (scp)                        |
| `/root/accu-mk1/backend/.env`                 | Backend secrets (DB creds, JWT, API keys)        | Manual — **never overwritten by deploy** |
| `/root/accu-mk1/.deploy/`                     | Version tracking (current, previous, deploy log) | `deploy.sh`                              |
| `/etc/nginx/sites-enabled/accumk1-nginx.conf` | Host Nginx reverse proxy + SSL                   | Manual — lives outside repo              |
| `/etc/letsencrypt/`                           | SSL certificates (Let's Encrypt)                 | Certbot auto-renewal                     |

> **Note**: Source code is **not** stored on the server. The server only runs pre-built Docker images pulled from GHCR.

### Image Registry

All images are stored in GitHub Container Registry (GHCR):

| Image    | Registry URL                       |
| -------- | ---------------------------------- |
| Frontend | `ghcr.io/zstar0/accu-mk1-frontend` |
| Backend  | `ghcr.io/zstar0/accu-mk1-backend`  |

Each image is tagged three ways: `VERSION` (e.g. `0.16.1`), `sha-ABCDEF` (git SHA), and `latest`.

### Environment Files — Two Files, Two Purposes

| File              | Purpose                      | Contains                                                 | Overwritten by deploy?                      |
| ----------------- | ---------------------------- | -------------------------------------------------------- | ------------------------------------------- |
| `.env.production` | **Frontend** Vite build vars | `VITE_API_URL`, `VITE_WORDPRESS_URL`, `VITE_SENAITE_URL` | Baked into Docker image at build time       |
| `backend/.env`    | **Backend** secrets          | DB credentials, JWT secret, API keys, SENAITE creds      | **Never** — must be edited manually via SSH |

### Critical Files That Must Not Be Overwritten

1. **`backend/.env`** — Production database credentials, JWT secret, API keys, SENAITE credentials
   - Lives only on the server, excluded from Git
   - If lost: backend cannot connect to anything — restore from team password manager

2. **PostgreSQL `accumark_mk1` database** (DigitalOcean Managed DB) — users, audit logs, peptides, calibration curves, wizard sessions
   - Managed by DigitalOcean with automatic backups
   - Connection configured via `MK1_DB_*` env vars in `backend/.env`

3. **Host Nginx config** (`/etc/nginx/sites-enabled/accumk1-nginx.conf`)
   - Reference copy in repo: `scripts/accumk1-nginx.conf` (NOT auto-deployed)

4. **SSL certificates** (`/etc/letsencrypt/`) — Managed by Certbot with auto-renewal

### Prerequisites

Before your first deploy, ensure:

- [ ] Docker Desktop running locally
- [ ] Logged into GHCR: `docker login ghcr.io -u YOUR_GITHUB_USERNAME` (use a PAT with `write:packages` scope)
- [ ] SSH key set up: `ssh-copy-id root@165.227.241.81` (or provide password when prompted)
- [ ] Production server logged into GHCR: `docker login ghcr.io` on the server (PAT with `read:packages` scope)
- [ ] `backend/.env` exists on server with all production values
- [ ] `gh` CLI installed for GitHub releases (optional): https://cli.github.com

### Pre-Deployment Checklist

- [ ] Code compiles: `npx tsc --noEmit`
- [ ] Version bumped in `package.json` and `src-tauri/tauri.conf.json`
- [ ] `CHANGELOG.md` updated
- [ ] Changes committed and pushed to `origin/master`
- [ ] No `.env` files or credentials in the commit
- [ ] If backend `.env` variables changed: SSH in and update `backend/.env` manually first

### Deploy Process

#### Quick Deploy (Most Common)

```bash
# Full deploy — build, push, pull, restart
bash scripts/deploy.sh

# Backend only (faster)
bash scripts/deploy.sh --backend

# Frontend only
bash scripts/deploy.sh --frontend

# Preview what would happen without making changes
bash scripts/deploy.sh --dry-run

# Pull existing images on prod without rebuilding locally
bash scripts/deploy.sh --skip-build

# Skip git tag and GitHub release creation
bash scripts/deploy.sh --skip-release
```

#### What the Script Does

1. **Pre-flight checks**:
   - Docker running locally
   - GHCR credentials configured (`~/.docker/config.json`)
   - SSH connectivity (key-based auth preferred, sshpass fallback)
   - Disk space on prod (≥2GB required)
   - `backend/.env` exists on server
   - Required env keys present (`MK1_DB_HOST`, `JWT_SECRET`)
   - Shows current container state on prod

2. **Build & push** (local machine):
   - `docker build --platform linux/amd64` for each service
   - Tags: `VERSION`, `sha-GITSHA`, `latest`
   - Pushes all tags to GHCR

3. **Deploy** (production server):
   - Saves current version to `.deploy/previous_version` (for rollback)
   - Uploads `docker-compose.prod.yml` via scp
   - Verifies GHCR auth on server
   - `docker compose -f docker-compose.prod.yml pull`
   - `docker compose -f docker-compose.prod.yml up -d --remove-orphans`

4. **Health check** (10 retries, 3s interval):
   - Checks `http://localhost:3100/api/health` on the server
   - On success: updates `.deploy/current_version` and appends to `.deploy/deploy.log`
   - On failure: **automatic rollback** to previous version

5. **Post-deploy** (optional):
   - Creates git tag `v$VERSION` and pushes to origin
   - Creates GitHub release via `gh` CLI (uses `CHANGELOG.md` as release notes)
   - Records New Relic deployment marker (if `NEW_RELIC_API_KEY` and `NEW_RELIC_ENTITY_GUID` are set)

6. **Cleanup**: Prunes dangling Docker images on prod

### Version Tracking

The deploy script maintains a `.deploy/` directory on the server:

```
/root/accu-mk1/.deploy/
├── current_version    # e.g. "0.16.1"
├── previous_version   # e.g. "0.16.0" (for rollback)
└── deploy.log         # Append-only history: "2026-03-02T18:30:00Z v0.16.1 sha:16ed299"
```

### Rollback

#### Automatic (deploy script)

If health checks fail after deploy, the script automatically:

1. Reads `.deploy/previous_version`
2. Pulls the previous version's images from GHCR
3. Restarts containers with the previous version
4. Checks health again

#### Manual Rollback

```bash
# Option 1: Redeploy previous version locally
bash scripts/deploy.sh --skip-build
# (after setting the desired version in package.json or .deploy/current_version)

# Option 2: SSH in and roll back directly
ssh root@165.227.241.81
cd /root/accu-mk1
PREV=$(cat .deploy/previous_version)
VERSION=$PREV docker compose -f docker-compose.prod.yml pull
VERSION=$PREV docker compose -f docker-compose.prod.yml up -d --remove-orphans
echo "$PREV" > .deploy/current_version
```

### New Relic Integration

To enable New Relic deployment markers:

```bash
# Set these env vars before deploying
export NEW_RELIC_API_KEY="NRAK-..."
export NEW_RELIC_ENTITY_GUID="..."

bash scripts/deploy.sh
```

Find your entity GUID: **New Relic → APM → your app → metadata → entityGuid**

### Manual Server Operations

#### SSH into the Server

```bash
ssh root@165.227.241.81
cd /root/accu-mk1
```

#### View Logs

```bash
# All containers, follow mode
VERSION=$(cat .deploy/current_version) docker compose -f docker-compose.prod.yml logs -f

# Backend only, last 100 lines
VERSION=$(cat .deploy/current_version) docker compose -f docker-compose.prod.yml logs --tail 100 backend
```

#### Restart Containers

```bash
cd /root/accu-mk1
VERSION=$(cat .deploy/current_version) docker compose -f docker-compose.prod.yml restart

# Restart one service
VERSION=$(cat .deploy/current_version) docker compose -f docker-compose.prod.yml restart backend
```

#### Update Backend Environment Variables

> **ALWAYS CHECK THE PRODUCTION ENV FILES FIRST TO SEE IF WE NEED TO UPDATE IT. WE SHOULD NOT CHANGE THE PRODUCTION ENV FILES UNLESS WE ABSOLUTELY MUST.**

```bash
ssh root@165.227.241.81
nano /root/accu-mk1/backend/.env
# Edit variables, save, then:
cd /root/accu-mk1
VERSION=$(cat .deploy/current_version) docker compose -f docker-compose.prod.yml restart backend
```

#### Check Container Health

```bash
VERSION=$(cat .deploy/current_version) docker compose -f docker-compose.prod.yml ps
curl -s http://localhost:3100/api/health | python3 -m json.tool
```

#### Database Backup

The `accumark_mk1` database is on DigitalOcean Managed PostgreSQL with automatic daily backups. For manual backups:

```bash
# Dump from the managed database (run from the server or locally with psql access)
ssh root@165.227.241.81
docker exec accu-mk1-backend python -c "
import subprocess, os
subprocess.run([
    'pg_dump', '-h', os.environ['MK1_DB_HOST'],
    '-p', os.environ['MK1_DB_PORT'],
    '-U', os.environ['MK1_DB_USER'],
    '-d', os.environ['MK1_DB_NAME'],
    '-f', '/app/data/backup-accumark_mk1.sql'
], env={**os.environ, 'PGPASSWORD': os.environ['MK1_DB_PASSWORD']})
"

# Copy to local machine
scp root@165.227.241.81:/root/accu-mk1/data/backup-accumark_mk1.sql ./
```

### Updating the Host Nginx Config

The host Nginx config (`/etc/nginx/sites-enabled/accumk1-nginx.conf`) is separate from Docker. To update:

```bash
ssh root@165.227.241.81
nano /etc/nginx/sites-enabled/accumk1-nginx.conf
nginx -t          # Test before reloading
systemctl reload nginx
```

A reference copy lives at `scripts/accumk1-nginx.conf` in the repo. deploy.sh does NOT push this file.

### Updating SSL Certificates

```bash
ssh root@165.227.241.81
certbot renew
systemctl reload nginx
```

---

## Part 2: Desktop Application (GitHub Releases)

The desktop app is built by GitHub Actions and distributed via GitHub Releases. Users receive automatic updates through the Tauri updater plugin.

### How Auto-Updates Work

```
App launches → (5s delay) → GET latest.json from GitHub Releases
  → Compare versions → Download signed installer → Install → Relaunch
```

The updater checks: `https://github.com/Zstar0/Accu-Mk1/releases/latest/download/latest.json`

Updates are cryptographically signed — the app verifies the signature before installing.

### Release Process

#### Step 1: Version Bump (Already Done If Following This Guide)

Ensure these files have the new version:

- `package.json` → `"version": "0.16.1"`
- `src-tauri/tauri.conf.json` → `"version": "0.16.1"`

#### Step 2: Commit and Push

```bash
git add -A
git commit -m "chore: release v0.16.1"
git push origin master
```

#### Step 3: Create and Push a Git Tag

This triggers the GitHub Actions release workflow:

```bash
git tag v0.16.1
git push origin v0.16.1
```

> **Note**: If you used `deploy.sh` without `--skip-release`, the git tag was already created automatically.

#### Step 4: Monitor the Build

1. Go to **GitHub → Actions** tab
2. Watch the "Release Tauri Template App" workflow
3. Three jobs run in parallel: macOS, Windows, Linux
4. Build takes ~10-15 minutes per platform

#### Step 5: Publish the Release

The workflow creates a **draft release**. You must manually publish it:

1. Go to **GitHub → Releases**
2. Find the draft release
3. Review the attached artifacts (`.exe`, `.dmg`, `.AppImage` + signatures + `latest.json`)
4. Edit the release notes if desired
5. Click **Publish release**

Once published, all existing desktop app users will receive the update automatically on their next launch.

#### Alternative: Manual Workflow Trigger

1. Go to **GitHub → Actions → "Release Tauri Template App"**
2. Click **Run workflow**
3. Enter the version (e.g., `v0.16.1`)
4. Click **Run workflow**

### Required GitHub Secrets

| Secret                               | Purpose                                |
| ------------------------------------ | -------------------------------------- |
| `TAURI_PRIVATE_KEY`                  | Signing key for update verification    |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the signing key           |
| `GITHUB_TOKEN`                       | Automatic — provided by GitHub Actions |

If the signing key is lost, generate a new one (`tauri signer generate -w ~/.tauri/myapp.key`), update the `pubkey` in `src-tauri/tauri.conf.json`, and update the GitHub secret. Users on old versions will need to manually download the new installer.

---

## Part 3: Full Release Workflow (Both Web + Desktop)

```
1. Finish development work
2. npx tsc --noEmit                       # Typecheck
3. Bump version in package.json + tauri.conf.json
4. Update CHANGELOG.md
5. git add ... && git commit -m "chore: release v0.16.1"
6. git push origin master

── Web Deploy ──
7. bash scripts/deploy.sh                 # Build → push → pull → health check
   (auto-creates git tag + GitHub release unless --skip-release)
8. Verify: https://accumk1.valenceanalytical.com/api/health

── Desktop Release ──
9. git tag v0.16.1 (if not already created by deploy.sh)
10. git push origin v0.16.1               # Triggers GitHub Actions build
11. Wait for builds to complete (~15 min)
12. Go to GitHub Releases → publish the draft
13. Verify: existing desktop apps auto-update on next launch
```

### Order Matters

- Deploy **web first** (step 7) before releasing desktop (step 9)
- The desktop app connects to the production API — if the backend has breaking API changes, deploy the backend before users get the new desktop version
- The git tag push (step 10) is what triggers the desktop build — only push the tag when you're ready

---

## Troubleshooting

### Deploy Script Pre-flight Failures

| Error                      | Cause                                          | Fix                                                     |
| -------------------------- | ---------------------------------------------- | ------------------------------------------------------- |
| "Docker is not running"    | Docker Desktop not started                     | Start Docker Desktop                                    |
| "Not logged into GHCR"     | No GHCR credentials in `~/.docker/config.json` | `docker login ghcr.io -u USERNAME` with PAT             |
| "Cannot connect to server" | SSH key not configured or server down          | `ssh-copy-id root@165.227.241.81` or check DigitalOcean |
| "Low disk space on prod"   | Less than 2GB free                             | SSH in and `docker system prune -a`                     |
| "backend/.env missing"     | First deploy or file was deleted               | SSH in and create from `.env.example`                   |
| "Missing env keys"         | Required vars not in `backend/.env`            | SSH in and add missing keys                             |

### Health Check Fails After Deploy

The script auto-rolls back, but to investigate:

```bash
ssh root@165.227.241.81
cd /root/accu-mk1
VERSION=$(cat .deploy/current_version) docker compose -f docker-compose.prod.yml logs --tail 50 backend
VERSION=$(cat .deploy/current_version) docker compose -f docker-compose.prod.yml ps
```

Common causes:

- `backend/.env` is missing or has wrong values
- Database migration issue
- Port conflict (another service on 8012 or 3100)

### Desktop Build Fails in GitHub Actions

- Check the Actions tab for error logs
- **Rust errors**: Run `cargo check` locally in `src-tauri/`
- **Missing secrets**: Verify `TAURI_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- **Node errors**: Run `npm ci && npm run build` locally

### Auto-Update Not Working for Users

- Verify the release is **published** (not draft)
- Check that `latest.json` is in the release assets
- Verify the `pubkey` in `tauri.conf.json` matches the signing key used in CI

### Backend .env Was Accidentally Overwritten

```bash
ssh root@165.227.241.81
cd /root/accu-mk1/backend
cat .env | head -5  # Check if it has real production values
# If dev values, restore and fill in production values:
cp .env.example .env
nano .env
VERSION=$(cat ../.deploy/current_version) docker compose -f ../docker-compose.prod.yml restart backend
```

Production `backend/.env` values are **not stored in the repo**. If lost, retrieve from:

- DigitalOcean Managed Database dashboard (DB credentials)
- Team password manager (JWT_SECRET, API keys)
- SENAITE admin panel (SENAITE credentials)

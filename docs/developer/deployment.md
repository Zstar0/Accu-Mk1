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
        └─ Docker Compose
            ├─ frontend (port 3100) ─ Nginx serving Vite static files
            │     └─ /api/* proxied to backend
            └─ backend (port 8012) ─ FastAPI/Uvicorn
                  ├─ SQLite (volume: accu-mk1-data)
                  ├─ Integration Service (senaite_default network)
                  ├─ PostgreSQL (DigitalOcean Managed DB)
                  └─ SENAITE LIMS (Docker network)
```

---

## Part 1: Web Application (DigitalOcean Droplet)

### What Lives on the Server

| Path | Purpose | Managed By |
|------|---------|------------|
| `/root/accu-mk1/` | Application source code | `deploy.sh` (rsync) |
| `/root/accu-mk1/backend/.env` | Backend secrets (DB creds, JWT, API keys) | Manual — **never overwritten by deploy** |
| `/root/accu-mk1/docker-compose.yml` | Container orchestration | `deploy.sh` (rsync) |
| `/root/accu-mk1/.env.docker` | Frontend env (VITE_API_URL) | `deploy.sh` (copies `.env.docker.prod`) |
| `/etc/nginx/sites-enabled/accumk1-nginx.conf` | Host Nginx reverse proxy + SSL | Manual — lives outside repo |
| `/etc/letsencrypt/` | SSL certificates (Let's Encrypt) | Certbot auto-renewal |
| Docker volume `accu-mk1-data` | SQLite database | Persistent across deploys |

### Environment Files — Two Files, Two Purposes

There are **two separate env files** on the server. They serve completely different purposes:

| File | Purpose | Contains | Overwritten by deploy? |
|------|---------|----------|----------------------|
| `.env.docker` | **Frontend** Vite build vars | `VITE_API_URL`, `VITE_WORDPRESS_URL`, `VITE_SENAITE_URL` | **Yes** — deploy.sh copies `.env.docker.prod` → `.env.docker` every deploy |
| `backend/.env` | **Backend** secrets | DB credentials, JWT secret, API keys, SENAITE creds | **Never** — excluded from rsync, must be edited manually via SSH |

**`.env.docker`** (safe to overwrite):
- Baked into the frontend JS bundle at Docker build time (`COPY .env.docker .env.production` in Dockerfile)
- Source of truth is `.env.docker.prod` in the repo (committed, no secrets)
- If wrong: frontend points to wrong API/SENAITE URLs — fix by redeploying or manually copying `.env.docker.prod`

**`backend/.env`** (never overwrite):
- Read at runtime by the FastAPI backend container
- Contains production database credentials, JWT secret, API keys, SENAITE credentials
- If lost: backend cannot connect to anything — restore from team password manager

### Critical Files That Must Not Be Overwritten

These files exist only on the production server and contain environment-specific secrets. The deploy script is configured to **never sync them**, but you must be aware:

1. **`backend/.env`** — Production database credentials, JWT secret, API keys, SENAITE credentials
   - Excluded in `deploy.sh` rsync (`--exclude='backend/.env'`)
   - Excluded in `.gitignore`
   - If lost: backend cannot connect to Integration Service DB, SENAITE, or authenticate users

2. **Docker volume `accu-mk1-data`** — SQLite database with users, audit logs, wizard sessions
   - Lives in Docker-managed volume, not in the repo directory
   - Survives container rebuilds and code deploys
   - If lost: all local app data is gone (users, settings, audit trail)

3. **Host Nginx config** (`/etc/nginx/sites-enabled/accumk1-nginx.conf`)
   - Controls SSL, domain routing, proxy settings
   - Lives outside the repo on the host filesystem
   - The copy in `scripts/accumk1-nginx.conf` is a reference — it is NOT auto-deployed

4. **SSL certificates** (`/etc/letsencrypt/`)
   - Managed by Certbot with auto-renewal
   - Do not touch unless renewing or changing domains

### Pre-Deployment Checklist

Before deploying to production:

- [ ] Code compiles: `npx tsc --noEmit`
- [ ] Version bumped in `package.json` and `src-tauri/tauri.conf.json`
- [ ] `CHANGELOG.md` updated
- [ ] Changes committed and pushed to `origin/master`
- [ ] No `.env` files or credentials in the commit (`git diff --cached --name-only`)
- [ ] If backend `.env` variables changed: SSH in and update `backend/.env` manually first

### Deploy Process

#### Quick Deploy (Most Common)

```bash
# Full deploy — frontend + backend
bash scripts/deploy.sh

# Backend only (faster — skips frontend rebuild)
bash scripts/deploy.sh --backend

# Frontend only
bash scripts/deploy.sh --frontend

# Preview what will change without deploying
bash scripts/deploy.sh --dry-run
```

The script will:
1. Prompt for SSH password
2. Verify SSH connectivity and Docker
3. Rsync source code (excluding secrets, node_modules, .git, src-tauri, etc.)
4. Copy `.env.docker.prod` → `.env.docker` on server (frontend env vars)
5. Run `docker compose up -d --build` on the server
6. Wait 3 seconds, then health-check `https://accumk1.valenceanalytical.com/api/health`
7. Prune dangling Docker images

#### If the Deploy Script Fails Mid-Way

The script uses multiple SSH connections (rsync, scp, ssh). If the connection is flaky, it may succeed at syncing code but fail on later steps. If this happens, SSH in manually and finish:

```bash
ssh root@165.227.241.81
cd /root/accu-mk1

# Check .env.docker has production values (VITE_API_URL=/api, not http://localhost)
cat .env.docker

# If it shows local/dev values, fix it:
# cat > .env.docker << 'EOF'
# # Production Docker build
# VITE_API_URL=/api
# VITE_WORDPRESS_URL=https://accumarklabs.com
# VITE_SENAITE_URL=https://senaite.valenceanalytical.com
# EOF

# Rebuild and verify
docker compose up -d --build
sleep 3
curl -s http://localhost:3100/api/health
```

#### What Gets Synced (and What Doesn't)

**Synced** (by rsync):
- All source code, Dockerfiles, docker-compose.yml, nginx.conf (internal)
- package.json, requirements.txt, config files

**Excluded** (never synced):
| Exclusion | Reason |
|-----------|--------|
| `.git/` | Git history not needed on server |
| `node_modules/` | Rebuilt inside Docker |
| `backend/.env` | **Production secrets** |
| `.env` | Root env (not used on server) |
| `src-tauri/` | Desktop app only |
| `data/`, `*.db`, `*.sqlite` | Local dev data |
| `dist/` | Build artifacts (rebuilt on server) |
| `docs/`, `.planning/`, `.claude/` | Dev-only |

### Manual Server Operations

#### SSH into the Server

```bash
ssh root@165.227.241.81
cd /root/accu-mk1
```

#### View Logs

```bash
# All containers, follow mode
docker compose logs -f

# Backend only, last 100 lines
docker compose logs --tail 100 backend

# Frontend (Nginx) only
docker compose logs --tail 100 frontend
```

#### Restart Containers

```bash
# Graceful restart (no rebuild)
docker compose restart

# Restart one service
docker compose restart backend

# Full rebuild (after manual code changes on server)
docker compose up -d --build
```

#### Update Backend Environment Variables

```bash
ssh root@165.227.241.81
nano /root/accu-mk1/backend/.env
# Edit variables, save, then:
cd /root/accu-mk1
docker compose restart backend
```

#### Check Container Health

```bash
docker compose ps
curl -s http://localhost:3100/api/health | python3 -m json.tool
```

#### Database Backup

```bash
# The SQLite database lives in a Docker volume
docker compose exec backend cp /app/data/accu_mk1.db /app/data/backup-$(date +%Y%m%d).db

# Copy to local machine
scp root@165.227.241.81:/root/accu-mk1/data/backup-*.db ./
```

### Updating the Host Nginx Config

The host Nginx config (`/etc/nginx/sites-enabled/accumk1-nginx.conf`) is separate from the Docker internal Nginx. To update it:

```bash
ssh root@165.227.241.81

# Edit the config
nano /etc/nginx/sites-enabled/accumk1-nginx.conf

# Test the config before reloading
nginx -t

# If test passes, reload
systemctl reload nginx
```

A reference copy lives at `scripts/accumk1-nginx.conf` in the repo. Keep this in sync when you make host Nginx changes, but remember: deploy.sh does NOT push this file to the server.

### Updating SSL Certificates

Certificates are managed by Certbot and auto-renew. To manually renew:

```bash
ssh root@165.227.241.81
certbot renew
systemctl reload nginx
```

### Rollback

If a deploy breaks production:

```bash
ssh root@165.227.241.81
cd /root/accu-mk1

# Check what changed
git log --oneline -5  # (if git is available on server)

# Option 1: Redeploy the previous version from local machine
git checkout <previous-commit>
bash scripts/deploy.sh

# Option 2: Restart with existing code on server
docker compose down
docker compose up -d --build
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
- `package.json` → `"version": "0.12.0"`
- `src-tauri/tauri.conf.json` → `"version": "0.12.0"`

#### Step 2: Commit and Push

```bash
git add -A
git commit -m "chore: release v0.12.0"
git push origin master
```

#### Step 3: Create and Push a Git Tag

This triggers the GitHub Actions release workflow:

```bash
git tag v0.12.0
git push origin v0.12.0
```

#### Step 4: Monitor the Build

1. Go to **GitHub → Actions** tab
2. Watch the "Release Tauri Template App" workflow
3. Three jobs run in parallel: macOS, Windows, Linux
4. Build takes ~10-15 minutes per platform

#### Step 5: Publish the Release

The workflow creates a **draft release**. You must manually publish it:

1. Go to **GitHub → Releases**
2. Find the draft release for `v0.12.0`
3. Review the attached artifacts:
   - `Accu-Mk1_0.12.0_x64-setup.exe` + `.exe.sig` (Windows NSIS)
   - `Accu-Mk1_0.12.0_x64.dmg` + `.app.tar.gz` + `.app.tar.gz.sig` (macOS)
   - `Accu-Mk1_0.12.0_amd64.AppImage` + `.AppImage.sig` (Linux)
   - `latest.json` (auto-updater manifest)
4. Edit the release notes if desired (update the changelog section)
5. Click **Publish release**

Once published, all existing desktop app users will receive the update automatically on their next launch.

#### Alternative: Manual Workflow Trigger

If you need to re-run the build without a new tag (e.g., a build failed due to CI flakiness):

1. Go to **GitHub → Actions → "Release Tauri Template App"**
2. Click **Run workflow**
3. Enter the version (e.g., `v0.12.0`)
4. Click **Run workflow**

### Required GitHub Secrets

These must be configured in **Settings → Secrets and variables → Actions**:

| Secret | Purpose |
|--------|---------|
| `TAURI_PRIVATE_KEY` | Signing key for update verification (content of `~/.tauri/myapp.key`) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the signing key |
| `GITHUB_TOKEN` | Automatic — provided by GitHub Actions |

If the signing key is lost, you must generate a new one (`tauri signer generate -w ~/.tauri/myapp.key`), update the `pubkey` in `src-tauri/tauri.conf.json`, and update the GitHub secret. Users on old versions will NOT be able to auto-update — they'll need to manually download the new installer.

---

## Part 3: Full Release Workflow (Both Web + Desktop)

Here's the complete sequence for a production release:

```
1. Finish development work
2. npm run check:all                    # Lint, typecheck, format
3. Bump version in package.json + tauri.conf.json
4. Update CHANGELOG.md
5. git add ... && git commit -m "chore: release v0.12.0"
6. git push origin master               # Push code

── Web Deploy ──
7. bash scripts/deploy.sh               # Deploy to DigitalOcean
8. Verify: https://accumk1.valenceanalytical.com/api/health

── Desktop Release ──
9. git tag v0.12.0                      # Create version tag
10. git push origin v0.12.0              # Triggers GitHub Actions build
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

### Deploy Script Fails to Connect

```
✖ Cannot connect to 165.227.241.81
```

- Verify the droplet is running in DigitalOcean console
- Check if the password is correct
- Try `ssh root@165.227.241.81` manually to see the actual error

### Health Check Fails After Deploy

```
✖ Health check failed: FAILED
```

```bash
# SSH in and check logs
ssh root@165.227.241.81
cd /root/accu-mk1
docker compose logs --tail 50 backend
docker compose ps
```

Common causes:
- `backend/.env` is missing or has wrong values
- Database migration needed (SQLAlchemy auto-creates tables, but schema changes may need manual intervention)
- Port conflict (another service on 8012 or 3100)

### Desktop Build Fails in GitHub Actions

- Check the Actions tab for error logs
- **Rust compilation errors**: Run `cargo check` locally in `src-tauri/`
- **Missing secrets**: Verify `TAURI_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` are set
- **Node errors**: Run `npm ci && npm run build` locally to reproduce

### Auto-Update Not Working for Users

- Verify the release is **published** (not draft)
- Check that `latest.json` is in the release assets
- Verify the `pubkey` in `tauri.conf.json` matches the signing key used in CI
- The endpoint URL must be: `https://github.com/Zstar0/Accu-Mk1/releases/latest/download/latest.json`

### Backend .env Was Accidentally Overwritten

If someone manually copies or rsyncs the wrong file:

```bash
ssh root@165.227.241.81
cd /root/accu-mk1/backend

# Check if .env has real production values
cat .env | head -5

# If it shows dev values, restore from .env.example and fill in production values
cp .env.example .env
nano .env
# Fill in production values, then restart
docker compose restart backend
```

The production `backend/.env` values are **not stored in the repo**. If they're lost, retrieve them from:
- DigitalOcean Managed Database dashboard (DB credentials)
- Team password manager (JWT_SECRET, API keys)
- SENAITE admin panel (SENAITE credentials)

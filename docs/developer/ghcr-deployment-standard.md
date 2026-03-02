# GHCR Deployment Standard — Migration Guide for All Services

> **Author**: Deployment modernization (Feb 28, 2026)
> **Status**: Accu-Mk1 ✅ Complete | Integration Service ⬜ Pending | COA Builder ⬜ Pending | SENAITE ⬜ Pending
> **Server**: `165.227.241.81` (DigitalOcean droplet)

---

## Executive Summary

We have migrated **Accu-Mk1** from "rsync source code to server and build there" to a **registry-based deployment** using GitHub Container Registry (GHCR). This document explains exactly what was set up and how to replicate the pattern for the remaining services on the same droplet.

### What Changed (Before → After)

```
BEFORE (all services):
  Developer machine ──rsync/scp source──→ Droplet ──docker build──→ Running container
  Problems: builds on prod, env drift, no rollback, 2GB image uploads for COA Builder

AFTER (Accu-Mk1, target for all):
  Developer machine ──docker build──→ GHCR ←──docker pull──→ Droplet → Running container
  Benefits: no building on prod, instant rollback via tags, auditable image history
```

### Current State of the Droplet (Feb 28, 2026)

| Container             | Image                                     | Deploy Method                     | Port |
| --------------------- | ----------------------------------------- | --------------------------------- | ---- |
| `accu-mk1-frontend`   | `ghcr.io/zstar0/accu-mk1-frontend:0.16.0` | ✅ **GHCR pull**                  | 3100 |
| `accu-mk1-backend`    | `ghcr.io/zstar0/accu-mk1-backend:0.16.0`  | ✅ **GHCR pull**                  | 8012 |
| `integration-service` | `integration-service:prod`                | ❌ Build on server                | 8000 |
| `coabuilder_service`  | `coabuilder_service:latest`               | ❌ Build on server                | 5000 |
| `senaite`             | `senaite:prod-update`                     | ❌ Build on server                | 8080 |
| `redis`               | `redis:7-alpine`                          | Official image (no change needed) | 6379 |

### Docker Networks (shared)

| Network                                | Services                                                           |
| -------------------------------------- | ------------------------------------------------------------------ |
| `accu-mk1`                             | accu-mk1-frontend, accu-mk1-backend                                |
| `senaite_default`                      | accu-mk1-backend, integration-service, coabuilder_service, senaite |
| `integration-service_accumark-network` | integration-service, redis                                         |

---

## Infrastructure Already Set Up (Do Not Repeat)

The following one-time setup has already been completed on the droplet and your development machine. **Agents do not need to repeat these steps.**

### 1. GHCR Authentication (Local Machine)

```bash
# Already done — logged into ghcr.io as Zstar0
docker login ghcr.io -u Zstar0
```

Credentials stored in `~/.docker/config.json`.

### 2. GHCR Authentication (Production Server)

```bash
# Already done — server can pull from ghcr.io
ssh root@165.227.241.81
# Docker credentials at /root/.docker/config.json
```

### 3. SSH Key Authentication

```bash
# Already done — key-based auth works, no password needed
ssh root@165.227.241.81 "echo ok"
```

---

## The Deployment Pattern (What to Implement for Each Service)

Every service migration follows the same 4-step pattern:

### Step 1: Create a `docker-compose.prod.yml`

This file uses **image references** instead of `build:` blocks. It lives in the service's project repo and is uploaded to the server.

**Template:**

```yaml
# docker-compose.prod.yml
services:
  my-service:
    container_name: my-service
    image: ghcr.io/zstar0/<service-name>:${VERSION:?VERSION is required}
    env_file:
      - ./<path-to>/.env
    ports:
      - '<host-port>:<container-port>'
    restart: unless-stopped
    networks:
      - senaite_default
      # Add other networks as needed

networks:
  senaite_default:
    external: true
```

**Key rules:**

- No `build:` sections — prod only pulls
- `${VERSION}` is required — enforced by `?` syntax
- `env_file:` points to the existing `.env` file already on the server
- Networks must match the current container's network connections
- Volumes for persistent data must be preserved

### Step 2: Create or Update `deploy.sh`

The deploy script must follow this flow:

```
Pre-flight checks → Build locally → Push to GHCR → Pull on prod → Health check → Rollback if failed
```

**Required features in the deploy script:**

| Feature                                           | Purpose                                                     |
| ------------------------------------------------- | ----------------------------------------------------------- |
| `--platform linux/amd64` on build                 | Droplet is x86_64, dev machines may differ                  |
| Triple tagging: `VERSION`, `sha-GITSHA`, `latest` | Enables rollback by version or SHA                          |
| SSH key auth (no sshpass)                         | Key already installed on server                             |
| Disk space preflight check                        | Prevent failed deploys due to full disk                     |
| Env schema validation                             | Verify required keys exist in prod `.env`                   |
| Health check with retry loop                      | Don't assume healthy after `sleep 3`                        |
| Auto-rollback on health failure                   | Pull previous version tag and restart                       |
| Version tracking files                            | `.deploy/current_version`, `previous_version`, `deploy.log` |
| Git tag + GitHub release                          | Via `gh` CLI after successful deploy                        |
| New Relic deployment marker                       | Via GraphQL API (if APM is configured for the service)      |
| `--skip-build` flag                               | For re-pulling existing images without rebuilding           |

**Reference implementation:** See `Accu-Mk1/scripts/deploy.sh` — this is the authoritative working example.

### Step 3: Build, Push, and Deploy

```bash
# Build for production platform
docker build --platform linux/amd64 -t ghcr.io/zstar0/<service>:<version> .

# Push to registry
docker push ghcr.io/zstar0/<service>:<version>

# On server: pull and start
ssh root@165.227.241.81 "cd /path/to/service && \
  VERSION=<version> docker compose -f docker-compose.prod.yml pull && \
  VERSION=<version> docker compose -f docker-compose.prod.yml up -d"
```

### Step 4: Version Tracking

Create `.deploy/` directory in the service's server directory:

```
/root/<service>/.deploy/
├── current_version      # e.g., "0.17.0"
├── previous_version     # shifted on each successful deploy
└── deploy.log           # append-only: "2026-02-28T23:30:00Z v0.17.0 sha:abc123"
```

---

## Service-Specific Migration Guides

### Integration Service

| Property                  | Value                                                          |
| ------------------------- | -------------------------------------------------------------- |
| **Container name**        | `integration-service`                                          |
| **Current image**         | `integration-service:prod` (built on server)                   |
| **Target image**          | `ghcr.io/zstar0/integration-service:${VERSION}`                |
| **Port**                  | `8000:8000`                                                    |
| **Networks**              | `senaite_default`, `integration-service_accumark-network`      |
| **Env file**              | `/root/integration-service.env.prod` (on server)               |
| **Health check**          | `curl http://localhost:8000/v1/healthz` → `{"status":"ok"}`    |
| **Server directory**      | `/root/integration-service/`                                   |
| **Current deploy method** | `deploy_rsync.py` → rsync source → `docker build` on server    |
| **Volumes**               | None (stateless — state is in managed Postgres)                |
| **Depends on**            | Redis (`redis:7-alpine`), managed PostgreSQL (`178.128.69.13`) |

**docker-compose.prod.yml for Integration Service:**

```yaml
services:
  integration-service:
    container_name: integration-service
    image: ghcr.io/zstar0/integration-service:${VERSION:?VERSION is required}
    env_file:
      - /root/integration-service.env.prod
    ports:
      - '8000:8000'
    dns:
      - 8.8.8.8
    restart: unless-stopped
    networks:
      - senaite_default
      - accumark-network

  redis:
    container_name: redis
    image: redis:7-alpine
    restart: unless-stopped
    networks:
      - accumark-network

networks:
  senaite_default:
    external: true
  accumark-network:
    name: integration-service_accumark-network
    driver: bridge
```

**Critical notes:**

- `--dns 8.8.8.8` is required — Docker bridge cannot resolve external FQDNs reliably
- `POSTGRES_HOST` must be set to `178.128.69.13` (IP, not FQDN) in the env file
- Redis is co-deployed in the same compose stack
- The env file is at `/root/integration-service.env.prod`, not in a subdirectory

**Migration steps:**

1. Create `docker-compose.prod.yml` in the Integration Service repo
2. Adapt `deploy.sh` from the Accu-Mk1 pattern (change image names, health endpoint, env file path)
3. Build: `docker build --platform linux/amd64 -t ghcr.io/zstar0/integration-service:0.17.0 .`
4. Push: `docker push ghcr.io/zstar0/integration-service:0.17.0`
5. On server: stop old container (`docker stop integration-service && docker rm integration-service`), then `VERSION=0.17.0 docker compose -f docker-compose.prod.yml up -d`
6. Verify: `curl http://165.227.241.81:8000/v1/healthz`

---

### COA Builder

| Property                  | Value                                                                     |
| ------------------------- | ------------------------------------------------------------------------- |
| **Container name**        | `coabuilder_service`                                                      |
| **Current image**         | `coabuilder_service:latest` (built on server via source-sync)             |
| **Target image**          | `ghcr.io/zstar0/coabuilder:${VERSION}`                                    |
| **Port**                  | `5000:5000`                                                               |
| **Networks**              | `senaite_default`                                                         |
| **Env vars**              | Injected via `-e` flags (not an env file)                                 |
| **Health check**          | `curl http://localhost:5000/version` → `{"version":"2.8.1"}`              |
| **Server directory**      | `/root/source_deploy/` (source sync target)                               |
| **Current deploy method** | `deploy_fast.py` → rsync source → `docker build` on server                |
| **Volumes**               | None                                                                      |
| **Image size**            | ~2.2GB (PDF rendering dependencies) — **biggest win from GHCR migration** |

**docker-compose.prod.yml for COA Builder:**

```yaml
services:
  coabuilder_service:
    container_name: coabuilder_service
    image: ghcr.io/zstar0/coabuilder:${VERSION:?VERSION is required}
    ports:
      - '5000:5000'
    environment:
      - SENAITE_BASE_URL=http://senaite:8080
      - SENAITE_USER=accumark_service
      - SENAITE_PASSWORD=${SENAITE_PASSWORD}
      - INTEGRATION_SERVICE_URL=http://integration-service:8000
      - JWT_SECRET=${JWT_SECRET}
      - JWT_ISSUER=accumark-wordpress
    restart: unless-stopped
    networks:
      - senaite_default

networks:
  senaite_default:
    external: true
```

**Critical notes:**

- This service currently uses inline `-e` flags for env vars instead of an env file. **You must create an env file** (e.g., `/root/coabuilder/.env`) to codify all the flags before migrating. See Section 12.3 of the Standard Deployment Framework for the "Configuration Parity" rule.
- The image is ~2.2GB — **this is why GHCR migration matters most here**. Currently, deploys either upload a 2GB tarball via SFTP or build from source on the server. With GHCR, the first push uploads all layers, and subsequent pushes only upload changed layers (~10MB for code changes).
- Ensure `--platform linux/amd64` is used during build — the service uses Matplotlib, ReportLab, and other native dependencies that are platform-specific.

**Migration steps:**

1. **First**: Codify all `-e` flags into an env file on the server
2. Create `docker-compose.prod.yml` in the COA Builder repo
3. Build: `docker build --platform linux/amd64 -t ghcr.io/zstar0/coabuilder:2.8.1 .`
4. Push: `docker push ghcr.io/zstar0/coabuilder:2.8.1` (first push will take time — ~2GB)
5. Subsequent pushes will only upload changed code layers (~10-50MB)
6. On server: switch to `VERSION=2.8.1 docker compose -f docker-compose.prod.yml up -d`
7. Verify: `curl http://165.227.241.81:5000/version`

---

### SENAITE LIMS

| Property                  | Value                                                                        |
| ------------------------- | ---------------------------------------------------------------------------- |
| **Container name**        | `senaite`                                                                    |
| **Current image**         | `senaite:prod-update` (built on server via context archive)                  |
| **Target image**          | `ghcr.io/zstar0/senaite:${VERSION}`                                          |
| **Port**                  | `8080:8080`                                                                  |
| **Networks**              | `senaite_default`                                                            |
| **Env vars**              | Injected via `-e` flags                                                      |
| **Health check**          | `curl http://localhost:8080/senaite` → HTTP 200                              |
| **Server directory**      | `/opt/senaite/` (data), `/root/senaite_deploy/` (build context)              |
| **Current deploy method** | `deploy_senaite_paramiko.py` → context archive → `docker build` on server    |
| **Volumes**               | `/opt/senaite/data:/data` (ZODB persistence — **CRITICAL, never lose this**) |
| **Image size**            | ~1.2GB                                                                       |
| **Special**:              | Post-deploy requires ZMI import steps                                        |

**docker-compose.prod.yml for SENAITE:**

```yaml
services:
  senaite:
    container_name: senaite
    image: ghcr.io/zstar0/senaite:${VERSION:?VERSION is required}
    command: fg
    ports:
      - '8080:8080'
    volumes:
      - /opt/senaite/data:/data
    environment:
      - COA_BUILDER_URL=http://coabuilder_service:5000
      - WEBHOOK_SECRET=${WEBHOOK_SECRET}
      - INTEGRATION_WEBHOOK_SECRET=${INTEGRATION_WEBHOOK_SECRET}
      - INTEGRATION_SERVICE_URL=http://integration-service:8000
      - INTEGRATION_SERVICE_JWT_SECRET=${INTEGRATION_SERVICE_JWT_SECRET}
      - NEW_RELIC_ENABLED=true
      - NEW_RELIC_LICENSE_KEY=${NEW_RELIC_LICENSE_KEY}
      - NEW_RELIC_APP_NAME=SENAITE LIMS (Production)
    restart: unless-stopped
    networks:
      - senaite_default

networks:
  senaite_default:
    external: true
```

**Critical notes:**

- **VOLUME IS CRITICAL**: `/opt/senaite/data:/data` contains the ZODB database — all SENAITE state. This volume must never be deleted. Back it up before every deploy.
- The `command: fg` is required — SENAITE runs Zope in foreground mode.
- Like COA Builder, env vars are currently `-e` flags. **Create an env file** (e.g., `/root/senaite/.env`) before migrating.
- Post-deployment may require ZMI import steps at `https://senaite.valenceanalytical.com/portal_setup/manage_importSteps` — this is unique to SENAITE and cannot be automated in the deploy script.
- Pre-deployment backup is **mandatory**: `cp -r /opt/senaite/data /opt/senaite/data-backup-$(date +%Y%m%d)` before any deploy.
- New Relic APM is already configured for SENAITE (agent v9.13.0, last Python 2.7 compatible version).

**Migration steps:**

1. **First**: Codify all `-e` flags into an env file on the server
2. **Pre-deploy backup**: Always back up `/opt/senaite/data` before touching SENAITE
3. Create `docker-compose.prod.yml` in the SENAITE repo
4. Build: `docker build --platform linux/amd64 -f Dockerfile.deploy -t ghcr.io/zstar0/senaite:1.8.0 .`
5. Push: `docker push ghcr.io/zstar0/senaite:1.8.0`
6. On server: `VERSION=1.8.0 docker compose -f docker-compose.prod.yml up -d`
7. Verify: `curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/senaite` → `200`
8. If code changes were deployed: run ZMI import steps

---

## GHCR Image Naming Convention

All images follow this pattern:

```
ghcr.io/zstar0/<service-name>:<tag>
```

| Service             | GHCR Image                           | Tags                              |
| ------------------- | ------------------------------------ | --------------------------------- |
| Accu-Mk1 Frontend   | `ghcr.io/zstar0/accu-mk1-frontend`   | `0.16.0`, `sha-abc1234`, `latest` |
| Accu-Mk1 Backend    | `ghcr.io/zstar0/accu-mk1-backend`    | `0.16.0`, `sha-abc1234`, `latest` |
| Integration Service | `ghcr.io/zstar0/integration-service` | `0.17.0`, `sha-xxx`, `latest`     |
| COA Builder         | `ghcr.io/zstar0/coabuilder`          | `2.8.1`, `sha-xxx`, `latest`      |
| SENAITE             | `ghcr.io/zstar0/senaite`             | `1.8.0`, `sha-xxx`, `latest`      |

**Tagging rules:**

- Always tag with the semantic version: `:<version>`
- Always tag with the git SHA: `:sha-<short-sha>`
- Always tag with `:latest` for convenience
- Never use `:latest` in production compose files — always pin to a version

---

## Common Gotchas

### 1. The `senaite_default` Network

Most services connect to `senaite_default`. This network must exist before any service starts. It was originally created by SENAITE's docker-compose. Since services are now managed independently:

- The network is declared as `external: true` in every compose file
- If the network doesn't exist, create it: `docker network create senaite_default`
- **Never** delete this network while any service is running

### 2. Build Platform

All images **must** be built with `--platform linux/amd64`. The droplet runs Linux x86_64. If you build on an ARM Mac or different architecture without this flag, the container will fail to start with an `exec format error`.

### 3. Environment Variable Persistence

`docker restart` does **NOT** re-read `--env-file`. If you change an env file, you must recreate the container:

```bash
VERSION=x.x.x docker compose -f docker-compose.prod.yml down
VERSION=x.x.x docker compose -f docker-compose.prod.yml up -d
```

### 4. Order of Operations During Migration

When migrating a service from bare `docker run` to `docker-compose.prod.yml`:

1. Stop and remove the old container: `docker stop <name> && docker rm <name>`
2. The old image stays on disk (harmless) — prune later
3. Start with the new compose file: `VERSION=x.x.x docker compose -f docker-compose.prod.yml up -d`
4. The container name remains the same, so other services referencing it by name will reconnect automatically

### 5. GHCR Visibility

By default, GHCR packages are **private**. The production server authenticates with GHCR to pull, so this is fine. If you need public visibility (e.g., for open-source), change it in GitHub → Packages → Package Settings.

### 6. First Push for Large Images

COA Builder (~2.2GB) and SENAITE (~1.2GB) will take significant time on the first `docker push`. After that, only changed layers are uploaded (typically ~10-50MB for code changes). This is still dramatically faster than the old methods (uploading 2GB tarballs via SFTP for every deploy).

---

## Deploy Script Template

Every service's `deploy.sh` should be adapted from the Accu-Mk1 reference at:

```
Accu-Mk1/scripts/deploy.sh
```

**Variables to change per service:**

```bash
REMOTE_DIR="/root/<service-directory>"
FRONTEND_IMAGE="$REGISTRY/<image-name>"   # or just one image if not split
BACKEND_IMAGE="..."                        # remove if single-image service
HEALTH_URL="http://localhost:<port>/<health-endpoint>"
REQUIRED_ENV_KEYS=("KEY1" "KEY2")          # service-specific required env vars
```

The core flow (preflight → build → push → pull → health → rollback → tag → release) remains identical.

---

## Rollback Procedure (Universal)

If a deploy fails after the new image is running:

```bash
# Check what version was running before
ssh root@165.227.241.81 "cat /root/<service>/.deploy/previous_version"

# Rollback
ssh root@165.227.241.81 "cd /root/<service> && \
  VERSION=<previous> docker compose -f docker-compose.prod.yml pull && \
  VERSION=<previous> docker compose -f docker-compose.prod.yml up -d"

# Verify
curl http://165.227.241.81:<port>/<health-endpoint>
```

The deploy script handles this automatically when the health check fails. Manual rollback is only needed when something goes wrong outside the script.

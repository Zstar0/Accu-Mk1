#!/usr/bin/env bash
# ============================================================
# Accu-Mk1 Deploy Script (v2 — Registry-Based)
# ============================================================
# Builds Docker images locally, pushes to GHCR, then pulls
# on the production server. No building on prod.
#
# Usage:
#   bash scripts/deploy.sh              # Full deploy
#   bash scripts/deploy.sh --dry-run    # Preview only
#   bash scripts/deploy.sh --backend    # Backend only
#   bash scripts/deploy.sh --frontend   # Frontend only
#   bash scripts/deploy.sh --skip-build # Pull existing images on prod (no local build)
#
# Prerequisites:
#   - Docker logged into GHCR: docker login ghcr.io
#   - SSH key configured for the production server
#     (fallback: sshpass if SSH key not available)
# ============================================================

set -euo pipefail

# ── Configuration ───────────────────────────────────────────
REMOTE_USER="root"
REMOTE_HOST="165.227.241.81"
REMOTE_DIR="/root/accu-mk1"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSION=$(grep '"version"' "$PROJECT_DIR/package.json" | head -1 | sed 's/.*: "\(.*\)".*/\1/')
GIT_SHA=$(git -C "$PROJECT_DIR" rev-parse --short HEAD 2>/dev/null || echo "unknown")

# Derive GitHub repo slug (owner/repo) from the origin remote so renames/forks just work
REPO_SLUG=$(git -C "$PROJECT_DIR" remote get-url origin 2>/dev/null | sed -E 's|.*github\.com[:/]([^/]+/[^/.]+)(\.git)?/?$|\1|')

# GHCR image names
REGISTRY="ghcr.io/zstar0"
FRONTEND_IMAGE="$REGISTRY/accu-mk1-frontend"
BACKEND_IMAGE="$REGISTRY/accu-mk1-backend"

# Health check configuration
HEALTH_URL="https://accumk1.valenceanalytical.com/api/health"
HEALTH_RETRIES=10
HEALTH_INTERVAL=3

# Minimum free disk space on prod (in KB) — 2GB
MIN_DISK_KB=2097152

# New Relic Change Tracking
# To find your entity GUID: New Relic → APM → your app → metadata → entityGuid
# Leave empty to skip New Relic markers
NEW_RELIC_API_KEY="${NEW_RELIC_API_KEY:-}"
NEW_RELIC_ENTITY_GUID="${NEW_RELIC_ENTITY_GUID:-}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'

# ── Helpers ─────────────────────────────────────────────────
info()    { echo -e "${BLUE}ℹ${NC}  $*"; }
success() { echo -e "${GREEN}✔${NC}  $*"; }
warn()    { echo -e "${YELLOW}⚠${NC}  $*"; }
error()   { echo -e "${RED}✖${NC}  $*" >&2; }

# Step tracking — records completed steps for failure summary
DEPLOY_STEPS=()
step_done() { DEPLOY_STEPS+=("$1"); }
DEPLOY_FAILED_STEP=""

# Trap handler — prints status summary on ANY exit (error, Ctrl+C, etc.)
print_deploy_status() {
    local exit_code=$?
    if [ $exit_code -ne 0 ] || [ -n "$DEPLOY_FAILED_STEP" ]; then
        echo ""
        echo -e "${BOLD}${RED}═══ Deploy Interrupted ═══${NC}"
        echo ""
        echo -e "  ${BOLD}Version:${NC}  ${VERSION:-unknown}"
        echo -e "  ${BOLD}SHA:${NC}      ${GIT_SHA:-unknown}"
        echo ""
        echo -e "  ${BOLD}Completed steps:${NC}"
        if [ ${#DEPLOY_STEPS[@]} -eq 0 ]; then
            echo -e "    ${YELLOW}(none)${NC}"
        else
            for s in "${DEPLOY_STEPS[@]}"; do
                echo -e "    ${GREEN}✔${NC}  $s"
            done
        fi
        if [ -n "$DEPLOY_FAILED_STEP" ]; then
            echo -e "    ${RED}✖${NC}  $DEPLOY_FAILED_STEP  ${RED}← FAILED${NC}"
        fi
        echo ""
        echo -e "  ${CYAN}What to do:${NC}"
        echo -e "    If images were pushed, the containers may already be running the new version."
        echo -e "    Check:  ssh $REMOTE_USER@$REMOTE_HOST 'cd $REMOTE_DIR && docker compose -f docker-compose.prod.yml ps'"
        echo -e "    Resume: bash scripts/deploy.sh --skip-build  (pulls and restarts)"
        echo ""
    fi
}
trap print_deploy_status EXIT
header()  { echo -e "\n${BOLD}${CYAN}═══ $* ═══${NC}\n"; }

# SSH multiplexing — one persistent connection reused by all commands
SSH_SOCKET="/tmp/accu-mk1-deploy-$$"
SSH_MUX_OPTS="-o ControlPath=$SSH_SOCKET"

cleanup_ssh() {
    if [ -S "$SSH_SOCKET" ] 2>/dev/null; then
        ssh -o ControlPath="$SSH_SOCKET" -O exit "$REMOTE_USER@$REMOTE_HOST" 2>/dev/null || true
    fi
}
# Chain cleanup into existing trap
original_trap=$(trap -p EXIT | sed "s/trap -- '\(.*\)' EXIT/\1/")
trap "cleanup_ssh; $original_trap" EXIT

# SSH wrapper — tries key-based auth first, falls back to sshpass
ssh_cmd() {
    if ssh -o BatchMode=yes -o ConnectTimeout=5 "$REMOTE_USER@$REMOTE_HOST" true 2>/dev/null; then
        ssh -o StrictHostKeyChecking=no \
            -o ConnectTimeout=60 -o ServerAliveInterval=30 -o ServerAliveCountMax=20 \
            "$REMOTE_USER@$REMOTE_HOST" "$@"
    elif [ -n "${REMOTE_PASS:-}" ]; then
        sshpass -p "$REMOTE_PASS" ssh -o StrictHostKeyChecking=no \
            -o ConnectTimeout=60 -o ServerAliveInterval=30 -o ServerAliveCountMax=20 \
            "$REMOTE_USER@$REMOTE_HOST" "$@"
    else
        error "No SSH key configured and no password provided."
        error "Set up SSH keys:  ssh-copy-id $REMOTE_USER@$REMOTE_HOST"
        error "Or provide password:  REMOTE_PASS=xxx bash scripts/deploy.sh"
        exit 1
    fi
}

# Detect SSH auth method and open persistent multiplexed connection
detect_ssh_auth() {
    if ssh -o BatchMode=yes -o ConnectTimeout=10 "$REMOTE_USER@$REMOTE_HOST" true 2>/dev/null; then
        SSH_METHOD="key"
    elif [ -z "${REMOTE_PASS:-}" ]; then
        read -sp "$(echo -e "${YELLOW}🔑 SSH password for ${REMOTE_USER}@${REMOTE_HOST}:${NC} ")" REMOTE_PASS
        echo ""
        if command -v sshpass &>/dev/null; then
            SSH_METHOD="sshpass"
        else
            error "No SSH key and sshpass not installed."
            exit 1
        fi
    fi

    # Open persistent ControlMaster connection (stays open for entire deploy)
    info "Opening persistent SSH connection..."
    if [ "$SSH_METHOD" = "key" ]; then
        ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 \
            -o ControlMaster=yes -o ControlPath="$SSH_SOCKET" -o ControlPersist=600 \
            -o ServerAliveInterval=15 -o ServerAliveCountMax=40 \
            -fN "$REMOTE_USER@$REMOTE_HOST"
    else
        sshpass -p "$REMOTE_PASS" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 \
            -o ControlMaster=yes -o ControlPath="$SSH_SOCKET" -o ControlPersist=600 \
            -o ServerAliveInterval=15 -o ServerAliveCountMax=40 \
            -fN "$REMOTE_USER@$REMOTE_HOST"
    fi
}

# All SSH commands reuse the persistent multiplexed connection
run_ssh() {
    ssh -o StrictHostKeyChecking=no -o ControlPath="$SSH_SOCKET" \
        "$REMOTE_USER@$REMOTE_HOST" "$@"
}

# SSH with retry — for critical deployment steps that must not fail on flaky SSH
run_ssh_retry() {
    local max_attempts=3
    local attempt=1
    local backoff=10
    while [ $attempt -le $max_attempts ]; do
        if run_ssh "$@"; then
            return 0
        fi
        if [ $attempt -lt $max_attempts ]; then
            warn "SSH command failed (attempt $attempt/$max_attempts) — retrying in ${backoff}s..."
            sleep $backoff
            backoff=$((backoff * 2))
        fi
        attempt=$((attempt + 1))
    done
    error "SSH command failed after $max_attempts attempts"
    return 1
}

run_scp() {
    scp -o StrictHostKeyChecking=no -o ControlPath="$SSH_SOCKET" "$@"
}

# ── Parse Arguments ─────────────────────────────────────────
DRY_RUN=false
DEPLOY_FRONTEND=true
DEPLOY_BACKEND=true
SKIP_BUILD=false
SKIP_RELEASE=false

for arg in "$@"; do
    case $arg in
        --dry-run)     DRY_RUN=true ;;
        --frontend)    DEPLOY_BACKEND=false ;;
        --backend)     DEPLOY_FRONTEND=false ;;
        --skip-build)  SKIP_BUILD=true ;;
        --skip-release) SKIP_RELEASE=true ;;
        --help|-h)
            echo "Usage: bash scripts/deploy.sh [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --dry-run      Preview what would happen without making changes"
            echo "  --frontend     Deploy frontend only"
            echo "  --backend      Deploy backend only"
            echo "  --skip-build   Skip local build, just pull existing images on prod"
            echo "  --skip-release Skip git tag and GitHub release creation"
            echo "  --help         Show this help"
            exit 0
            ;;
        *)
            error "Unknown argument: $arg"
            exit 1
            ;;
    esac
done

# ── Pre-flight Checks ──────────────────────────────────────
header "Accu-Mk1 Deploy v${VERSION} (${GIT_SHA})"

if [ "$DRY_RUN" = true ]; then
    warn "DRY RUN — no changes will be made"
fi

# 1. Check Docker is running locally
if ! docker info &>/dev/null; then
    error "Docker is not running. Start Docker Desktop and try again."
    exit 1
fi
success "Local Docker running"

# 2. Check GHCR login
if ! docker pull "$FRONTEND_IMAGE:probe-auth-test" 2>&1 | grep -q "denied\|not found\|manifest unknown"; then
    # If we get something other than denied/not found, login might have issues
    true
fi
# Better check: try to inspect the credential store
if ! grep -q "ghcr.io" ~/.docker/config.json 2>/dev/null; then
    warn "Not logged into GHCR. Run:  docker login ghcr.io -u YOUR_GITHUB_USERNAME"
    warn "Use a Personal Access Token (classic) with write:packages scope as the password."
    error "GHCR authentication required."
    exit 1
fi
success "GHCR credentials found"

# 3. Check SSH connectivity
info "Testing SSH connection..."
detect_ssh_auth
if ! run_ssh "echo ok" &>/dev/null; then
    error "Cannot connect to ${REMOTE_HOST}. Check credentials."
    exit 1
fi
success "SSH connection verified (method: $SSH_METHOD)"

# 4. Check disk space on prod
DISK_AVAIL=$(run_ssh "df --output=avail / | tail -1 | tr -d ' '")
if [ "$DISK_AVAIL" -lt "$MIN_DISK_KB" ]; then
    DISK_GB=$(echo "scale=1; $DISK_AVAIL / 1048576" | bc)
    error "Low disk space on prod: ${DISK_GB}GB available (need ≥2GB)"
    exit 1
fi
DISK_GB=$(echo "scale=1; $DISK_AVAIL / 1048576" | bc 2>/dev/null || echo "$((DISK_AVAIL / 1048576))")
success "Disk space on prod: ${DISK_GB}GB available"

# 5. Verify backend .env exists on server
if ! run_ssh "test -f $REMOTE_DIR/backend/.env"; then
    error "backend/.env missing on production server!"
    error "SSH in and create it: ssh $REMOTE_USER@$REMOTE_HOST"
    exit 1
fi
success "Production backend/.env exists"

# 6. Check required env keys on server (single SSH call for all keys)
REQUIRED_ENV_KEYS=("JWT_SECRET" "MK1_DB_HOST" "MK1_DB_PASSWORD")
MISSING_KEYS_STR=$(run_ssh "for key in JWT_SECRET MK1_DB_HOST MK1_DB_PASSWORD; do grep -q \"\${key}\" $REMOTE_DIR/backend/.env 2>/dev/null || echo \$key; done" 2>/dev/null) || MISSING_KEYS_STR=""
read -ra MISSING_KEYS <<< "$MISSING_KEYS_STR"
if [ ${#MISSING_KEYS[@]} -gt 0 ] && [ -n "${MISSING_KEYS[0]}" ]; then
    warn "Missing env keys on prod: ${MISSING_KEYS[*]}"
    warn "Verify backend/.env has all required variables before proceeding."
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
else
    success "Required env keys verified"
fi

# Show current state (non-blocking — 15s timeout)
if timeout 15 run_ssh "cd $REMOTE_DIR && docker compose -f docker-compose.prod.yml ps --format 'table {{.Name}}\t{{.Status}}'" 2>/dev/null; then
    true
elif timeout 15 run_ssh "cd $REMOTE_DIR && docker compose ps --format 'table {{.Name}}\t{{.Status}}'" 2>/dev/null; then
    true
else
    echo "    (could not fetch container status — continuing anyway)"
fi

if [ "$DRY_RUN" = true ]; then
    echo ""
    info "Would build and push:"
    [ "$DEPLOY_FRONTEND" = true ] && info "  $FRONTEND_IMAGE:$VERSION"
    [ "$DEPLOY_BACKEND" = true ]  && info "  $BACKEND_IMAGE:$VERSION"
    info "Then pull and restart on $REMOTE_HOST"
    warn "Dry run complete. No changes were made."
    exit 0
fi

# ── Build & Push Images ───────────────────────────────────
if [ "$SKIP_BUILD" = false ]; then
    header "Building Images"

    if [ "$DEPLOY_FRONTEND" = true ]; then
        info "Building frontend image..."
        docker build \
            --platform linux/amd64 \
            --build-arg ENV_FILE=.env.production \
            -t "$FRONTEND_IMAGE:$VERSION" \
            -t "$FRONTEND_IMAGE:sha-$GIT_SHA" \
            -t "$FRONTEND_IMAGE:latest" \
            -f "$PROJECT_DIR/Dockerfile" \
            "$PROJECT_DIR"
        success "Frontend image built: $FRONTEND_IMAGE:$VERSION"
        step_done "Frontend image built"
    fi

    if [ "$DEPLOY_BACKEND" = true ]; then
        info "Building backend image..."
        docker build \
            --platform linux/amd64 \
            --build-arg APP_VERSION="$VERSION" \
            -t "$BACKEND_IMAGE:$VERSION" \
            -t "$BACKEND_IMAGE:sha-$GIT_SHA" \
            -t "$BACKEND_IMAGE:latest" \
            -f "$PROJECT_DIR/backend/Dockerfile" \
            "$PROJECT_DIR/backend"
        success "Backend image built: $BACKEND_IMAGE:$VERSION"
        step_done "Backend image built"
    fi

    header "Pushing to GHCR"

    if [ "$DEPLOY_FRONTEND" = true ]; then
        info "Pushing frontend images..."
        docker push "$FRONTEND_IMAGE:$VERSION"
        docker push "$FRONTEND_IMAGE:sha-$GIT_SHA"
        docker push "$FRONTEND_IMAGE:latest"
        success "Frontend pushed to GHCR"
        step_done "Frontend pushed to GHCR"
    fi

    if [ "$DEPLOY_BACKEND" = true ]; then
        info "Pushing backend images..."
        docker push "$BACKEND_IMAGE:$VERSION"
        docker push "$BACKEND_IMAGE:sha-$GIT_SHA"
        docker push "$BACKEND_IMAGE:latest"
        success "Backend pushed to GHCR"
        step_done "Backend pushed to GHCR"
    fi
else
    info "Skipping local build (--skip-build). Will pull existing images on prod."
fi

# ── Pre-deploy: Backup version tracking ───────────────────
header "Deploying to Production"

# Ensure deploy tracking directory exists
run_ssh "mkdir -p $REMOTE_DIR/.deploy"

# Save previous version
run_ssh "cat $REMOTE_DIR/.deploy/current_version 2>/dev/null > $REMOTE_DIR/.deploy/previous_version || true"

# ── Upload production compose file ────────────────────────
info "Uploading production compose file..."
run_scp "$PROJECT_DIR/docker-compose.prod.yml" \
    "$REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/docker-compose.prod.yml"
success "Production compose file uploaded"
step_done "Compose file uploaded"

# ── Ensure GHCR auth on prod ─────────────────────────────
# The prod server needs read access to pull images from GHCR
if ! run_ssh "grep -q 'ghcr.io' ~/.docker/config.json 2>/dev/null"; then
    warn "Production server not logged into GHCR."
    warn "SSH in and run:  docker login ghcr.io -u YOUR_GITHUB_USERNAME"
    warn "Use a PAT with read:packages scope."
    error "Cannot pull images without GHCR auth on prod."
    exit 1
fi

# ── Pull & Deploy ────────────────────────────────────────
info "Pulling images on prod..."
DEPLOY_FAILED_STEP="Pull images on prod"
run_ssh_retry "cd $REMOTE_DIR && VERSION=$VERSION docker compose -f docker-compose.prod.yml pull"
DEPLOY_FAILED_STEP=""
success "Images pulled on prod"
step_done "Images pulled on prod"

info "Starting containers..."
DEPLOY_FAILED_STEP="Start containers"
run_ssh_retry "cd $REMOTE_DIR && VERSION=$VERSION docker compose -f docker-compose.prod.yml up -d --remove-orphans"
DEPLOY_FAILED_STEP=""
success "Containers started"
step_done "Containers started"

# ── Health Check with Retry ──────────────────────────────
header "Health Check"

HEALTH_OK=false
for i in $(seq 1 $HEALTH_RETRIES); do
    sleep $HEALTH_INTERVAL
    DEPLOY_FAILED_STEP="Health check (attempt $i/$HEALTH_RETRIES)"
    HEALTH=$(run_ssh "curl -sf http://localhost:3100/api/health 2>/dev/null" || echo "FAILED")

    if echo "$HEALTH" | grep -q '"status":"ok"'; then
        DEPLOY_FAILED_STEP=""
        success "Health check passed (attempt $i/$HEALTH_RETRIES): $HEALTH"
        step_done "Health check passed"
        HEALTH_OK=true
        break
    else
        if [ "$i" -lt "$HEALTH_RETRIES" ]; then
            warn "Health check attempt $i/$HEALTH_RETRIES: $HEALTH — retrying in ${HEALTH_INTERVAL}s..."
        else
            error "Health check attempt $i/$HEALTH_RETRIES: $HEALTH"
        fi
    fi
done

# ── Auto-Rollback on Failure ─────────────────────────────
if [ "$HEALTH_OK" = false ]; then
    error "Health check failed after $HEALTH_RETRIES attempts!"

    PREV_VERSION=$(run_ssh "cat $REMOTE_DIR/.deploy/previous_version 2>/dev/null" || echo "")
    if [ -n "$PREV_VERSION" ] && [ "$PREV_VERSION" != "$VERSION" ]; then
        warn "Rolling back to previous version: $PREV_VERSION"
        run_ssh "cd $REMOTE_DIR && VERSION=$PREV_VERSION docker compose -f docker-compose.prod.yml pull && VERSION=$PREV_VERSION docker compose -f docker-compose.prod.yml up -d --remove-orphans"

        # Check rollback health
        sleep 5
        ROLLBACK_HEALTH=$(run_ssh "curl -sf http://localhost:3100/api/health 2>/dev/null" || echo "FAILED")
        if echo "$ROLLBACK_HEALTH" | grep -q '"status":"ok"'; then
            warn "Rollback successful. Running version: $PREV_VERSION"
            warn "Investigate what went wrong with v${VERSION} before redeploying."
        else
            error "Rollback also failed! Manual intervention required."
            error "SSH in: ssh $REMOTE_USER@$REMOTE_HOST"
        fi
    else
        error "No previous version to rollback to. Manual intervention required."
        error "SSH in: ssh $REMOTE_USER@$REMOTE_HOST"
        error "Logs:   cd $REMOTE_DIR && docker compose -f docker-compose.prod.yml logs --tail 50"
    fi
    exit 1
fi

# ── Update Version Tracking ─────────────────────────────
run_ssh "echo '$VERSION' > $REMOTE_DIR/.deploy/current_version"
run_ssh "echo '$(date -u +%Y-%m-%dT%H:%M:%SZ) v$VERSION sha:$GIT_SHA' >> $REMOTE_DIR/.deploy/deploy.log"
success "Version tracking updated"
step_done "Version tracking updated"

# ── Git Tag & GitHub Release ─────────────────────────────
if [ "$SKIP_RELEASE" = false ]; then
    header "Git Tag & GitHub Release"

    # Check if tag already exists
    if git -C "$PROJECT_DIR" rev-parse "v$VERSION" >/dev/null 2>&1; then
        warn "Git tag v$VERSION already exists — skipping tag creation"
    else
        info "Creating git tag v$VERSION..."
        git -C "$PROJECT_DIR" tag -a "v$VERSION" -m "Release v$VERSION"
        git -C "$PROJECT_DIR" push origin "v$VERSION"
        success "Git tag v$VERSION pushed"
    fi

    # Create GitHub release
    if command -v gh &>/dev/null; then
        # Check if release already exists
        if gh release view "v$VERSION" --repo "$REPO_SLUG" &>/dev/null 2>&1; then
            warn "GitHub release v$VERSION already exists — skipping"
        else
            info "Creating GitHub release v$VERSION..."
            RELEASE_NOTES="## Deploy v$VERSION\n\n"
            RELEASE_NOTES+="- **SHA**: $GIT_SHA\n"
            RELEASE_NOTES+="- **Images**: \`$FRONTEND_IMAGE:$VERSION\`, \`$BACKEND_IMAGE:$VERSION\`\n"
            RELEASE_NOTES+="- **Server**: $REMOTE_HOST\n"

            # Use CHANGELOG.md if it exists
            if [ -f "$PROJECT_DIR/CHANGELOG.md" ]; then
                gh release create "v$VERSION" \
                    --repo "$REPO_SLUG" \
                    --title "v$VERSION" \
                    --notes-file "$PROJECT_DIR/CHANGELOG.md" \
                    2>/dev/null && success "GitHub release created" \
                    || warn "GitHub release creation failed (non-fatal)"
            else
                echo -e "$RELEASE_NOTES" | gh release create "v$VERSION" \
                    --repo "$REPO_SLUG" \
                    --title "v$VERSION" \
                    --notes-file - \
                    2>/dev/null && success "GitHub release created" \
                    || warn "GitHub release creation failed (non-fatal)"
            fi
        fi
    else
        warn "gh CLI not found — skipping GitHub release. Install: https://cli.github.com"
    fi
else
    info "Skipping git tag and release (--skip-release)"
fi

# ── New Relic Deployment Marker ──────────────────────────
if [ -n "$NEW_RELIC_API_KEY" ] && [ -n "$NEW_RELIC_ENTITY_GUID" ]; then
    header "New Relic Deployment Marker"
    info "Recording deployment in New Relic..."

    TIMESTAMP=$(date +%s)000  # milliseconds
    NR_DESCRIPTION="Deploy v$VERSION (sha:$GIT_SHA) to $REMOTE_HOST"

    NR_RESPONSE=$(curl -s -X POST "https://api.newrelic.com/graphql" \
        -H "Content-Type: application/json" \
        -H "API-Key: $NEW_RELIC_API_KEY" \
        -d "{\"query\": \"mutation { changeTrackingCreateDeployment(deployment: { version: \\\"$VERSION\\\", entityGuid: \\\"$NEW_RELIC_ENTITY_GUID\\\", timestamp: $TIMESTAMP, description: \\\"$NR_DESCRIPTION\\\", commit: \\\"$GIT_SHA\\\" }) { deploymentId } }\"}") || true

    if echo "$NR_RESPONSE" | grep -q 'deploymentId'; then
        DEPLOY_ID=$(echo "$NR_RESPONSE" | grep -o '"deploymentId":"[^"]*"' | cut -d'"' -f4)
        success "New Relic deployment marker created: $DEPLOY_ID"
    else
        warn "New Relic marker failed (non-fatal): $NR_RESPONSE"
    fi
else
    info "New Relic not configured — skipping deployment marker"
    info "Set NEW_RELIC_API_KEY and NEW_RELIC_ENTITY_GUID to enable"
fi

# ── Cleanup ──────────────────────────────────────────────
info "Cleaning up dangling images on prod..."
run_ssh "docker image prune -f 2>/dev/null" || true

# ── Summary ──────────────────────────────────────────────
DEPLOY_FAILED_STEP=""  # Clear so trap doesn't show failure
step_done "Deploy complete"
header "Deploy Complete ✔"
echo -e "  ${BOLD}Version:${NC}  $VERSION"
echo -e "  ${BOLD}SHA:${NC}      $GIT_SHA"
echo -e "  ${BOLD}Images:${NC}   $FRONTEND_IMAGE:$VERSION"
echo -e "            $BACKEND_IMAGE:$VERSION"
echo -e "  ${BOLD}URL:${NC}      https://accumk1.valenceanalytical.com"
echo -e "  ${BOLD}API:${NC}      https://accumk1.valenceanalytical.com/api/health"
echo -e "  ${BOLD}Server:${NC}   $REMOTE_HOST"
echo ""
echo -e "  ${CYAN}Useful commands:${NC}"
echo -e "    ${BOLD}Logs:${NC}     ssh $REMOTE_USER@$REMOTE_HOST 'cd $REMOTE_DIR && VERSION=$VERSION docker compose -f docker-compose.prod.yml logs -f'"
echo -e "    ${BOLD}Restart:${NC}  ssh $REMOTE_USER@$REMOTE_HOST 'cd $REMOTE_DIR && VERSION=$VERSION docker compose -f docker-compose.prod.yml restart'"
echo -e "    ${BOLD}Status:${NC}   ssh $REMOTE_USER@$REMOTE_HOST 'cd $REMOTE_DIR && VERSION=$VERSION docker compose -f docker-compose.prod.yml ps'"
echo -e "    ${BOLD}Rollback:${NC} bash scripts/deploy.sh --skip-build  (after: echo 'PREV_VER' > .deploy/current_version on prod)"
echo ""

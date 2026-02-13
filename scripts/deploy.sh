#!/usr/bin/env bash
# ============================================================
# Accu-Mk1 Deploy Script
# ============================================================
# Deploys the Accu-Mk1 frontend + backend to the production
# DigitalOcean droplet via rsync + Docker Compose.
#
# Usage:
#   bash scripts/deploy.sh              # Full deploy
#   bash scripts/deploy.sh --dry-run    # Preview only
#   bash scripts/deploy.sh --backend    # Backend only
#   bash scripts/deploy.sh --frontend   # Frontend only
#
# Prerequisites:
#   - sshpass installed (apt install sshpass / brew install sshpass)
#   - SSH access to the production server
# ============================================================

set -euo pipefail

# ── Configuration ───────────────────────────────────────────
REMOTE_USER="root"
REMOTE_HOST="165.227.241.81"
REMOTE_DIR="/root/accu-mk1"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSION=$(grep '"version"' "$PROJECT_DIR/package.json" | head -1 | sed 's/.*: "\(.*\)".*/\1/')

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color
BOLD='\033[1m'

# ── Helpers ─────────────────────────────────────────────────
info()    { echo -e "${BLUE}ℹ${NC}  $*"; }
success() { echo -e "${GREEN}✔${NC}  $*"; }
warn()    { echo -e "${YELLOW}⚠${NC}  $*"; }
error()   { echo -e "${RED}✖${NC}  $*" >&2; }
header()  { echo -e "\n${BOLD}${CYAN}═══ $* ═══${NC}\n"; }

ssh_cmd() {
    sshpass -p "$REMOTE_PASS" ssh -o StrictHostKeyChecking=no \
        -o ConnectTimeout=10 -o ServerAliveInterval=30 -o ServerAliveCountMax=20 \
        "$REMOTE_USER@$REMOTE_HOST" "$@"
}

scp_cmd() {
    sshpass -p "$REMOTE_PASS" scp -o StrictHostKeyChecking=no \
        -o ConnectTimeout=10 "$@"
}

rsync_cmd() {
    sshpass -p "$REMOTE_PASS" rsync "$@"
}

# ── Parse Arguments ─────────────────────────────────────────
DRY_RUN=false
DEPLOY_FRONTEND=true
DEPLOY_BACKEND=true

for arg in "$@"; do
    case $arg in
        --dry-run)    DRY_RUN=true ;;
        --frontend)   DEPLOY_BACKEND=false ;;
        --backend)    DEPLOY_FRONTEND=false ;;
        --help|-h)
            echo "Usage: bash scripts/deploy.sh [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --dry-run     Preview rsync without making changes"
            echo "  --frontend    Deploy frontend only"
            echo "  --backend     Deploy backend only"
            echo "  --help        Show this help"
            exit 0
            ;;
        *)
            error "Unknown argument: $arg"
            exit 1
            ;;
    esac
done

# ── Pre-flight Checks ──────────────────────────────────────
header "Accu-Mk1 Deploy v${VERSION}"

# Check for sshpass
if ! command -v sshpass &> /dev/null; then
    error "sshpass is required. Install with: apt install sshpass"
    exit 1
fi

# Get password (prompt once, reuse everywhere)
if [ -z "${REMOTE_PASS:-}" ]; then
    read -sp "$(echo -e "${YELLOW}🔑 SSH password for ${REMOTE_USER}@${REMOTE_HOST}:${NC} ")" REMOTE_PASS
    echo ""
fi

# Verify SSH connection
info "Testing SSH connection..."
if ! ssh_cmd "echo ok" &>/dev/null; then
    error "Cannot connect to ${REMOTE_HOST}. Check credentials."
    exit 1
fi
success "SSH connection verified"

# Check Docker on remote
REMOTE_DOCKER=$(ssh_cmd "docker --version 2>/dev/null" || echo "not found")
info "Remote Docker: $REMOTE_DOCKER"

# ── Pre-deploy: Capture current state ──────────────────────
header "Pre-deploy Checks"

RUNNING_CONTAINERS=$(ssh_cmd "cd $REMOTE_DIR && docker compose ps --format '{{.Name}} {{.Status}}' 2>/dev/null" || echo "none")
info "Current containers:"
echo "$RUNNING_CONTAINERS" | sed 's/^/    /'

# ── Rsync Source Code ──────────────────────────────────────
header "Syncing Source Code"

RSYNC_EXCLUDES=(
    --exclude='.git/'
    --exclude='node_modules/'
    --exclude='.venv/'
    --exclude='__pycache__/'
    --exclude='dist/'
    --exclude='data/'
    --exclude='*.db'
    --exclude='*.sqlite'
    --exclude='backend/.env'
    --exclude='.env'
    --exclude='src-tauri/'
    --exclude='ReportFiles/'
    --exclude='test-data/'
    --exclude='.planning/'
    --exclude='.agent/'
    --exclude='.claude/'
    --exclude='.gemini/'
    --exclude='.ast-grep/'
    --exclude='.playwright-mcp/'
    --exclude='.vscode/'
    --exclude='.gsd/'
    --exclude='docs/'
    --exclude='*.tar'
    --exclude='*.tar.gz'
)

RSYNC_FLAGS="-avz --delete"
if [ "$DRY_RUN" = true ]; then
    RSYNC_FLAGS="$RSYNC_FLAGS --dry-run"
    warn "DRY RUN — no changes will be made"
fi

info "Syncing from: $PROJECT_DIR/"
info "Syncing to:   $REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/"

rsync_cmd $RSYNC_FLAGS \
    "${RSYNC_EXCLUDES[@]}" \
    -e "ssh -o StrictHostKeyChecking=no" \
    "$PROJECT_DIR/" \
    "$REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/"

success "Source code synced"

if [ "$DRY_RUN" = true ]; then
    warn "Dry run complete. No containers were rebuilt."
    exit 0
fi

# ── Upload production .env.docker ──────────────────────────
if [ "$DEPLOY_FRONTEND" = true ] && [ -f "$PROJECT_DIR/.env.docker.prod" ]; then
    info "Uploading production .env.docker..."
    scp_cmd "$PROJECT_DIR/.env.docker.prod" \
        "$REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/.env.docker"
    success "Production .env.docker uploaded"
fi

# ── Build & Deploy Containers ──────────────────────────────
header "Building & Deploying"

BUILD_TARGETS=""
if [ "$DEPLOY_FRONTEND" = true ] && [ "$DEPLOY_BACKEND" = true ]; then
    BUILD_TARGETS=""  # Build all
    info "Building: frontend + backend"
elif [ "$DEPLOY_FRONTEND" = true ]; then
    BUILD_TARGETS="frontend"
    info "Building: frontend only"
elif [ "$DEPLOY_BACKEND" = true ]; then
    BUILD_TARGETS="backend"
    info "Building: backend only"
fi

info "Running docker compose up --build..."
ssh_cmd "cd $REMOTE_DIR && docker compose up -d --build $BUILD_TARGETS 2>&1"
success "Containers rebuilt and started"

# ── Post-deploy Verification ──────────────────────────────
header "Verification"

# Wait a moment for containers to stabilize
sleep 3

# Check container status
info "Container status:"
ssh_cmd "cd $REMOTE_DIR && docker compose ps --format 'table {{.Name}}\t{{.Status}}\t{{.Ports}}'"

# Health check
info "Health check..."
HEALTH=$(ssh_cmd "curl -sf http://localhost:3100/api/health 2>/dev/null" || echo "FAILED")

if echo "$HEALTH" | grep -q '"status":"ok"'; then
    success "Health check passed: $HEALTH"
else
    error "Health check failed: $HEALTH"
    warn "Check logs with: ssh $REMOTE_USER@$REMOTE_HOST 'cd $REMOTE_DIR && docker compose logs --tail 50'"
    exit 1
fi

# ── Cleanup old Docker images ─────────────────────────────
info "Cleaning up dangling images..."
ssh_cmd "docker image prune -f 2>/dev/null" || true

# ── Summary ───────────────────────────────────────────────
header "Deploy Complete ✔"
echo -e "  ${BOLD}Version:${NC}  $VERSION"
echo -e "  ${BOLD}URL:${NC}      https://accumk1.valenceanalytical.com"
echo -e "  ${BOLD}API:${NC}      https://accumk1.valenceanalytical.com/api/health"
echo -e "  ${BOLD}Server:${NC}   $REMOTE_HOST"
echo ""
echo -e "  ${CYAN}Useful commands:${NC}"
echo -e "    ${BOLD}Logs:${NC}     ssh $REMOTE_USER@$REMOTE_HOST 'cd $REMOTE_DIR && docker compose logs -f'"
echo -e "    ${BOLD}Restart:${NC}  ssh $REMOTE_USER@$REMOTE_HOST 'cd $REMOTE_DIR && docker compose restart'"
echo -e "    ${BOLD}Status:${NC}   ssh $REMOTE_USER@$REMOTE_HOST 'cd $REMOTE_DIR && docker compose ps'"
echo ""

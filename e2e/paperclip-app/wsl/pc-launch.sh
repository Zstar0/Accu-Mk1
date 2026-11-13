#!/bin/bash
# Throwaway Paperclip instance for the AccuMk1 acceptance run. Mirrors the env of
# tests/e2e/playwright.config.ts (onboard --yes --run in a temp PAPERCLIP_HOME), but on
# loopback :8560 with schedulers, backups, announcements, telemetry and update checks off,
# and the Vite dev middleware so the loopback Mk1 origin is accepted (dev-only switch).
set -eu
S=/tmp/accept-ag
H=$S/pc-home
rm -rf "$H"; mkdir -p "$H"
umask 077
cat > $S/pc-secrets.env <<EOF
export PAPERCLIP_HOME=$H
export PAPERCLIP_INSTANCE_ID=accumk1-accept
export PAPERCLIP_CONFIG=$H/instances/accumk1-accept/config.json
export PAPERCLIP_AGENT_JWT_SECRET=$(openssl rand -hex 32)
export PAPERCLIP_DECISION_SIGNING_SECRET=$(openssl rand -hex 32)
export PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=$(openssl rand -hex 32)
EOF
. $S/pc-secrets.env
export NODE_ENV=development PORT=8560 PAPERCLIP_API_URL=http://127.0.0.1:8560
export PAPERCLIP_OPEN_ON_LISTEN=false PAPERCLIP_BIND=loopback
export PAPERCLIP_DEPLOYMENT_MODE=local_trusted PAPERCLIP_DEPLOYMENT_EXPOSURE=private
export HEARTBEAT_SCHEDULER_ENABLED=false PAPERCLIP_ANNOUNCEMENTS_ENABLED=false
export PAPERCLIP_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 PAPERCLIP_UPDATE_CHECK=false
export PAPERCLIP_DB_BACKUP_ENABLED=false
export SERVE_UI=true PAPERCLIP_UI_DEV_MIDDLEWARE=true
export VITE_ACCUMK1_ORIGIN=http://127.0.0.1:8561 VITE_ACCUMK1_ALLOW_LOOPBACK_HTTP=true
echo $$ > $S/pc-launch.pid
exec pnpm paperclipai onboard --yes --run > $S/pc-server.log 2>&1

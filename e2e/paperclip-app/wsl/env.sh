#!/bin/bash
# isolated env for acceptance runs: Node 24.21.0, no DB/prod env
N=/home/forrest/.hermes/cache/scratch/node-v24.21.0-paperclip/extract/node-v24.21.0-linux-x64/bin
export PATH=/tmp/accept-ag/bin:$N:/home/forrest/.local/share/pnpm:/usr/local/bin:/usr/bin:/bin
unset DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE
cd /home/forrest/accumark-production/worktrees/paperclip-accumk1-docs
exec "$@"

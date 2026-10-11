#!/bin/bash
. /tmp/accept-ag/pc-secrets.env
cd server
node --import tsx scripts/accumk1-acceptance-seed.ts /tmp/accept-ag/refs.json /tmp/accept-ag/seed-out.json > /tmp/accept-ag/seed.log 2>&1
echo "SEED_EXIT=$?" >> /tmp/accept-ag/seed.log

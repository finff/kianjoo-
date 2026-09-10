#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Server-side deploy: runs ON cPanel (invoked by deploy.php), not on a
# dev machine. Idempotent — safe to run twice in a row.
#
# NOT the same thing as deploy.sh (that one runs on a dev machine and
# pushes files over FTP to the old tm-next-series site). This one lives
# in the repo, gets pulled with everything else, and does a plain
# `git fetch && git reset --hard` in place since the cPanel Git repo
# path IS this site's document root.
#
# Deliberately does NOT run any database migration/provisioning step —
# see docs/deploy.md's "migration is manual" rule.
# ─────────────────────────────────────────────────────────────
set -euo pipefail

# Widen PATH — cPanel's web-user shell environment is often minimal and
# may not have git on it by default depending on the exec context.
export PATH="/usr/local/bin:/usr/bin:/bin:/opt/cpanel/composer/bin:$PATH"

cd "$(dirname "$0")"

# The repo may be owned by a different uid than the one PHP/bash runs
# as under cPanel's suexec — git refuses to operate on it otherwise.
git config --global --add safe.directory "$(pwd)"

echo "now at $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"

git fetch origin
git reset --hard origin/main

echo "now at $(git rev-parse --short HEAD)"

# No composer, no artisan, no Node build here: this app has no
# dependency manager and no build step — PHP files are interpreted
# directly and app.js/app.css are committed as-is. Nothing to cache.

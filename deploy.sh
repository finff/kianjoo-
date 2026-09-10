#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Deploy tm-next-series.weststar-dev.com over FTP (LFTP mirror).
# Reads FTP_* from .env.
#
#   ./deploy.sh          Upload app files (excludes .env + local data)
#   ./deploy.sh --env    Upload ONLY .env (do this once, first-time setup)
#   ./deploy.sh --all    Upload app files AND .env
# ─────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")"

set -a; source ./.env; set +a
: "${FTP_HOST:?missing FTP_HOST in .env}"
: "${FTP_USER:?missing FTP_USER in .env}"
: "${FTP_PASS:?missing FTP_PASS in .env}"
: "${FTP_REMOTE_DIR:?missing FTP_REMOTE_DIR in .env}"
FTP_PORT="${FTP_PORT:-21}"
MODE="${1:-app}"

SSL_OPTS="set ftp:ssl-allow no"
if [ "${FTP_SECURE:-false}" = "true" ]; then
  SSL_OPTS="set ftp:ssl-allow true; set ftp:ssl-force false; set ssl:verify-certificate no"
fi

run_lftp() { lftp -u "${FTP_USER},${FTP_PASS}" -p "${FTP_PORT}" "${FTP_HOST}" <<EOF
${SSL_OPTS}
set net:timeout 20; set net:max-retries 3; set net:reconnect-interval-base 5
$1
bye
EOF
}

push_env() {
  echo "→ Uploading .env"
  run_lftp "put -O \"${FTP_REMOTE_DIR}\" ./.env"
  echo "✓ .env uploaded."
}

push_app() {
  echo "→ Mirroring app files to ${FTP_REMOTE_DIR}"
  run_lftp "mirror -R --verbose --parallel=3 \
    --exclude-glob .git/ \
    --exclude-glob .env \
    --exclude-glob tests/router.php \
    --exclude-glob storage/*.sqlite* \
    --exclude-glob storage/*.jsonl \
    --exclude-glob storage/*.ai.json \
    --exclude-glob storage/*.cams.json \
    --exclude-glob storage/sense_token.json \
    --exclude-glob storage/app_settings.json \
    --exclude-glob storage/alert_settings.json \
    --exclude-glob storage/roles.json \
    --exclude-glob storage/forecast_llm.json \
    --exclude-glob storage/upstream_state.json \
    --exclude-glob storage/attachments/ \
    --exclude-glob uploads/profiles/ \
    --exclude-glob live-bridge/go2rtc \
    --exclude-glob .playwright-mcp/ \
    --exclude-glob storage/mail_*.lock \
    --exclude-glob live-bridge/ \
    --exclude-glob _diag.php \
    --exclude-glob cp_src/ \
    --exclude-glob .playwright-mcp/ \
    --exclude-glob document/ \
    --exclude-glob sensetimedocumentation/ \
    --exclude-glob *.zip \
    --exclude-glob .DS_Store \
    ./ \"${FTP_REMOTE_DIR}/\""
  echo "✓ Files uploaded."
}

case "$MODE" in
  --env) push_env ;;
  --all) push_app; push_env ;;
  *)     push_app ;;
esac

echo ""
echo "Next: provision the database (idempotent):"
echo "  curl \"https://tm-next-series.weststar-dev.com/api/provision?token=${PROVISION_TOKEN}\""

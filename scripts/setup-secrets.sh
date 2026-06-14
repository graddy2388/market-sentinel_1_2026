#!/usr/bin/env bash
# setup-secrets.sh — Install the 1Password service-account token on the host.
#
# Market Sentinel no longer stores vendor API keys on the host. Instead it
# resolves op:// references (see docker-compose.yml) at startup using a single
# 1Password service-account token. This script installs only that token, with
# locked-down permissions, as the file Compose mounts at /run/secrets/op_token.
#
# Prerequisites (one-time, in your 1Password account):
#   1. Create a vault, e.g. "market-sentinel".
#   2. Add an item per provider with the API key in a field named "credential",
#      matching the op:// references in docker-compose.yml, e.g.:
#        op://market-sentinel/openai/credential
#        op://market-sentinel/anthropic/credential
#        op://market-sentinel/discord-bot/credential   (Discord bot token)
#        ...gemini, groq, cohere, mistral, deepseek, finnhub, goldapi, dashboard
#   3. Create a SERVICE ACCOUNT scoped to read that vault and copy its token
#      (starts with "ops_").
#
# Usage (run ON the Docker host):
#   ./scripts/setup-secrets.sh                 # prompts for the token (no echo)
#   OP_TOKEN=ops_... ./scripts/setup-secrets.sh  # non-interactive

set -euo pipefail

SECRETS_DIR="/opt/market-sentinel"
TOKEN_FILE="${SECRETS_DIR}/op_token"

echo "[setup] Target: ${TOKEN_FILE}"
sudo mkdir -p "${SECRETS_DIR}"

TOKEN="${OP_TOKEN:-}"
if [[ -z "${TOKEN}" ]]; then
  read -rsp "Paste the 1Password service-account token (ops_...): " TOKEN
  echo
fi

if [[ -z "${TOKEN}" ]]; then
  echo "[setup] ERROR: no token provided." >&2
  exit 1
fi
if [[ "${TOKEN}" != ops_* ]]; then
  echo "[setup] WARNING: token does not start with 'ops_' — continuing anyway." >&2
fi

# Write without leaving the token in shell history or world-readable temp files.
umask 077
printf '%s' "${TOKEN}" | sudo tee "${TOKEN_FILE}" > /dev/null

# Readable only by root and the docker group.
sudo chown root:docker "${TOKEN_FILE}"
sudo chmod 640 "${TOKEN_FILE}"

echo "[setup] Installed: $(ls -la "${TOKEN_FILE}")"
echo "[setup] Done. Redeploy the stack in Portainer to pick up the token."
echo "[setup] Verify afterwards:  docker inspect market-sentinel --format '{{json .Config.Env}}'"
echo "[setup]   → should show op:// references, never real API keys."

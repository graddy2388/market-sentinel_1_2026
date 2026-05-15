#!/usr/bin/env bash
# setup-secrets.sh — Generate secrets.env on the Docker host from 1Password
#
# Run this ON the Docker host (192.168.4.32) before deploying the stack.
# Requires: 1Password CLI (op) authenticated via `op signin` or a service account.
#
# Usage:
#   ./scripts/setup-secrets.sh              # Interactive (uses op inject)
#   ./scripts/setup-secrets.sh --manual     # Creates blank secrets.env for manual editing

set -euo pipefail

SECRETS_DIR="/opt/market-sentinel"
SECRETS_FILE="${SECRETS_DIR}/secrets.env"
TEMPLATE="secrets.env.tpl"

echo "[setup] Target: ${SECRETS_FILE}"

# Ensure directory exists
sudo mkdir -p "${SECRETS_DIR}"

if [[ "${1:-}" == "--manual" ]]; then
  # Create a blank secrets file for manual editing
  if [[ -f "${SECRETS_FILE}" ]]; then
    echo "[setup] ${SECRETS_FILE} already exists. Edit it directly."
  else
    cat > /tmp/secrets.env.tmp <<'ENVEOF'
# Market Sentinel Secrets
# Fill in the keys you have, leave the rest blank.

# AI Council (at least one required)
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
GROQ_API_KEY=
COHERE_API_KEY=
MISTRAL_API_KEY=
DEEPSEEK_API_KEY=

# Discord bot
DISCORD_BOT_TOKEN=
DISCORD_CHANNEL_ID=
ENVEOF
    sudo mv /tmp/secrets.env.tmp "${SECRETS_FILE}"
    echo "[setup] Created blank ${SECRETS_FILE} — edit it with your API keys."
  fi
else
  # Inject from 1Password
  if ! command -v op &> /dev/null; then
    echo "[setup] ERROR: 1Password CLI (op) not found."
    echo "  Install: https://developer.1password.com/docs/cli/get-started/"
    echo "  Or use: $0 --manual"
    exit 1
  fi

  if [[ ! -f "${TEMPLATE}" ]]; then
    echo "[setup] ERROR: Template not found at ${TEMPLATE}"
    echo "  Run this from the project root, or copy secrets.env.tpl to the Docker host."
    exit 1
  fi

  echo "[setup] Injecting secrets from 1Password..."
  op inject -i "${TEMPLATE}" -o /tmp/secrets.env.tmp
  sudo mv /tmp/secrets.env.tmp "${SECRETS_FILE}"
  echo "[setup] Secrets injected successfully."
fi

# Lock down permissions — readable only by root and the docker group
sudo chown root:docker "${SECRETS_FILE}"
sudo chmod 640 "${SECRETS_FILE}"

echo "[setup] Permissions: $(ls -la "${SECRETS_FILE}")"
echo "[setup] Done. Deploy or redeploy the stack in Portainer."

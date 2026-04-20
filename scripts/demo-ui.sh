#!/usr/bin/env bash
set -euo pipefail

CONTAINER_NAME="acp-gateway-webui"
VOLUME_NAME="acp-gateway-webui-data"
IMAGE="ghcr.io/open-webui/open-webui:main"
HOST_PORT=3000
GATEWAY_PORT="${PORT:-4001}"

# Log file follows XDG Base Directory Specification
XDG_DATA_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}"
LOG_DIR="${XDG_DATA_HOME}/acp-gateway"
LOG_FILE="${LOG_DIR}/webui.log"
mkdir -p "$LOG_DIR"

# Stop any leftover container from a previous run
if docker inspect "$CONTAINER_NAME" &>/dev/null; then
  docker rm -f "$CONTAINER_NAME" &>/dev/null
fi

cleanup() {
  docker rm -f "$CONTAINER_NAME" &>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "acp-gateway-webui starting on http://localhost:${HOST_PORT}"
echo "  gateway: http://host.docker.internal:${GATEWAY_PORT}/v1"
echo "  logs:    ${LOG_FILE}"

docker run --rm \
  --name "$CONTAINER_NAME" \
  -p "${HOST_PORT}:8080" \
  -v "${VOLUME_NAME}:/app/backend/data" \
  --add-host=host.docker.internal:host-gateway \
  -e "OPENAI_API_BASE_URLS=http://host.docker.internal:${GATEWAY_PORT}/v1" \
  -e OPENAI_API_KEYS=unused \
  -e WEBUI_AUTH=false \
  -e WEBUI_ADMIN_EMAIL=admin@localhost \
  -e WEBUI_ADMIN_PASSWORD=admin \
  -e WEBUI_ADMIN_NAME=Admin \
  -e RAG_EMBEDDING_MODEL= \
  -e AUDIO_STT_ENGINE= \
  "$IMAGE" \
  >"$LOG_FILE" 2>&1

status=$?
if [ $status -ne 0 ]; then
  echo ""
  echo "Container exited with status ${status}. Last 20 lines of log:"
  tail -20 "$LOG_FILE"
fi
exit $status

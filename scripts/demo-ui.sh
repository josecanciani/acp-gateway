#!/usr/bin/env bash
set -euo pipefail

# Launch Open WebUI as a detached Docker container pointing at the gateway.
# Usage:
#   npm run demo:ui          # start the container
#   npm run demo:ui:stop     # stop the container

CONTAINER_NAME="acp-gateway-webui"
VOLUME_NAME="acp-gateway-webui-data"
IMAGE="ghcr.io/open-webui/open-webui:main"
HOST_PORT=3000
GATEWAY_PORT="${PORT:-4001}"

stop() {
  if docker ps -q -f name="^${CONTAINER_NAME}$" | grep -q .; then
    echo "Stopping ${CONTAINER_NAME}..."
    docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1
    echo "Stopped."
  else
    echo "No running ${CONTAINER_NAME} container found."
  fi
}

run() {
  # Stop any leftover container from a previous run
  if docker ps -aq -f name="^${CONTAINER_NAME}$" | grep -q .; then
    echo "Stopping existing ${CONTAINER_NAME} container..."
    docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  fi

  echo "Starting Open WebUI on http://localhost:${HOST_PORT}"
  echo "  gateway: http://host.docker.internal:${GATEWAY_PORT}/v1"

  docker run -d \
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
    "$IMAGE" >/dev/null

  echo ""
  echo "Open WebUI running at http://localhost:${HOST_PORT}"
  echo "  Stop with: npm run demo:ui:stop"
}

case "${1:-run}" in
  run)  run ;;
  stop) stop ;;
  *)
    echo "Usage: $0 {run|stop}"
    exit 1
    ;;
esac

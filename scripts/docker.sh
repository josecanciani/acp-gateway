#!/usr/bin/env bash
set -euo pipefail

# Build the gateway Docker image and run it detached, exposing the API port.
# Usage:
#   npm run docker          # build + run
#   npm run docker:stop     # stop the running container

IMAGE_NAME="acp-gateway"
CONTAINER_NAME="acp-gateway"
PORT="${PORT:-4001}"

# Auth credentials: mount the Devin credentials file so agents can authenticate.
CREDS_FILE="${DEVIN_CREDENTIALS_FILE:-${HOME}/.local/share/devin/credentials.toml}"

build() {
  echo "Building ${IMAGE_NAME} image..."
  docker build -t "${IMAGE_NAME}" .
  echo "Image ${IMAGE_NAME} built successfully."
}

run() {
  # Stop any existing container with the same name
  if docker ps -aq -f name="^${CONTAINER_NAME}$" | grep -q .; then
    echo "Stopping existing ${CONTAINER_NAME} container..."
    docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  fi

  local mount_flags=()

  # Mount credentials if they exist
  if [ -f "${CREDS_FILE}" ]; then
    mount_flags+=(-v "${CREDS_FILE}:/home/gateway/.local/share/devin/credentials.toml:ro")
    echo "Mounting credentials from ${CREDS_FILE}"
  else
    echo "Warning: No credentials file found at ${CREDS_FILE}"
    echo "  Agents won't be able to authenticate. Run 'devin login' first."
  fi

  echo "Starting ${CONTAINER_NAME} on port ${PORT}..."
  docker run -d \
    --name "${CONTAINER_NAME}" \
    -p "${PORT}:4001" \
    "${mount_flags[@]}" \
    "${IMAGE_NAME}"

  echo ""
  echo "Gateway running at http://localhost:${PORT}/v1"
  echo "  Stop with: npm run docker:stop"
}

stop() {
  if docker ps -q -f name="^${CONTAINER_NAME}$" | grep -q .; then
    echo "Stopping ${CONTAINER_NAME}..."
    docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1
    echo "Stopped."
  else
    echo "No running ${CONTAINER_NAME} container found."
  fi
}

case "${1:-run}" in
  build) build ;;
  run)   build && run ;;
  stop)  stop ;;
  *)
    echo "Usage: $0 {build|run|stop}"
    exit 1
    ;;
esac

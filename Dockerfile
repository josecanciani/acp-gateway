FROM ubuntu:24.04

LABEL org.opencontainers.image.title="acp-gateway" \
      org.opencontainers.image.description="OpenAI-compatible API gateway for ACP agents"

ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies in a single layer.
# nodejs is needed both for the gateway itself and for the MCP bridge.
# npm is needed to install gateway dependencies.
# bubblewrap provides Linux sandbox isolation for agents.
RUN --mount=type=cache,target=/var/cache/apt,id=apt-cache-gw,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,id=apt-lists-gw,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends \
       curl \
       git \
       ca-certificates \
       bubblewrap \
       nodejs \
       npm

# Rename the default ubuntu user (UID/GID 1000) to "gateway".
# Ubuntu 24.04 ships with ubuntu:ubuntu at 1000:1000; reuse it instead of
# creating a new user which would fail on duplicate UID/GID.
RUN usermod -l gateway -d /home/gateway -m ubuntu \
    && groupmod -n gateway ubuntu

# Copy and install the Devin CLI
COPY docker/install-devin.sh /tmp/install-devin.sh
RUN chmod +x /tmp/install-devin.sh

# Pre-create the workspaces directory
RUN mkdir -p /workspaces && chown gateway:gateway /workspaces

USER gateway

# Install Devin CLI as the gateway user
RUN /tmp/install-devin.sh

# Ensure ~/.local/bin is on PATH (for devin, kimi CLIs)
ENV PATH="/home/gateway/.local/bin:${PATH}"

# Copy gateway source and install dependencies
WORKDIR /app
COPY --chown=gateway:gateway package.json package-lock.json ./
RUN npm ci

COPY --chown=gateway:gateway tsconfig.json ./
COPY --chown=gateway:gateway src/ ./src/
RUN npx tsc && npm prune --omit=dev

EXPOSE 4001

CMD ["node", "dist/serve.js"]

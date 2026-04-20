FROM ubuntu:24.04

LABEL org.opencontainers.image.title="acp-gateway-agent" \
      org.opencontainers.image.description="Isolated agent execution environment for ACP Gateway" \
      org.opencontainers.image.source="https://github.com/anthropics/acp-gateway"

ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies in a single layer.
# Cache mounts: apt caches persist across builds (even with --no-cache) to avoid
# re-downloading packages. Requires Docker BuildKit (default since Docker 23.0).
RUN --mount=type=cache,target=/var/cache/apt,id=apt-cache-agent,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,id=apt-lists-agent,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends \
       curl \
       git \
       ca-certificates \
       bubblewrap

# Rename the default ubuntu user (UID/GID 1000) to "agent".
# Ubuntu 24.04 ships with ubuntu:ubuntu at 1000:1000; reuse it instead of
# creating a new user which would fail on duplicate UID/GID.
RUN usermod -l agent -d /home/agent -m ubuntu \
    && groupmod -n agent ubuntu

# Copy and run the Devin CLI install script
COPY install-devin.sh /tmp/install-devin.sh
RUN chmod +x /tmp/install-devin.sh

USER agent

# Install Devin CLI as the agent user
RUN /tmp/install-devin.sh

# Ensure ~/.local/bin is on PATH for all sessions
ENV PATH="/home/agent/.local/bin:${PATH}"

WORKDIR /workspace

CMD ["bash"]

FROM ubuntu:24.04

LABEL org.opencontainers.image.title="acp-gateway-agent" \
      org.opencontainers.image.description="Isolated agent execution environment for ACP Gateway" \
      org.opencontainers.image.source="https://github.com/anthropics/acp-gateway"

# Install system dependencies in a single layer
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       curl \
       git \
       ca-certificates \
       bubblewrap \
    && rm -rf /var/lib/apt/lists/*

# Create agent user (UID/GID 1000)
RUN groupadd -g 1000 agent \
    && useradd -m -u 1000 -g 1000 -s /bin/bash agent

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

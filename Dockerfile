# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS web-build
WORKDIR /src/web
COPY web/package*.json ./
RUN npm ci --legacy-peer-deps
COPY web/ ./
RUN npm run build

FROM golang:1.24.4-bookworm AS go-build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web-build /src/web/dist ./web/dist
RUN CGO_ENABLED=1 go build -trimpath -ldflags="-s -w" \
    -o /out/agent-remote ./cmd/agent-remote

FROM ghcr.io/openai/codex-universal:47f4f0eb5337083e2f610db0d15558932cb4901d

ARG CODEX_VERSION=0.149.1
ARG CLAUDE_CODE_VERSION=2.1.246
ARG STARSHIP_VERSION=1.24.2
ARG DELTA_VERSION=0.19.2
ARG LAZYGIT_VERSION=0.61.0
ARG YAZI_VERSION=26.1.22

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        gh \
        procps \
        unzip \
        zsh \
    && rm -rf /var/lib/apt/lists/*

COPY docker/install-shell-tools /tmp/install-shell-tools
RUN chmod 0755 /tmp/install-shell-tools \
    && STARSHIP_VERSION="$STARSHIP_VERSION" \
       DELTA_VERSION="$DELTA_VERSION" \
       LAZYGIT_VERSION="$LAZYGIT_VERSION" \
       YAZI_VERSION="$YAZI_VERSION" \
       /tmp/install-shell-tools \
    && rm /tmp/install-shell-tools

COPY docker/zsh/ /root/.config/zsh/
RUN ln -sf /root/.config/zsh/zshrc /root/.zshrc \
    && git config --system core.pager delta \
    && git config --system interactive.diffFilter 'delta --color-only' \
    && git config --system delta.navigate true \
    && git config --system merge.conflictStyle zdiff3

# Keep the image self-contained so routine restarts do not depend on npm being
# reachable. The startup wrapper below repairs either CLI if a mounted volume or
# an image change ever leaves it unavailable.
RUN bash -lc "npm install --global \
        @openai/codex@${CODEX_VERSION} \
        @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
    && codex --version \
    && claude --version \
    && for tool_name in node npm npx corepack pnpm yarn codex claude; do \
         ln -sf \"\$(command -v \"\$tool_name\")\" \"/usr/local/bin/\$tool_name\"; \
       done \
    && npm cache clean --force"

ENV XDG_RUNTIME_DIR=/var/lib/agent-remote/runtime
ENV XDG_CONFIG_HOME=/var/lib/agent-remote/config
ENV SHELL=/usr/bin/zsh
ENV CODEX_HOME=/root/.codex
ENV CLAUDE_CONFIG_DIR=/root/.claude
ENV AGENT_REMOTE_CODEX_VERSION=${CODEX_VERSION}
ENV AGENT_REMOTE_CLAUDE_CODE_VERSION=${CLAUDE_CODE_VERSION}

RUN mkdir -p \
    "$XDG_RUNTIME_DIR" \
    "$XDG_CONFIG_HOME" \
    "$CODEX_HOME" \
    "$CLAUDE_CONFIG_DIR" \
    /workspace

COPY --from=go-build /out/agent-remote /usr/local/bin/agent-remote
COPY docker/agent-remote-start /usr/local/bin/agent-remote-start

RUN chmod 0755 /usr/local/bin/agent-remote-start

WORKDIR /workspace

EXPOSE 8311

HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=10 \
    CMD curl -fsS http://127.0.0.1:8311/api/health || exit 1

ENTRYPOINT ["/opt/entrypoint.sh", "/usr/local/bin/agent-remote-start"]

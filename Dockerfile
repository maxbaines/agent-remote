# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS web-build
WORKDIR /src/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM golang:1.24.4-bookworm AS go-build
RUN apt-get update \
    && apt-get install -y --no-install-recommends libpam0g-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web-build /src/web/dist ./web/dist
RUN CGO_ENABLED=1 go build -trimpath -ldflags="-s -w" \
    -o /out/agent-remote ./cmd/agent-remote

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        git \
        libpam0g \
        procps \
    && rm -rf /var/lib/apt/lists/*

ENV XDG_RUNTIME_DIR=/var/lib/agent-remote/runtime
ENV XDG_CONFIG_HOME=/var/lib/agent-remote/config

RUN mkdir -p "$XDG_RUNTIME_DIR" "$XDG_CONFIG_HOME"

COPY --from=go-build /out/agent-remote /usr/local/bin/agent-remote

EXPOSE 8311

HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=10 \
    CMD curl -fsS http://127.0.0.1:8311/api/health || exit 1

ENTRYPOINT ["/usr/local/bin/agent-remote", "serve", "--addr", "0.0.0.0:8311", "--no-auth", "--behind-reverse-proxy", "--public-origin", "https://jt.actor"]

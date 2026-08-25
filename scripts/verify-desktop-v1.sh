#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
binary="${AGENT_REMOTE_BINARY:-${repo_root}/bin/agent-remote}"
host="127.0.0.1"
start_port="${AGENT_REMOTE_VERIFY_PORT:-18431}"
expected_uid="$(id -u)"
runtime_root="${AGENT_REMOTE_VERIFY_RUNTIME_ROOT:-${HOME}}"

if [[ "${expected_uid}" == "0" ]]; then
  echo "error: desktop v1 verification must run as the intended non-root Session Owner" >&2
  exit 1
fi
if [[ ! -x "${binary}" ]]; then
  echo "error: Agent Remote binary is not executable: ${binary}" >&2
  echo "hint: run 'make build' first" >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "error: curl is required" >&2
  exit 1
fi
if ! command -v playwright-cli >/dev/null 2>&1; then
  echo "error: playwright-cli is required for the Chromium release gate" >&2
  exit 1
fi

cases=(
  "web/e2e/desktop-v1-smoke.mjs"
  "web/e2e/command-registry.mjs"
  "web/e2e/keybindings-editor.mjs"
  "web/e2e/directional-splits.mjs"
  "web/e2e/clear-to-start.mjs"
  "web/e2e/fixed-appearance.mjs"
)

if [[ "$(uname -s)" == "Darwin" && "${AGENT_REMOTE_SKIP_SAFARI:-0}" != "1" ]]; then
  if command -v safaridriver >/dev/null 2>&1; then
    cases+=("web/e2e/safari-smoke.mjs")
  else
    echo "error: safaridriver is required for the macOS Safari smoke" >&2
    exit 1
  fi
fi

gateway_pid=""
sessiond_pid=""
runtime_base=""

cleanup_case() {
  if [[ -z "${sessiond_pid}" && -n "${runtime_base}" ]]; then
    local cleanup_socket="${runtime_base}/agent-remote/sessiond.sock"
    if [[ -S "${cleanup_socket}" ]]; then
      sessiond_pid="$(find_sessiond_pid "${cleanup_socket}")"
    fi
  fi
  if [[ -n "${gateway_pid}" ]] && kill -0 "${gateway_pid}" 2>/dev/null; then
    kill -TERM "${gateway_pid}" 2>/dev/null || true
    wait "${gateway_pid}" 2>/dev/null || true
  fi
  if [[ -n "${sessiond_pid}" ]] && kill -0 "${sessiond_pid}" 2>/dev/null; then
    kill -TERM "${sessiond_pid}" 2>/dev/null || true
    for _ in {1..20}; do
      kill -0 "${sessiond_pid}" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "${sessiond_pid}" 2>/dev/null; then
      kill -KILL "${sessiond_pid}" 2>/dev/null || true
    fi
  fi
  if [[ -n "${runtime_base}" && -d "${runtime_base}" ]]; then
    rm -rf -- "${runtime_base}"
  fi
  gateway_pid=""
  sessiond_pid=""
  runtime_base=""
}
trap cleanup_case EXIT INT TERM

owner_uid() {
  if [[ "$(uname -s)" == "Darwin" ]]; then
    stat -f '%u' "$1"
  else
    stat -c '%u' "$1"
  fi
}

wait_for_health() {
  local url="$1"
  for _ in {1..80}; do
    if curl -fsS "${url}/api/health" >/dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "${gateway_pid}" 2>/dev/null; then
      echo "error: Gateway exited before becoming healthy" >&2
      return 1
    fi
    sleep 0.25
  done
  echo "error: timed out waiting for ${url}/api/health" >&2
  return 1
}

find_sessiond_pid() {
  local socket_path="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -t -- "${socket_path}" 2>/dev/null | head -n 1
  elif command -v fuser >/dev/null 2>&1; then
    fuser "${socket_path}" 2>/dev/null | awk '{print $1}'
  fi
}

cd "${repo_root}"
for index in "${!cases[@]}"; do
  test_script="${cases[$index]}"
  port="$((start_port + index))"
  url="http://${host}:${port}"
  # macOS limits Unix-domain socket paths to 104 bytes. $TMPDIR is normally a
  # long /var/folders path, so use a deliberately short directory under $HOME.
  runtime_base="$(mktemp -d "${runtime_root%/}/.agent-remote-v1.XXXXXX")"
  log_path="${runtime_base}/gateway.log"
  socket_path="${runtime_base}/agent-remote/sessiond.sock"

  echo "==> ${test_script} (${url})"
  XDG_RUNTIME_DIR="${runtime_base}" XDG_CONFIG_HOME="${runtime_base}/config" "${binary}" serve \
    --addr "${host}:${port}" --no-auth >"${log_path}" 2>&1 &
  gateway_pid="$!"

  wait_for_health "${url}"
  gateway_uid="$(ps -o uid= -p "${gateway_pid}" | tr -d ' ')"
  if [[ "${gateway_uid}" != "${expected_uid}" ]]; then
    echo "error: Gateway uid ${gateway_uid}, expected ${expected_uid}" >&2
    exit 1
  fi

  AGENT_REMOTE_EXPECTED_UID="${expected_uid}" node "${test_script}" --url "${url}"

  if [[ ! -S "${socket_path}" ]]; then
    echo "error: Session Owner socket was not created: ${socket_path}" >&2
    exit 1
  fi
  socket_uid="$(owner_uid "${socket_path}")"
  if [[ "${socket_uid}" != "${expected_uid}" ]]; then
    echo "error: Session Owner socket uid ${socket_uid}, expected ${expected_uid}" >&2
    exit 1
  fi
  sessiond_pid="$(find_sessiond_pid "${socket_path}")"
  if [[ -z "${sessiond_pid}" ]]; then
    echo "error: could not resolve the Session Owner process for ${socket_path}" >&2
    exit 1
  fi
  sessiond_uid="$(ps -o uid= -p "${sessiond_pid}" | tr -d ' ')"
  if [[ "${sessiond_uid}" != "${expected_uid}" ]]; then
    echo "error: Session Owner uid ${sessiond_uid}, expected ${expected_uid}" >&2
    exit 1
  fi

  echo "PASS: Gateway, Session Owner, socket, and new Terminal Session use uid ${expected_uid}"
  cleanup_case
done

trap - EXIT INT TERM
echo "PASS: desktop v1 development release gate"

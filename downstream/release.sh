#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
tmp_dir="$(cd -- "${TMPDIR:-/tmp}" && pwd -P)"
log="$(mktemp "${tmp_dir}/omniroute-release-XXXXXXXXXXXX.log")"
metadata="${log%.log}.image.json"
work_dir="$(mktemp -d "${tmp_dir}/omniroute-release-XXXXXXXXXXXX")"
output="${work_dir}/output"
child_pid=""

# Keep the shell alive to report failures even when the release process exits.
exec > >(tee -a -- "$log") 2>&1
on_exit() {
  status=$?
  trap - EXIT INT TERM
  if [[ -n "$child_pid" ]]; then
    kill -TERM "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
  fi
  if [[ -f "${output}/image.json" ]]; then
    if (set -C; cat -- "${output}/image.json" > "$metadata"); then
      printf 'Release metadata: %s\n' "$metadata"
    else
      printf 'Failed to preserve release metadata at %s.\n' "$metadata" >&2
      if (( status == 0 )); then status=1; fi
    fi
  fi
  if ! rm -rf -- "$work_dir"; then
    printf 'Failed to remove release work directory: %s\n' "$work_dir" >&2
    if (( status == 0 )); then status=1; fi
  fi
  if (( status != 0 )); then
    printf '\nRelease failed (exit code %s). Log: %s\n' "$status" "$log"
    if [[ -t 0 ]]; then
      printf 'Press Enter to close this terminal... '
      read -r _ || true
    fi
  fi
  exit "$status"
}
trap on_exit EXIT
on_signal() {
  local signal="$1" status="$2"
  trap '' INT TERM
  if [[ -n "$child_pid" ]]; then
    kill -s "$signal" "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
    child_pid=""
  fi
  exit "$status"
}
trap 'on_signal INT 130' INT
trap 'on_signal TERM 143' TERM

printf 'Release work directory: %s\nRelease log: %s\n' "$work_dir" "$log"
export NVM_DIR="${NVM_DIR:-${HOME}/.nvm}"
if [[ ! -s "${NVM_DIR}/nvm.sh" ]]; then
  printf 'nvm not found at %s; install nvm or set NVM_DIR.\n' "${NVM_DIR}/nvm.sh" >&2
  exit 1
fi
if ! source "${NVM_DIR}/nvm.sh" --no-use; then
  printf 'Failed to initialize nvm from %s.\n' "${NVM_DIR}/nvm.sh" >&2
  exit 1
fi
if nvm install 24.15.0; then :; else
  status=$?
  printf 'Failed to install Node.js 24.15.0 with nvm.\n' >&2
  exit "$status"
fi
if nvm use 24.15.0; then :; else
  status=$?
  printf 'Failed to select Node.js 24.15.0 with nvm.\n' >&2
  exit "$status"
fi
if [[ -z "${GHCR_TOKEN:-}" ]]; then
  GHCR_TOKEN="$(gh auth token --hostname github.com)"
  GHCR_USERNAME="${GHCR_USERNAME:-$(gh api --hostname github.com user --jq .login)}"
  export GHCR_USERNAME
fi
export GHCR_TOKEN
node "${script_dir}/release.mjs" --output "$output" --push &
child_pid=$!
if wait "$child_pid"; then
  child_pid=""
else
  status=$?
  child_pid=""
  exit "$status"
fi

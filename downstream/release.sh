#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
tmp_dir="$(cd -- "${TMPDIR:-/tmp}" && pwd -P)"
work_dir="$(mktemp -d "${tmp_dir}/omniroute-release-XXXXXXXXXXXX")"
output="${work_dir}/output"
log="${output}.log"

# Keep the shell alive to report failures even when the release process exits.
exec > >(tee -a -- "$log") 2>&1
on_exit() {
  status=$?
  if (( status != 0 )); then
    printf '\nRelease failed (exit code %s). Log: %s\n' "$status" "$log"
    if [[ -t 0 ]]; then
      printf 'Press Enter to close this terminal... '
      read -r _ || true
    fi
  fi
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

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
node "${script_dir}/release.mjs" --output "$output" --push

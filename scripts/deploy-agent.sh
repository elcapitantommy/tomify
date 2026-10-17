#!/usr/bin/env bash
# Build and deploy an immutable recovery-agent release from Linux/macOS.
# The remote commands are built locally on purpose (fixed paths and a hexadecimal SHA).
# shellcheck disable=SC2029
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: deploy-agent.sh [--host USER@HOST] [--rollback | --bootstrap]

Defaults to TOMIFY_AGENT_HOST or tom@tomify.

--bootstrap  One-time setup (asks for the server's sudo password): installs this checkout's
             installer as /usr/local/sbin/tomify-install-agent and lets the SSH user run only
             that command without a password. Run it again after the installer changes.
--rollback   Swap back to the previously deployed release.
EOF
}

host=${TOMIFY_AGENT_HOST:-tom@tomify}
mode=deploy
while (($#)); do
  case "$1" in
    --host) (($# >= 2)) || { echo 'deploy-agent.sh: --host requires a value' >&2; exit 2; }; host=$2; shift 2 ;;
    --rollback) mode=rollback; shift ;;
    --bootstrap) mode=bootstrap; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "deploy-agent.sh: unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

repo=$(git rev-parse --show-toplevel 2>/dev/null) || { echo 'deploy-agent.sh: run this inside the Tomify checkout' >&2; exit 1; }
cd "$repo"
installer=/usr/local/sbin/tomify-install-agent
sha=$(git rev-parse --short HEAD)

if [[ $mode == bootstrap ]]; then
  dirty=$(git status --porcelain -- scripts/install-agent-release.sh)
  [[ -z $dirty ]] || { echo 'deploy-agent.sh: commit scripts/install-agent-release.sh before bootstrapping' >&2; exit 1; }
  remote_installer="/tmp/tomify-install-agent-$sha.sh"
  scp scripts/install-agent-release.sh "$host:$remote_installer"
  ssh -t "$host" "sudo bash $remote_installer --bootstrap; status=\$?; rm -f $remote_installer; exit \$status"
  exit
fi

if ! ssh "$host" "sudo -n $installer --help >/dev/null 2>&1"; then
  echo "deploy-agent.sh: $host is not set up for password-free deploys yet. Run ./scripts/deploy-agent.sh --bootstrap once." >&2
  exit 1
fi

if [[ $mode == rollback ]]; then
  ssh "$host" "sudo -n $installer --rollback"
  exit
fi

dirty=$(git status --porcelain -- recovery-agent shared)
[[ -z $dirty ]] || { echo 'deploy-agent.sh: commit or discard changes under recovery-agent/ and shared/ before deploying' >&2; echo "$dirty" >&2; exit 1; }

archive="${TMPDIR:-/tmp}/tomify-agent-$sha.tar.gz"
remote_archive="/tmp/tomify-agent-$sha.tar.gz"
trap 'rm -f -- "$archive"' EXIT
tar -czf "$archive" recovery-agent shared package.json
scp "$archive" "$host:$remote_archive"
ssh "$host" "sudo -n $installer --archive $remote_archive --sha $sha; status=\$?; rm -f $remote_archive; exit \$status"

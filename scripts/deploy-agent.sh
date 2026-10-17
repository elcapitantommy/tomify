#!/usr/bin/env bash
# Build and deploy an immutable recovery-agent release from Linux/macOS.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: deploy-agent.sh [--host USER@HOST] [--rollback | --setup]

--setup runs once (asks for the sudo password) so later deploys need none.

Defaults to TOMIFY_AGENT_HOST or tom@tomify.
EOF
}

host=${TOMIFY_AGENT_HOST:-tom@tomify}
rollback=0
setup=0
while (($#)); do
  case "$1" in
    --host) (($# >= 2)) || { echo 'deploy-agent.sh: --host requires a value' >&2; exit 2; }; host=$2; shift 2 ;;
    --rollback) rollback=1; shift ;;
    --setup) setup=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "deploy-agent.sh: unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

repo=$(git rev-parse --show-toplevel 2>/dev/null) || { echo 'deploy-agent.sh: run this inside the Tomify checkout' >&2; exit 1; }
cd "$repo"

if ((setup)); then
  scp scripts/tomify-agent-activate.sh scripts/setup-agent-deploy.sh "$host:/tmp/"
  ssh -t "$host" 'sudo bash /tmp/setup-agent-deploy.sh /tmp/tomify-agent-activate.sh "$(id -un)"; status=$?; rm -f /tmp/setup-agent-deploy.sh /tmp/tomify-agent-activate.sh; exit $status'
  exit
fi

if ((rollback)); then
  # Uses this checkout's installer: an older release's copy may predate the root helper.
  scp scripts/install-agent-release.sh "$host:/tmp/tomify-install-agent-release.sh"
  ssh -t "$host" 'bash /tmp/tomify-install-agent-release.sh --rollback; status=$?; rm -f /tmp/tomify-install-agent-release.sh; exit $status'
  exit
fi

dirty=$(git status --porcelain -- recovery-agent shared)
[[ -z $dirty ]] || { echo 'deploy-agent.sh: commit or discard changes under recovery-agent/ and shared/ before deploying' >&2; echo "$dirty" >&2; exit 1; }

sha=$(git rev-parse --short HEAD)
archive="${TMPDIR:-/tmp}/tomify-agent-$sha.tar.gz"
remote_archive="/tmp/tomify-agent-$sha.tar.gz"
trap 'rm -f -- "$archive"' EXIT
tar -czf "$archive" recovery-agent shared package.json scripts/install-agent-release.sh
scp "$archive" "$host:$remote_archive"
ssh -t "$host" "bash -o pipefail -c 'tar -xOf $remote_archive scripts/install-agent-release.sh | bash -s -- --archive $remote_archive --sha $sha; status=\$?; rm -f $remote_archive; exit \$status'"

#!/usr/bin/env bash
# Deploy the TomTube service (tomtube-service/) to the media server as an immutable release under
# /opt/tomtube/releases/<sha>, switch /opt/tomtube/current to it, restart the `tomtube` unit and wait
# for its health check. If the new release does not come up healthy, the previous one is restored.
# The first deploy also installs and enables the systemd units shipped in the release. Setup before
# that (folders, yt-dlp, /etc/tomtube/tomtube.env) is in docs/TOMTUBE.md. The restart uses sudo; see
# the docs for a sudoers rule that allows exactly `systemctl restart tomtube` without a password.
set -euo pipefail

host=${TOMIFY_AGENT_HOST:-tom@tomify}
while (($#)); do
  case "$1" in
    --host) (($# >= 2)) || { echo 'deploy-tomtube.sh: --host requires a value' >&2; exit 2; }; host=$2; shift 2 ;;
    -h | --help) echo 'Usage: deploy-tomtube.sh [--host USER@HOST]'; exit 0 ;;
    *) echo "deploy-tomtube.sh: unknown option: $1" >&2; exit 2 ;;
  esac
done

repo=$(git rev-parse --show-toplevel 2>/dev/null) || { echo 'deploy-tomtube.sh: run this inside the Tomify checkout' >&2; exit 1; }
cd "$repo"
dirty=$(git status --porcelain -- tomtube-service)
[[ -z $dirty ]] || { echo 'deploy-tomtube.sh: commit or discard changes under tomtube-service/ first' >&2; echo "$dirty" >&2; exit 1; }

sha=$(git rev-parse --short HEAD)
archive="${TMPDIR:-/tmp}/tomtube-$sha.tar.gz"
trap 'rm -f -- "$archive"' EXIT
tar -czf "$archive" --exclude='*.node-test.mjs' --exclude='testing.mjs' tomtube-service
scp "$archive" "$host:/tmp/tomtube-$sha.tar.gz"

scp scripts/install-tomtube-release.sh "$host:/tmp/install-tomtube-release.sh"
ssh -t "$host" "bash /tmp/install-tomtube-release.sh $sha /tmp/tomtube-$sha.tar.gz; status=\$?; rm -f /tmp/install-tomtube-release.sh; exit \$status"

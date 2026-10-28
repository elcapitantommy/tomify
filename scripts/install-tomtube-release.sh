#!/usr/bin/env bash
# Installs a TomTube release on the media server; run by deploy-tomtube.sh over SSH as the deploying
# user (tom). Usage: install-tomtube-release.sh SHA ARCHIVE
set -euo pipefail
sha=${1:?sha}
archive=${2:?archive}
[[ $sha =~ ^[0-9a-f]{7,40}$ ]] || { echo 'install-tomtube-release.sh: bad sha' >&2; exit 2; }
release=/opt/tomtube/releases/$sha
trap 'rm -f -- "$archive"' EXIT
mkdir -p /opt/tomtube/releases
if [[ ! -d $release ]]; then
  staging=$(mktemp -d /opt/tomtube/releases/.staging.XXXXXX)
  tar -xzf "$archive" -C "$staging"
  printf '%s\n' "$sha" > "$staging/tomtube-service/VERSION"
  chmod -R a-w "$staging"
  mv "$staging" "$release"
fi
previous=$(readlink -f /opt/tomtube/current || true)
ln -sfn "$release" /opt/tomtube/current.new && mv -T /opt/tomtube/current.new /opt/tomtube/current
sudo systemctl restart tomtube
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8790/health 2>/dev/null | grep -q "\"version\":\"$sha\""; then
    echo "TomTube $sha is running"
    # Keep the five newest releases, and never the current or previous one.
    for old in $(ls -1dt /opt/tomtube/releases/*/ | tail -n +6); do
      old=${old%/}
      [[ $old == "$release" || $old == "$previous" ]] && continue
      chmod -R u+w "$old" && rm -rf -- "$old"
    done
    exit 0
  fi
  sleep 1
done
echo "TomTube $sha did not become healthy; restoring the previous release" >&2
journalctl -u tomtube -n 20 --no-pager >&2 || true
if [[ -n $previous && -d $previous ]]; then
  ln -sfn "$previous" /opt/tomtube/current.new && mv -T /opt/tomtube/current.new /opt/tomtube/current
  sudo systemctl restart tomtube
fi
exit 1

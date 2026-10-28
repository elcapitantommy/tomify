#!/usr/bin/env bash
# Installs a TomTube release on the media server; run by deploy-tomtube.sh over SSH as the deploying
# user (tom). Usage: install-tomtube-release.sh SHA ARCHIVE
set -euo pipefail
sha=${1:?sha}
archive=${2:?archive}
[[ $sha =~ ^[0-9a-f]{7,40}$ ]] || { echo 'install-tomtube-release.sh: bad sha' >&2; exit 2; }
release=/opt/tomtube/releases/$sha
units=/etc/systemd/system
trap 'rm -f -- "$archive"' EXIT

# The settings file has to exist before the first start (docs/TOMTUBE.md, step 4).
if [[ ! -r /etc/tomtube/tomtube.env ]]; then
  echo 'install-tomtube-release.sh: /etc/tomtube/tomtube.env is missing or unreadable; create it from tomtube-service/tomtube.env.example first (docs/TOMTUBE.md, step 4)' >&2
  exit 1
fi
[[ -x /opt/tomtube/bin/yt-dlp ]] || echo 'Note: /opt/tomtube/bin/yt-dlp is not installed yet; TomTube will start but cannot play anything until it is (docs/TOMTUBE.md, step 2).' >&2
mkdir -p /opt/tomtube/releases
if [[ ! -d $release ]]; then
  staging=$(mktemp -d /opt/tomtube/releases/.staging.XXXXXX)
  tar -xzf "$archive" -C "$staging"
  printf '%s\n' "$sha" > "$staging/tomtube-service/VERSION"
  chmod -R a-w "$staging"
  mv "$staging" "$release"
fi
previous=
[[ -L /opt/tomtube/current ]] && previous=$(readlink -f /opt/tomtube/current)
ln -sfn "$release" /opt/tomtube/current.new && mv -T /opt/tomtube/current.new /opt/tomtube/current

# First deploy: install and enable the service and the daily yt-dlp update timer from this release.
# Later deploys leave installed units alone (they may have been edited) and only say when the
# shipped copy has changed.
shipped=$release/tomtube-service
if [[ ! -f $units/tomtube.service ]]; then
  echo 'Installing the tomtube and tomtube-ytdlp-update units (first deploy)'
  sudo install -m 644 "$shipped/tomtube.service.example" "$units/tomtube.service"
  [[ -f $units/tomtube-ytdlp-update.service ]] || sudo install -m 644 "$shipped/tomtube-ytdlp-update.service.example" "$units/tomtube-ytdlp-update.service"
  [[ -f $units/tomtube-ytdlp-update.timer ]] || sudo install -m 644 "$shipped/tomtube-ytdlp-update.timer.example" "$units/tomtube-ytdlp-update.timer"
  sudo systemctl daemon-reload
  sudo systemctl enable tomtube
  sudo systemctl enable --now tomtube-ytdlp-update.timer
elif ! cmp -s "$shipped/tomtube.service.example" "$units/tomtube.service"; then
  echo "Note: $units/tomtube.service differs from this release's tomtube.service.example; compare them if the release changed the unit." >&2
fi
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

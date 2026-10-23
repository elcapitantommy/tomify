#!/usr/bin/env bash
# Installs Tomifin's Family importer on the media server (docs/TOMIFIN.md, "Family import"). Run as root from a
# deployed release:
#   sudo bash /opt/tomify/current/recovery-agent/family-import/install-family-import.sh install
#     creates the hidden folders, installs the hook and units, and runs a dry run. Nothing is switched on.
#   sudo bash /opt/tomify/current/recovery-agent/family-import/install-family-import.sh enable
#     sends new Family downloads to staging (restarting the agent) and starts the importer's path unit and timer.
# It never touches existing films, torrents, the Private library, qBittorrent's unit or Jellyfin.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
agent=/opt/tomify/current/recovery-agent
library=/media/family
env_file=/etc/tomify/recovery-agent.env
hook=/usr/local/lib/tomifin/tomifin-family-import-hook.sh
units=(tomifin-family-import.service tomifin-family-import.path tomifin-family-import-scan.service tomifin-family-import-scan.timer)

[[ $(id -u) -eq 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
[[ -f $agent/family-import.mjs ]] || { echo "$agent/family-import.mjs is missing: deploy the agent first." >&2; exit 1; }
mountpoint -q "$library" || { echo "$library is not mounted." >&2; exit 1; }
id qbittorrent >/dev/null && getent group media-family >/dev/null

dry_run() {
  systemd-run --quiet --wait --pipe --collect -p User=qbittorrent -p Group=qbittorrent -p SupplementaryGroups=media-family \
    -p EnvironmentFile="$env_file" -p Environment=TOMIFIN_IMPORT_LIBRARY="$library" -p Environment=TOMIFIN_IMPORT_MOVIES_SUBDIR=Movies \
    -p "UnsetEnvironment=TOMIFY_RECOVERY_TOKEN TOMIFY_YOUTUBE_COOKIES TOMIFY_SABNZBD_API_KEY TOMIFY_LAN_TLS_KEY TOMIFY_MEDIA_KEY" \
    -p StateDirectory=tomifin-import -p StateDirectoryMode=0700 \
    -p SystemCallFilter=@system-service -p SystemCallErrorNumber=EPERM -p Environment=UV_USE_IO_URING=0 -p NoNewPrivileges=yes \
    /usr/bin/node "$agent/family-import.mjs" --scan --dry-run
}

case ${1-} in
  install)
    command -v ffprobe >/dev/null || { echo 'ffprobe is missing: sudo apt install ffmpeg' >&2; exit 1; }
    [[ -d $library/Movies ]] || { echo "$library/Movies is missing." >&2; exit 1; }
    for folder in .downloads .downloads/.tomifin-import-queue .review .publishing; do
      [[ -d $library/$folder ]] || sudo -u qbittorrent -g media-family mkdir -m 2775 -- "$library/$folder"
    done
    for folder in .downloads .review .publishing; do
      [[ -e $library/$folder/.ignore ]] || sudo -u qbittorrent -g media-family touch -- "$library/$folder/.ignore"
    done
    install -D -m 0755 "$here/tomifin-family-import-hook.sh" "$hook"
    for unit in "${units[@]}"; do install -m 0644 "$here/$unit.example" "/etc/systemd/system/$unit"; done
    systemctl daemon-reload
    echo '--- qBittorrent can write to staging:'
    sudo -u qbittorrent -g media-family sh -c "t=\$(mktemp -p '$library/.downloads' .write-test.XXXXXX) && rm -f -- \"\$t\" && echo yes"
    echo '--- Dry run (nothing is written):'
    dry_run
    echo '--- Installed, not switched on. Next: set the qBittorrent hook, then run this script with "enable".'
    echo "    qBittorrent > Options > Downloads > Run external program on torrent finished:"
    echo "    $hook \"%I\" \"%L\""
    ;;
  enable)
    [[ -f /etc/systemd/system/tomifin-family-import.service ]] || { echo 'Run "install" first.' >&2; exit 1; }
    if ! grep -q '^TOMIFY_TOMIFIN_FAMILY_IMPORT_SUBDIR=' "$env_file"; then
      printf '\nTOMIFY_TOMIFIN_FAMILY_IMPORT_SUBDIR=.downloads\n' >> "$env_file"
    fi
    grep '^TOMIFY_TOMIFIN_FAMILY_IMPORT_SUBDIR=' "$env_file"
    systemctl restart tomify-recovery.service
    systemctl enable --now tomifin-family-import.path tomifin-family-import-scan.timer
    systemctl --no-pager status tomifin-family-import.path tomifin-family-import-scan.timer | grep -E 'Loaded|Active'
    ;;
  dry-run) dry_run ;;
  *) echo "Usage: $0 install | enable | dry-run" >&2; exit 2 ;;
esac

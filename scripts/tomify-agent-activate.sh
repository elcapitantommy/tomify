#!/usr/bin/env bash
# The only part of an agent deploy that needs root, installed once as
# /usr/local/sbin/tomify-agent-activate (root:root, 0755) by deploy-agent -Setup.
# It records the release's version, writes the systemd unit from the template
# below (never from a release archive) and restarts the service. Everything else
# (unpacking releases, swapping /opt/tomify/current) runs as the deploying user.
# Safe to allow in sudoers without a password: whatever arguments it is given,
# the service still runs as tom with the hardening below.
set -euo pipefail

fail() {
  echo "tomify-agent-activate: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage:
  tomify-agent-activate --version SHA|legacy
  tomify-agent-activate --clear-version

Test-only options (refused under sudo):
  --dry-run   Use systemctl from PATH.
  --root DIR  Filesystem root instead of /. Requires --dry-run.
EOF
}

version=''
clear=0
dry_run=0
root='/'
while (($#)); do
  case "$1" in
    --version) (($# >= 2)) || fail '--version requires a value'; version=$2; shift 2 ;;
    --clear-version) clear=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    --root) (($# >= 2)) || fail '--root requires a value'; root=$2; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; fail "unknown option: $1" ;;
  esac
done

if ((dry_run)); then
  [[ -z ${SUDO_USER:-} ]] || fail '--dry-run is for tests and is refused under sudo'
else
  [[ $EUID -eq 0 ]] || fail 'run this with sudo'
  [[ $root == / ]] || fail '--root requires --dry-run'
fi
[[ $root == /* ]] || fail '--root must be an absolute path'
root=${root%/}
if ((clear)); then
  [[ -z $version ]] || fail 'use either --version or --clear-version'
else
  [[ $version =~ ^([0-9a-fA-F]{7,40}|legacy)$ ]] || fail '--version must be a 7-40 character hexadecimal Git SHA (or legacy)'
fi

env_dir="$root/etc/tomify"
env_file="$env_dir/recovery-agent.env"
service_file="$root/etc/systemd/system/tomify-recovery.service"

# Root writes only into directories that root owns and nobody else can write, and
# never through a symlink, so the deploying user cannot redirect these writes.
safe_directory() {
  local directory=$1 owner mode
  [[ -d $directory && ! -L $directory ]] || fail "$directory must be a real directory"
  ((dry_run)) && return 0
  owner=$(stat -c %u -- "$directory")
  mode=$(stat -c %a -- "$directory")
  [[ $owner == 0 ]] || fail "$directory must be owned by root (sudo chown root:root $directory)"
  (( (8#$mode & 8#022) == 0 )) || fail "$directory must not be group- or world-writable (sudo chmod go-w $directory)"
}

safe_directory "$env_dir"
safe_directory "$(dirname -- "$service_file")"
[[ ! -L $env_file ]] || fail "$env_file must not be a symlink"
[[ ! -L $service_file ]] || fail "$service_file must not be a symlink"

# Rewrites TOMIFY_VERSION in the agent's env file, keeping every other line, owner and mode.
write_version() {
  local temp line found=0
  temp=$(mktemp -- "$env_dir/.recovery-agent.env.XXXXXX")
  if [[ -f $env_file ]]; then
    while IFS= read -r line || [[ -n $line ]]; do
      if [[ $line == TOMIFY_VERSION=* ]]; then
        if [[ -n $version && $found -eq 0 ]]; then printf 'TOMIFY_VERSION=%s\n' "$version" >> "$temp"; fi
        found=1
      else
        printf '%s\n' "$line" >> "$temp"
      fi
    done < "$env_file"
    chmod --reference="$env_file" -- "$temp"
    chown --reference="$env_file" -- "$temp"
  else
    chmod 600 -- "$temp"
  fi
  if [[ -n $version && $found -eq 0 ]]; then printf 'TOMIFY_VERSION=%s\n' "$version" >> "$temp"; fi
  mv -f -- "$temp" "$env_file"
}

write_unit() {
  local temp
  temp=$(mktemp -- "$(dirname -- "$service_file")/.tomify-recovery.service.XXXXXX")
  # Keep in step with recovery-agent/tomify-recovery.service.example (a test checks they match).
  cat > "$temp" <<'UNIT'
[Unit]
Description=Tomify recovery agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=tom
WorkingDirectory=/opt/tomify/current/recovery-agent
EnvironmentFile=/etc/tomify/recovery-agent.env
Environment=HOME=/var/lib/tomify-recovery
ExecStart=/usr/bin/node /opt/tomify/current/recovery-agent/index.mjs
Restart=on-failure
PrivateTmp=true
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/srv/music-recovery /var/lib/tomify-recovery /var/cache/tomify-recovery
ReadWritePaths=-/srv/usenet/completed -/srv/torrents
ReadOnlyPaths=/opt/tomify/secrets

[Install]
WantedBy=multi-user.target
UNIT
  chmod 0644 -- "$temp"
  mv -f -- "$temp" "$service_file"
}

if ((clear)); then version=''; fi
write_version
write_unit
systemctl daemon-reload
systemctl restart tomify-recovery
if [[ -n $version ]]; then echo "Activated Tomify recovery agent $version"; else echo 'Restarted Tomify recovery agent'; fi

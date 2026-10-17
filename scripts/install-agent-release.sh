#!/usr/bin/env bash
# Install or roll back an immutable Tomify recovery-agent release.
#
# On the media server this script is installed once, root-owned, at /usr/local/sbin/tomify-install-agent
# (deploy-agent --bootstrap), and sudoers lets the deploy user run only that path without a password. It must
# therefore never give that user a way to root: releases and their links live in a root-owned directory, the
# systemd unit comes from the template below (never from the uploaded archive), only regular files and
# directories are extracted, and the test-only options are refused when running as root.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  tomify-install-agent --archive /tmp/tomify-agent-SHA.tar.gz --sha SHA
  tomify-install-agent --rollback
  sudo bash install-agent-release.sh --bootstrap     (one-time setup, from deploy-agent --bootstrap)
  install-agent-release.sh ... --dry-run --root DIR   (tests only, never as root)

Options:
  --bootstrap     Install this script as /usr/local/sbin/tomify-install-agent and let the user who ran
                  sudo run it, and only it, without a password.
  --archive FILE  Release tarball produced by deploy-agent.ps1/.sh, uploaded to /tmp.
  --sha SHA       Git short SHA used as the release name and TOMIFY_VERSION.
  --rollback      Swap back to the previously deployed release.
  --dry-run       Test mode: permits --root and uses commands from PATH. Refused as root.
  --root DIR      Test-only filesystem root instead of /. Requires --dry-run.

Environment used by tests:
  TOMIFY_INSTALL_HEALTH_TIMEOUT  Health-check timeout in seconds (default 30).
EOF
}

fail() {
  echo "tomify-install-agent: $*" >&2
  exit 1
}

archive=''
sha=''
rollback=0
bootstrap=0
dry_run=0
root='/'
while (($#)); do
  case "$1" in
    --archive) (($# >= 2)) || fail '--archive requires a value'; archive=$2; shift 2 ;;
    --sha) (($# >= 2)) || fail '--sha requires a value'; sha=$2; shift 2 ;;
    --rollback) rollback=1; shift ;;
    --bootstrap) bootstrap=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    --root) (($# >= 2)) || fail '--root requires a value'; root=$2; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "tomify-install-agent: unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if ((dry_run)); then
  [[ $EUID -ne 0 ]] || fail '--dry-run and --root are for tests and are refused as root'
else
  [[ $EUID -eq 0 ]] || fail 'run this installer with sudo'
  [[ $root == / ]] || fail '--root is available only with --dry-run'
fi
[[ $root == /* ]] || fail '--root must be an absolute path'
root=${root%/}

path_under_root() {
  if [[ -n $root ]]; then printf '%s%s\n' "$root" "$1"; else printf '%s\n' "$1"; fi
}

# One-time setup, run with the user's own password. Installs a root-owned copy of this script and a sudoers rule
# for exactly that path. The installed copy refuses to bootstrap, so the password-free rule cannot widen itself.
if ((bootstrap)); then
  installed=$(path_under_root /usr/local/sbin/tomify-install-agent)
  sudoers=$(path_under_root /etc/sudoers.d/tomify-deploy)
  self=$(readlink -f -- "${BASH_SOURCE[0]}")
  [[ $self != "$(readlink -f -- "$installed" 2>/dev/null || true)" ]] || fail '--bootstrap must be run from a fresh copy of the script, not the installed one'
  user=${SUDO_USER:-}
  [[ -n $user && $user != root && $user =~ ^[a-z_][a-z0-9_-]*$ ]] || fail '--bootstrap must be run through sudo by the deploy user'
  rule=$(mktemp)
  trap 'rm -f -- "$rule"' EXIT
  printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/tomify-install-agent\n' "$user" > "$rule"
  if ((!dry_run)); then visudo -cqf "$rule" || fail 'the generated sudoers rule did not validate'; fi
  mkdir -p -- "$(dirname -- "$installed")" "$(dirname -- "$sudoers")"
  if ((dry_run)); then
    install -m 0755 -- "$self" "$installed"
    install -m 0440 -- "$rule" "$sudoers"
  else
    install -o root -g root -m 0755 -- "$self" "$installed"
    install -o root -g root -m 0440 -- "$rule" "$sudoers"
  fi
  echo "Bootstrapped: $user can run /usr/local/sbin/tomify-install-agent without a password"
  exit 0
fi

# Everything the installer writes as root sits in root-owned directories, never under /opt/tomify, which belongs
# to the deploy user.
agent_home=$(path_under_root /usr/local/lib/tomify-agent)
release_root="$agent_home/releases"
current_link="$agent_home/current"
previous_link="$agent_home/previous"
env_file=$(path_under_root /etc/tomify/recovery-agent.env)
service_file=$(path_under_root /etc/systemd/system/tomify-recovery.service)
health_timeout=${TOMIFY_INSTALL_HEALTH_TIMEOUT:-30}
[[ $health_timeout =~ ^[0-9]+$ ]] || fail 'TOMIFY_INSTALL_HEALTH_TIMEOUT must be a non-negative whole number'

# The unit always runs the agent as tom, whatever the archive contains. Keep it identical to
# recovery-agent/tomify-recovery.service.example; a test checks they match.
service_unit() {
  cat <<'EOF'
[Unit]
Description=Tomify recovery agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=tom
WorkingDirectory=/usr/local/lib/tomify-agent/current/recovery-agent
EnvironmentFile=/etc/tomify/recovery-agent.env
Environment=HOME=/var/lib/tomify-recovery
ExecStart=/usr/bin/node /usr/local/lib/tomify-agent/current/recovery-agent/index.mjs
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
EOF
}

atomic_link() {
  local target=$1 link=$2 temp
  temp=$(mktemp -u "${link}.new.XXXXXX")
  ln -s -- "$target" "$temp"
  mv -Tf -- "$temp" "$link"
}

link_target() {
  [[ -L $1 ]] || return 1
  readlink -f -- "$1"
}

version_from_release() {
  basename -- "$1"
}

# Sets TOMIFY_VERSION (or removes it when given an empty version) through a new temporary file in the same
# root-owned directory, keeping every other line, the owner and the mode.
rewrite_env() {
  local version=$1 temp found=0 line
  mkdir -p -- "$(dirname -- "$env_file")"
  temp=$(mktemp "${env_file}.new.XXXXXX")
  if [[ -f $env_file ]]; then
    while IFS= read -r line || [[ -n $line ]]; do
      if [[ $line == TOMIFY_VERSION=* ]]; then
        if [[ -n $version && $found -eq 0 ]]; then printf 'TOMIFY_VERSION=%s\n' "$version" >> "$temp"; found=1; fi
      else
        printf '%s\n' "$line" >> "$temp"
      fi
    done < "$env_file"
    chmod --reference="$env_file" "$temp"
    chown --reference="$env_file" "$temp"
  else
    chmod 600 "$temp"
  fi
  [[ -z $version || $found -eq 1 ]] || printf 'TOMIFY_VERSION=%s\n' "$version" >> "$temp"
  mv -f -- "$temp" "$env_file"
}

install_service_unit() {
  local temp
  mkdir -p -- "$(dirname -- "$service_file")"
  temp=$(mktemp "${service_file}.new.XXXXXX")
  service_unit > "$temp"
  chmod 0644 "$temp"
  mv -f -- "$temp" "$service_file"
}

restart_service() {
  systemctl daemon-reload
  systemctl restart tomify-recovery
}

healthy() {
  local wanted=$1 started now response
  started=$(date +%s)
  while :; do
    response=$(curl -fsS http://127.0.0.1:8788/health 2>/dev/null || true)
    if grep -Eq '"version"[[:space:]]*:[[:space:]]*"'"$wanted"'"' <<<"$response"; then
      return 0
    fi
    now=$(date +%s)
    ((now - started < health_timeout)) || return 1
    sleep 1
  done
}

restore_links_and_version() {
  local old_current=${1:-} old_previous=${2:-} old_version=${3:-}
  if [[ -n $old_current ]]; then atomic_link "$old_current" "$current_link"; else rm -f -- "$current_link"; fi
  if [[ -n $old_previous ]]; then atomic_link "$old_previous" "$previous_link"; else rm -f -- "$previous_link"; fi
  rewrite_env "$old_version"
}

mkdir -p -- "$release_root"
if ((!dry_run)); then
  chown root:root "$agent_home" "$release_root"
  chmod 0755 "$agent_home" "$release_root"
fi

if ((rollback)); then
  current_target=$(link_target "$current_link" || true)
  previous_target=$(link_target "$previous_link" || true)
  [[ -n $current_target ]] || fail "'$current_link' does not point to a deployed release"
  [[ -n $previous_target && -d $previous_target ]] || fail 'no previous release is available to roll back to'
  [[ $(dirname -- "$previous_target") == "$(readlink -f -- "$release_root")" ]] || fail 'the previous release is not in the release directory'
  old_version=$(version_from_release "$current_target")
  rollback_version=$(version_from_release "$previous_target")

  atomic_link "$previous_target" "$current_link"
  atomic_link "$current_target" "$previous_link"
  rewrite_env "$rollback_version"
  restart_service
  if ! healthy "$rollback_version"; then
    restore_links_and_version "$current_target" "$previous_target" "$old_version"
    restart_service || true
    fail "rolled back rollback attempt because release '$rollback_version' did not become healthy"
  fi
  echo "Rolled back Tomify recovery agent to $rollback_version"
  exit 0
fi

[[ $sha =~ ^[0-9a-fA-F]{7,40}$ ]] || fail '--sha must be a 7-40 character hexadecimal Git SHA'
if ((!dry_run)); then
  [[ $archive == "/tmp/tomify-agent-$sha.tar.gz" ]] || fail "--archive must be /tmp/tomify-agent-$sha.tar.gz"
fi
[[ -f $archive && ! -L $archive ]] || fail '--archive must name an existing regular file'
release_dir="$release_root/$sha"

# Work on a private copy, so the uploaded file cannot change between being checked and being extracted.
work=$(mktemp -d "$release_root/.${sha}.new.XXXXXX")
trap 'rm -rf -- "$work"' EXIT
cp -- "$archive" "$work/release.tar.gz"
staging="$work/release"
mkdir -- "$staging"

# Only regular files and directories inside the deliberately small release payload: no links, devices,
# absolute paths or traversal.
while IFS= read -r entry; do
  [[ -n $entry ]] || continue
  [[ ${entry:0:1} == '-' || ${entry:0:1} == 'd' ]] || fail "archive member is not a regular file or directory: $entry"
done < <(tar -tvzf "$work/release.tar.gz")
while IFS= read -r member; do
  [[ -n $member ]] || continue
  [[ $member != /* && $member != ../* && $member != */../* && $member != */.. ]] || fail "unsafe archive member: $member"
  case "$member" in
    recovery-agent | recovery-agent/* | shared | shared/* | scripts | scripts/ | scripts/install-agent-release.sh | package.json) ;;
    *) fail "unexpected archive member: $member" ;;
  esac
done < <(tar -tzf "$work/release.tar.gz")

tar -xzf "$work/release.tar.gz" -C "$staging" --no-same-owner --no-same-permissions
[[ -f $staging/recovery-agent/index.mjs ]] || fail 'archive is missing recovery-agent/index.mjs'
[[ -f $staging/shared/quality.mjs ]] || fail 'archive is missing shared/quality.mjs'
chmod -R u=rwX,go=rX "$staging"

if [[ ! -e $release_dir ]]; then mv -- "$staging" "$release_dir"; fi
rm -rf -- "$work"
trap - EXIT

old_current=$(link_target "$current_link" || true)
old_previous=$(link_target "$previous_link" || true)
old_version=''
if [[ -f $env_file ]]; then
  old_version=$(sed -n 's/^TOMIFY_VERSION=//p' "$env_file" | head -n 1)
fi

# The first deploy into this directory replaces a unit that still runs an older layout; keep it so a failed
# health check can put it back.
old_unit=$(mktemp "$agent_home/.previous-unit.XXXXXX")
trap 'rm -f -- "$old_unit"' EXIT
had_unit=0
if [[ -f $service_file ]]; then cp -- "$service_file" "$old_unit"; had_unit=1; fi

if [[ -n $old_current && $old_current != "$release_dir" ]]; then atomic_link "$old_current" "$previous_link"; fi
atomic_link "$release_dir" "$current_link"
rewrite_env "$sha"
install_service_unit
restart_service

if ! healthy "$sha"; then
  restore_links_and_version "$old_current" "$old_previous" "$old_version"
  if ((had_unit)); then install -m 0644 -- "$old_unit" "$service_file"; fi
  restart_service || true
  fail "release '$sha' did not become healthy within ${health_timeout}s; restored the previous release"
fi
rm -f -- "$old_unit"
trap - EXIT

# Keep the five newest immutable releases. Never prune either rollback target.
mapfile -t releases < <(find "$release_root" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf '%T@ %p\n' | sort -nr | cut -d' ' -f2-)
kept=0
for candidate in "${releases[@]}"; do
  if [[ $candidate == "$release_dir" || $candidate == "$(link_target "$previous_link" || true)" ]]; then
    ((kept += 1))
  elif ((kept < 5)); then
    ((kept += 1))
  else
    rm -rf -- "$candidate"
  fi
done

echo "Deployed Tomify recovery agent $sha"

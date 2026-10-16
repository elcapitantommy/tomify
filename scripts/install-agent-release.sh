#!/usr/bin/env bash
# Install or roll back an immutable Tomify recovery-agent release.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  install-agent-release.sh --archive FILE --sha SHA [--dry-run] [--root DIR]
  install-agent-release.sh --rollback [--dry-run] [--root DIR]

Options:
  --archive FILE  Release tarball produced by deploy-agent.ps1/.sh.
  --sha SHA       Git short SHA used as the release name and TOMIFY_VERSION.
  --rollback      Swap back to the previously deployed release.
  --dry-run       Test mode: permits --root and uses commands from PATH.
  --root DIR      Test-only filesystem root instead of /. Requires --dry-run.

Environment used by tests:
  TOMIFY_INSTALL_HEALTH_TIMEOUT  Health-check timeout in seconds (default 30).
EOF
}

fail() {
  echo "install-agent-release.sh: $*" >&2
  exit 1
}

archive=''
sha=''
rollback=0
dry_run=0
root='/'
while (($#)); do
  case "$1" in
    --archive) (($# >= 2)) || fail '--archive requires a value'; archive=$2; shift 2 ;;
    --sha) (($# >= 2)) || fail '--sha requires a value'; sha=$2; shift 2 ;;
    --rollback) rollback=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    --root) (($# >= 2)) || fail '--root requires a value'; root=$2; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "install-agent-release.sh: unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ $EUID -eq 0 || $dry_run -eq 1 ]] || fail 'run this installer with sudo'
[[ $root == / || $dry_run -eq 1 ]] || fail '--root is available only with --dry-run'
[[ $root == /* ]] || fail '--root must be an absolute path'
root=${root%/}

path_under_root() {
  if [[ -n $root ]]; then printf '%s%s\n' "$root" "$1"; else printf '%s\n' "$1"; fi
}

opt_root=$(path_under_root /opt/tomify)
release_root="$opt_root/releases"
current_link="$opt_root/current"
previous_link="$opt_root/previous"
env_file=$(path_under_root /etc/tomify/recovery-agent.env)
service_file=$(path_under_root /etc/systemd/system/tomify-recovery.service)
health_timeout=${TOMIFY_INSTALL_HEALTH_TIMEOUT:-30}
[[ $health_timeout =~ ^[0-9]+$ ]] || fail 'TOMIFY_INSTALL_HEALTH_TIMEOUT must be a non-negative whole number'

atomic_link() {
  local target=$1 link=$2 temp
  temp="${link}.new.$$"
  rm -f -- "$temp"
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

set_version() {
  local version=$1 temp found=0 line
  mkdir -p -- "$(dirname -- "$env_file")"
  temp="${env_file}.new.$$"
  : > "$temp"
  if [[ -f $env_file ]]; then
    while IFS= read -r line || [[ -n $line ]]; do
      if [[ $line == TOMIFY_VERSION=* ]]; then
        if ((found == 0)); then printf 'TOMIFY_VERSION=%s\n' "$version" >> "$temp"; found=1; fi
      else
        printf '%s\n' "$line" >> "$temp"
      fi
    done < "$env_file"
    chmod --reference="$env_file" "$temp"
    chown --reference="$env_file" "$temp"
  else
    chmod 600 "$temp"
  fi
  ((found == 1)) || printf 'TOMIFY_VERSION=%s\n' "$version" >> "$temp"
  mv -f -- "$temp" "$env_file"
}

clear_version() {
  local temp line
  [[ -f $env_file ]] || return 0
  temp="${env_file}.new.$$"
  : > "$temp"
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line == TOMIFY_VERSION=* ]] || printf '%s\n' "$line" >> "$temp"
  done < "$env_file"
  chmod --reference="$env_file" "$temp"
  chown --reference="$env_file" "$temp"
  mv -f -- "$temp" "$env_file"
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
  if [[ -n $old_version ]]; then set_version "$old_version"; else clear_version; fi
}

mkdir -p -- "$opt_root" "$release_root"

if ((rollback)); then
  current_target=$(link_target "$current_link" || true)
  previous_target=$(link_target "$previous_link" || true)
  [[ -n $current_target ]] || fail "'$current_link' does not point to a deployed release"
  [[ -n $previous_target && -d $previous_target ]] || fail 'no previous release is available to roll back to'
  old_version=$(version_from_release "$current_target")
  rollback_version=$(version_from_release "$previous_target")

  atomic_link "$previous_target" "$current_link"
  atomic_link "$current_target" "$previous_link"
  set_version "$rollback_version"
  restart_service
  if ! healthy "$rollback_version"; then
    restore_links_and_version "$current_target" "$previous_target" "$old_version"
    restart_service || true
    fail "rolled back rollback attempt because release '$rollback_version' did not become healthy"
  fi
  echo "Rolled back Tomify recovery agent to $rollback_version"
  exit 0
fi

[[ -n $archive && -f $archive ]] || fail '--archive must name an existing release tarball'
[[ $sha =~ ^[0-9a-fA-F]{7,40}$ ]] || fail '--sha must be a 7-40 character hexadecimal Git SHA'
release_dir="$release_root/$sha"

# Root is extracting a local archive, so reject absolute/traversing members and
# everything outside the deliberately small release payload.
while IFS= read -r member; do
  [[ -n $member ]] || continue
  [[ $member != /* && $member != ../* && $member != */../* && $member != */.. ]] || fail "unsafe archive member: $member"
  case "$member" in
    recovery-agent | recovery-agent/* | shared | shared/* | scripts | scripts/ | scripts/install-agent-release.sh | package.json) ;;
    *) fail "unexpected archive member: $member" ;;
  esac
done < <(tar -tzf "$archive")

staging="$release_root/.${sha}.new.$$"
rm -rf -- "$staging"
mkdir -p -- "$staging"
trap 'rm -rf -- "$staging"' EXIT
tar -xzf "$archive" -C "$staging"
[[ -f $staging/recovery-agent/index.mjs ]] || fail 'archive is missing recovery-agent/index.mjs'
[[ -f $staging/shared/quality.mjs ]] || fail 'archive is missing shared/quality.mjs'
[[ -f $staging/scripts/install-agent-release.sh ]] || fail 'archive is missing scripts/install-agent-release.sh'
chmod 755 "$staging/scripts/install-agent-release.sh"

if [[ -e $release_dir ]]; then
  rm -rf -- "$staging"
else
  mv -- "$staging" "$release_dir"
fi
trap - EXIT

# First deployment from the old mutable layout: preserve it as a rollback
# release before switching the service to /opt/tomify/current.
if [[ ! -L $current_link && -f $opt_root/recovery-agent/index.mjs ]]; then
  legacy_dir="$release_root/legacy"
  if [[ ! -e $legacy_dir ]]; then
    mkdir -p "$legacy_dir"
    cp -a "$opt_root/recovery-agent" "$legacy_dir/recovery-agent"
    [[ ! -d $opt_root/shared ]] || cp -a "$opt_root/shared" "$legacy_dir/shared"
    mkdir -p "$legacy_dir/scripts"
    cp "$release_dir/scripts/install-agent-release.sh" "$legacy_dir/scripts/install-agent-release.sh"
    chmod 755 "$legacy_dir/scripts/install-agent-release.sh"
  fi
  atomic_link "$legacy_dir" "$current_link"
fi

old_current=$(link_target "$current_link" || true)
old_previous=$(link_target "$previous_link" || true)
old_version=''
if [[ -f $env_file ]]; then
  old_version=$(sed -n 's/^TOMIFY_VERSION=//p' "$env_file" | head -n 1)
fi

if [[ -n $old_current && $old_current != "$release_dir" ]]; then atomic_link "$old_current" "$previous_link"; fi
atomic_link "$release_dir" "$current_link"
set_version "$sha"
mkdir -p -- "$(dirname -- "$service_file")"
install -m 0644 "$release_dir/recovery-agent/tomify-recovery.service.example" "$service_file"
restart_service

if ! healthy "$sha"; then
  restore_links_and_version "$old_current" "$old_previous" "$old_version"
  restart_service || true
  fail "release '$sha' did not become healthy within ${health_timeout}s; restored the previous release"
fi

# Keep the five newest immutable releases. Never prune either rollback target.
mapfile -t releases < <(find "$release_root" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -nr | cut -d' ' -f2-)
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

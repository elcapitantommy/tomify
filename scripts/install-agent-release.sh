#!/usr/bin/env bash
# Install or roll back an immutable Tomify recovery-agent release.
# Runs as the user who owns /opt/tomify (tom), not root. The only root step,
# recording the version and restarting the service, goes through the fixed
# helper /usr/local/sbin/tomify-agent-activate (scripts/tomify-agent-activate.sh).
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
  --dry-run       Test mode: permits --root and uses commands (including
                  tomify-agent-activate) from PATH.
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
activate_helper=/usr/local/sbin/tomify-agent-activate
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

# Records the version (or clears it, given '') and restarts the service, through the root helper.
activate() {
  local version=$1 args
  if [[ -n $version ]]; then args=(--version "$version"); else args=(--clear-version); fi
  if ((dry_run)); then
    tomify-agent-activate "${args[@]}"
  else
    [[ -x $activate_helper ]] || fail "$activate_helper is not installed; run deploy-agent with -Setup (--setup) once"
    if [[ $EUID -eq 0 ]]; then "$activate_helper" "${args[@]}"; else sudo "$activate_helper" "${args[@]}"; fi
  fi
}

# The version a release directory deploys as: its name (a Git SHA, or legacy), otherwise none.
release_version() {
  local name
  [[ -n ${1:-} ]] || return 0
  name=$(basename -- "$1")
  if [[ $name =~ ^([0-9a-fA-F]{7,40}|legacy)$ ]]; then printf '%s\n' "$name"; fi
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
  local old_current=${1:-} old_previous=${2:-}
  if [[ -n $old_current ]]; then atomic_link "$old_current" "$current_link"; else rm -f -- "$current_link"; fi
  if [[ -n $old_previous ]]; then atomic_link "$old_previous" "$previous_link"; else rm -f -- "$previous_link"; fi
  activate "$(release_version "$old_current")" || true
}

if ((dry_run == 0)); then
  [[ -x $activate_helper ]] || fail "$activate_helper is not installed; run deploy-agent once with -Setup (PowerShell) or --setup (shell)"
  [[ -w $opt_root && ( ! -e $release_root || -w $release_root ) ]] || fail "$opt_root must be owned by the deploying user; run deploy-agent once with -Setup (PowerShell) or --setup (shell)"
fi
mkdir -p -- "$opt_root" "$release_root"

if ((rollback)); then
  current_target=$(link_target "$current_link" || true)
  previous_target=$(link_target "$previous_link" || true)
  [[ -n $current_target ]] || fail "'$current_link' does not point to a deployed release"
  [[ -n $previous_target && -d $previous_target ]] || fail 'no previous release is available to roll back to'
  rollback_version=$(version_from_release "$previous_target")

  atomic_link "$previous_target" "$current_link"
  atomic_link "$current_target" "$previous_link"
  activate "$(release_version "$previous_target")"
  if ! healthy "$rollback_version"; then
    restore_links_and_version "$current_target" "$previous_target"
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

if [[ -n $old_current && $old_current != "$release_dir" ]]; then atomic_link "$old_current" "$previous_link"; fi
atomic_link "$release_dir" "$current_link"
activate "$sha"

if ! healthy "$sha"; then
  restore_links_and_version "$old_current" "$old_previous"
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

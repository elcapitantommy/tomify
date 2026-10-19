#!/usr/bin/env bash
# Nightly Tomify backup for the Debian media server: a remote D1 export plus a tar.gz of
# the recovery agent's state directory, keeping the newest BACKUP_KEEP of each.
# Setup and restore steps: docs/DEPLOYMENT.md#backups-and-uptime-checks
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: backup.sh [--dry-run]

  --dry-run  Check wrangler's login and print what would be written and deleted,
             without exporting, archiving or deleting anything.

Environment:
  BACKUP_DIR                  where backups go (default /var/backups/tomify)
  BACKUP_KEEP                 how many of each backup to keep (default 14)
  TOMIFY_RECOVERY_STATE_DIR   agent state to archive (default /var/lib/tomify-recovery)
  TOMIFY_D1_DATABASE          D1 database name (default tomify-metadata)
  WRANGLER                    wrangler command (default wrangler, e.g. "npx --yes wrangler@4")
  CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
                              optional; used by wrangler instead of `wrangler login`
EOF
}

fail() {
  echo "backup.sh: $*" >&2
  exit 1
}

dry_run=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "backup.sh: unknown option: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

backup_dir="${BACKUP_DIR:-/var/backups/tomify}"
keep="${BACKUP_KEEP:-14}"
state_dir="${TOMIFY_RECOVERY_STATE_DIR:-/var/lib/tomify-recovery}"
database="${TOMIFY_D1_DATABASE:-tomify-metadata}"
read -r -a wrangler <<<"${WRANGLER:-wrangler}"

[[ "$keep" =~ ^[1-9][0-9]*$ ]] || fail "BACKUP_KEEP must be a positive whole number, got '$keep'."
[[ ${#wrangler[@]} -gt 0 ]] || fail "WRANGLER is empty."
command -v "${wrangler[0]}" >/dev/null || fail "'${wrangler[0]}' was not found on PATH. Install wrangler (docs/RECOVERY.md, Backups) or set WRANGLER."
command -v tar >/dev/null || fail "tar was not found on PATH."
[[ -d "$state_dir" && -r "$state_dir" ]] || fail "agent state directory '$state_dir' does not exist or is not readable. Set TOMIFY_RECOVERY_STATE_DIR."

# whoami's output names the account, so it is checked but never printed.
if ! whoami_output="$("${wrangler[@]}" whoami 2>&1)" || grep -qiE 'not (authenticated|logged in)' <<<"$whoami_output"; then
  fail "wrangler is not logged in as $(id -un). Run 'wrangler login' as that user, or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in /etc/tomify/backup.env."
fi

stamp="$(date -u +%Y-%m-%dT%H%M%SZ)"
d1_file="$backup_dir/tomify-d1-$stamp.sql"
state_file="$backup_dir/tomify-agent-state-$stamp.tar.gz"
d1_command=("${wrangler[@]}" d1 export "$database" --remote --output "$d1_file.partial")
tar_command=(tar -czf "$state_file.partial" -C "$(dirname "$state_dir")" "$(basename "$state_dir")")

# Deletes all but the newest $keep backups named <prefix>*<suffix>, counting a planned new one.
prune() {
  local prefix=$1 suffix=$2 planned=$3 name excess
  local -a names=()
  mapfile -t names < <({ find "$backup_dir" -maxdepth 1 -type f -name "$prefix*$suffix" -printf '%f\n' 2>/dev/null || true; [[ -z "$planned" ]] || echo "$planned"; } | LC_ALL=C sort -u)
  excess=$((${#names[@]} - keep))
  ((excess > 0)) || return 0
  for name in "${names[@]:0:excess}"; do
    if ((dry_run)); then
      echo "[dry-run] would delete $backup_dir/$name"
    else
      rm -f -- "${backup_dir:?}/$name"
      echo "Deleted old backup $backup_dir/$name"
    fi
  done
}

if ((dry_run)); then
  echo "[dry-run] would run: ${d1_command[*]}"
  echo "[dry-run] would write: $d1_file"
  echo "[dry-run] would run: ${tar_command[*]}"
  echo "[dry-run] would write: $state_file"
  prune tomify-d1- .sql "$(basename "$d1_file")"
  prune tomify-agent-state- .tar.gz "$(basename "$state_file")"
  exit 0
fi

umask 077
mkdir -p "$backup_dir"
trap 'rm -f -- "$d1_file.partial" "$state_file.partial"' EXIT

echo "Exporting D1 database $database"
"${d1_command[@]}" >/dev/null || fail "wrangler d1 export failed; see the message above."
[[ -s "$d1_file.partial" ]] || fail "wrangler d1 export wrote an empty file."
mv -- "$d1_file.partial" "$d1_file"
echo "Wrote $d1_file"

echo "Archiving $state_dir"
tar_status=0
"${tar_command[@]}" || tar_status=$?
# GNU tar exits 1 when a file changed while it was read; the agent may be writing state.
if ((tar_status == 1)); then
  echo "backup.sh: warning: some agent state changed while it was archived." >&2
elif ((tar_status != 0)); then
  fail "tar failed with status $tar_status."
fi
mv -- "$state_file.partial" "$state_file"
echo "Wrote $state_file"

prune tomify-d1- .sql ''
prune tomify-agent-state- .tar.gz ''

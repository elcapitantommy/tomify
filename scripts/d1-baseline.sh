#!/usr/bin/env bash
# One-off: tells wrangler that the D1 database built by the Worker's old request-time DDL already has
# the schema of drizzle/0001-0011, so `wrangler d1 migrations apply` only runs 0012 and later.
# It backs the database up first (scripts/backup.sh), creates d1_migrations exactly as wrangler does
# and records 0001-0011 in it. Running it again changes nothing. Deploy order: docs/RECOVERY.md#d1-migrations
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: d1-baseline.sh (--remote | --local) [--dry-run]

  --remote   Baseline the production D1 database. Runs scripts/backup.sh first.
  --local    Baseline wrangler's local copy (.wrangler/state). No backup is taken.
  --dry-run  Check the database and print the SQL it would run and the migrations that would
             then be pending, without changing anything (backup.sh runs with --dry-run too).

Environment:
  TOMIFY_D1_DATABASE  D1 database name (default tomify-metadata)
  WRANGLER            wrangler command (default wrangler, e.g. "npx --yes wrangler@4")
  backup.sh reads BACKUP_DIR, TOMIFY_RECOVERY_STATE_DIR and the rest; see backup.sh --help.
EOF
}

fail() {
  echo "d1-baseline.sh: $*" >&2
  exit 1
}

target=''
dry_run=0
for arg in "$@"; do
  case "$arg" in
    --remote | --local)
      [[ -z "$target" || "$target" == "$arg" ]] || fail "choose one of --remote and --local."
      target=$arg ;;
    --dry-run) dry_run=1 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "d1-baseline.sh: unknown option: $arg" >&2; usage >&2; exit 2 ;;
  esac
done
[[ -n "$target" ]] || { echo "d1-baseline.sh: choose --remote or --local." >&2; usage >&2; exit 2; }

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
database="${TOMIFY_D1_DATABASE:-tomify-metadata}"
read -r -a wrangler <<<"${WRANGLER:-wrangler}"
[[ ${#wrangler[@]} -gt 0 ]] || fail "WRANGLER is empty."
command -v "${wrangler[0]}" >/dev/null || fail "'${wrangler[0]}' was not found on PATH. Install wrangler or set WRANGLER."
command -v node >/dev/null || fail "node was not found on PATH."
# wrangler finds wrangler.toml, migrations_dir and the local state from the repository root.
cd "$root"

# The migrations whose schema the runtime DDL already built. 0012 onwards are applied by wrangler.
mapfile -t baseline < <(find drizzle -maxdepth 1 -type f -name '00*.sql' -printf '%f\n' | LC_ALL=C sort | awk -F_ '$1 + 0 >= 1 && $1 + 0 <= 11')
[[ ${#baseline[@]} -eq 11 ]] || fail "expected 11 migrations numbered 0001-0011 in drizzle/, found ${#baseline[@]}."
mapfile -t migrations < <(find drizzle -maxdepth 1 -type f -name '*.sql' -printf '%f\n' | LC_ALL=C sort)

if [[ "$target" == --remote ]]; then
  backup=(bash "$root/scripts/backup.sh")
  ((dry_run)) && backup+=(--dry-run)
  echo "Backing up first: ${backup[*]}"
  "${backup[@]}" || fail "backup.sh failed, so nothing was changed. Fix the backup and run this again."
else
  echo "Local database: no backup is taken."
fi

# Prints one column of the first result set of a query, one value per line.
query() {
  local output
  output="$("${wrangler[@]}" d1 execute "$database" "$target" --json --command "$1")" || fail "wrangler d1 execute failed for: $1"
  node -e '
    const [result] = JSON.parse(require("fs").readFileSync(0, "utf8"))
    if (!result || result.success === false) process.exit(1)
    for (const row of result.results || []) console.log(row[process.argv[1]])
  ' "$2" <<<"$output" || fail "could not read wrangler's JSON output for: $1"
}

has() {
  local wanted=$1 value
  shift
  for value in "$@"; do [[ "$value" == "$wanted" ]] && return 0; done
  return 1
}

mapfile -t tables < <(query "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name" name)
has recovery_items "${tables[@]}" || has release_metadata "${tables[@]}" \
  || fail "$database ($target) has no Tomify tables, so it was not built by the old Worker. Apply every migration instead: wrangler d1 migrations apply $database $target"

# 0002, 0003, 0004 and 0011 add these columns. The runtime DDL always added all four together, so a
# recovery_items table without one of them was not built by it and must not be baselined.
if has recovery_items "${tables[@]}"; then
  mapfile -t columns < <(query "PRAGMA table_info(recovery_items)" name)
  for column in metadata_resolution_json artwork_resolution_json source_json playback_json; do
    has "$column" "${columns[@]}" || fail "recovery_items has no $column column, which 0001-0011 would have added. Nothing was changed; check the database before baselining."
  done
fi

applied=()
if has d1_migrations "${tables[@]}"; then
  mapfile -t applied < <(query "SELECT name FROM d1_migrations ORDER BY id" name)
fi

record=()
for name in "${baseline[@]}"; do has "$name" "${applied[@]}" || record+=("$name"); done
pending=()
for name in "${migrations[@]}"; do has "$name" "${applied[@]}" "${baseline[@]}" || pending+=("$name"); done

print_pending() {
  if ((${#pending[@]})); then printf '%s\n' "$1 ${pending[*]}"; else echo "$1 none"; fi
}

if ((${#record[@]} == 0)); then
  echo "$database ($target) is already baselined: 0001-0011 are recorded in d1_migrations."
  print_pending "Pending migrations:"
  exit 0
fi

# The CREATE TABLE is wrangler's own (getCreateMigrationsTableQuery), and each row is what wrangler
# inserts after applying a file: just its file name. INSERT OR IGNORE keeps a re-run harmless.
sql="CREATE TABLE IF NOT EXISTS \"d1_migrations\"(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);"
for name in "${record[@]}"; do sql+=$'\n'"INSERT OR IGNORE INTO \"d1_migrations\" (name) VALUES ('${name//\'/\'\'}');"; done

if ((dry_run)); then
  echo "[dry-run] would run against $database ($target):"
  echo "$sql"
  print_pending "[dry-run] pending migrations afterwards:"
  exit 0
fi

echo "Recording ${#record[@]} migrations as applied in $database ($target)"
"${wrangler[@]}" d1 execute "$database" "$target" --yes --command "$sql" >/dev/null || fail "wrangler d1 execute failed; see the message above."
print_pending "Done. Pending migrations:"
"${wrangler[@]}" d1 migrations list "$database" "$target"

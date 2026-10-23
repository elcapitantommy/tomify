#!/bin/sh
# qBittorrent's "Run external program on torrent finished" hook for Tomifin's Family importer:
#   /usr/local/lib/tomifin/tomifin-family-import-hook.sh "%I" "%L"
# It only queues the torrent's info hash; the importer (tomifin-family-import.service, started by
# tomifin-family-import.path) does the work outside qBittorrent. Both arguments come from the torrent and are
# untrusted: the category must be exactly tomifin-family and the hash 40 or 64 lowercase hex characters, and nothing
# else is used. It never fails the torrent: every problem just exits quietly.
set -u
hash=${1-}
category=${2-}
[ "$category" = "tomifin-family" ] || exit 0
case $hash in
  *[!0-9a-f]*|'') exit 0 ;;
esac
[ ${#hash} -eq 40 ] || [ ${#hash} -eq 64 ] || exit 0
queue=${TOMIFIN_IMPORT_QUEUE:-/media/family/.downloads/.tomifin-import-queue}
umask 0007
mkdir -p -- "$queue" 2>/dev/null || exit 0
temporary="$queue/.$hash.$$"
: > "$temporary" 2>/dev/null && mv -f -- "$temporary" "$queue/$hash" 2>/dev/null
exit 0

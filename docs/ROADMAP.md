# Tomify Roadmap

The roadmap now lives in [TOMIFY_ROADMAP.md](TOMIFY_ROADMAP.md), which comes from the [technical review](TOMIFY_TECHNICAL_REVIEW.md). The original pre-build plan that used to be here is in git history.

The tables below record how far `main` has got with each numbered item, checked against the code on 2026-10-17. Update a row when a change lands.

**Status:** Done · Partly done · Not started

## Top 20 tasks

All 20 are done. Each row names the PR that finished it.

| # | Task | Status | What is on `main` |
| --- | --- | --- | --- |
| 1 | Exclude API and proxy paths from the PWA navigation fallback | Done | `navigateFallbackDenylist` covers `/api/` and `/navidrome/`; unknown `/api/*` returns a JSON 404. |
| 2 | Serialise Usenet job advancement in the agent | Done (#37) | One locked poll per job in `recovery-agent/usenet-job.mjs`; `importing` is saved before an import starts. |
| 3 | Agent-owned background job runner | Done (#49) | `recovery-agent/jobs.mjs` advances every job on a timer, so downloads and imports finish with no browser open; the status endpoint is read-only. |
| 4 | Crash-safe import manifest and resume | Done (#56) | `recovery-agent/manifest.mjs`; on start-up the runner resumes or rolls back interrupted imports. |
| 5 | Recovery agent auth guard and public health minimisation | Done (#42) | The agent refuses a token shorter than 32 characters; `/health` returns only `{ ok, version }`. |
| 6 | Lost-downloader detection and job cancel | Done (#46, #57) | A job missing from SABnzbd/NZBGet for 15 minutes fails as `downloader-lost`; Usenet and torrent jobs can be cancelled. |
| 7 | Version and contract reporting with a compatibility gate | Done (#50) | `/api/version`, agent version and contract 2; Settings warns when contracts differ. |
| 8 | CI pipeline and pinned toolchain | Done (#44) | `.github/workflows/ci.yml`; pnpm pinned by `packageManager`. |
| 9 | Single-command, versioned release and agent deploy | Done (#54) | `scripts/deploy-agent.ps1`: versioned releases, symlink swap, health check with automatic rollback, hardened systemd unit. |
| 10 | Migrations as the schema source of truth | Done (#59) | `drizzle/` migrations applied by `pnpm run deploy`; a test checks the Worker's SQL against the migrated schema and that it runs no DDL. |
| 11 | Unified release-directory resolver for every backend | Done (#45) | YouTube and Internet Archive imports use `planDestination`/`resolveReleaseDirectory`, case, accent and NFC/NFD insensitive. |
| 12 | Truthful quality classification | Done (#51) | `shared/quality.mjs` tiers; `recovered`/`needs-upgrade` follow the Settings target. |
| 13 | Duplicate preflight before acquisition | Done (#58) | `recovery-agent/preflight.mjs` checks the library before a download starts. |
| 14 | Separate pipeline states through to "playable" | Done (#55) | Recovery items track scan-pending, ready and scan-failed after a Navidrome scan. |
| 15 | Spotify matching fixes | Done (#43) | One matcher in `src/lib/catalogue-match.mjs`, with edition-suffix stripping. |
| 16 | Make the Worker a real TypeScript module | Done (#63, #71, #72) | Workers Static Assets, TypeScript modules under `worker/`, `NAVIDROME_ORIGIN` and the binding reference. No Worker module carries `@ts-nocheck` any more (#134). |
| 17 | Read-only library inventory in the agent | Done (#61) | `recovery-agent/inventory.mjs`. |
| 18 | Library health dashboard | Done (#62, #64-#66) | Settings → Library health, with "Mark as fine". |
| 19 | Release import mapped to the MusicBrainz tracklist | Done (#60) | Release imports map files onto the MusicBrainz tracklist. |
| 20 | Mobile navigation, Albums paging and favourites | Done (#38, #67) | Mobile tab bar with Playlists and Favourites, star/unstar, and Albums loads every album. Downloads joined the mobile account sheet with offline downloads (3.1). |

## Phase items without a numbered task

| # | Item | Status | What is on `main` |
| --- | --- | --- | --- |
| 0.6 | Stop tagging lossless files `lossy-recovery-copy`; stop marking every import `needs-upgrade` | Done | See task 12. |
| 0.7 | Pin pnpm | Done | See task 8. |
| 0.8 | Back up and record deployed versions before changes | Unknown | A manual step on the box, so the code cannot show it. |
| 1.8 | Quieter live-playback sync | Done | `LivePlaybackSync.tsx` publishes in short bursts after a change, then only a 30-second keepalive. |
| 1.9 | Atomic final commits; never overwrite `cover.jpg`; clean up SAB downloads | Done (#52) | Imports commit atomically and keep an existing `cover.jpg`; SABnzbd download clean-up is opt-in with `TOMIFY_SABNZBD_CLEANUP=true`. |
| 1.10 | Nightly D1 export and agent state backup; uptime check | Done (#39) | `scripts/backup.sh` with a systemd timer; see docs/RECOVERY.md "Backups and uptime checks". |
| 1.11 | Replace the stale `ARCHITECTURE.md` and `ROADMAP.md`; add `DEPLOYMENT.md` | Done | Both documents are rewritten, and `DEPLOYMENT.md` gathers the site, agent, box, secrets and backup steps. |
| 2.9 | Mobile Library tab, Albums paging, recovery source badges, star/unstar, plainer language | Partly done | See task 20. |
| 3.1 | Offline downloads v1 | Done (#79) | Tracks, albums and playlists download as original files to IndexedDB with artwork and metadata (`src/lib/offline-db.ts`, `src/stores/downloads.ts`); `LocalFirstSourceResolver` plays a valid local copy before streaming. The Downloads page shows real storage figures with per-item status, retry and remove, and is in the mobile account sheet. One quality (original) so far. |
| 3.2 | Album completeness view and bulk "recover missing tracks" | Done (#128) | Administrators can check an album against MusicBrainz and add the missing tracks to Recovery, one item per track or as one release item mapped to the tracklist. Library health lists the checked albums that came up short. |
| 3.3 | Supervised promotion and duplicate merge | Done (#129) | Library health plans each merge or promotion, moves copies to `_Duplicates` instead of deleting them, journals every change for undo and relinks matched songs in playlists. Needs write access to `/srv/music` for the agent (docs/RECOVERY.md). |
| 3.4 | Smart playlists, listening statistics, "Anna is playing…" | Done (#130) | Rule-based smart playlists evaluated in the browser, a Listening stats page from Tomify's history, and "Listening now" on Home from Navidrome's now-playing list. |
| 3.5 | LAN-direct streaming; short-lived Worker sessions | Not started | |
| 3.6 | Scheduled Spotify playlist refresh | Done (#132) | A daily Worker cron saves Spotify playlist changes; matching runs when the owner opens the playlist. |
| 3.7 | Adaptive streaming (HLS) | Done | The agent packages tracks as 64/128/256 kbps HLS; the player follows the signal and falls back to original files. Per-device Streaming quality setting (issue #83). |

Phase 2 items 2.1 to 2.8 match tasks 17, 18, 13, 14, 12, 15, 19 and 19, so they are not repeated here.

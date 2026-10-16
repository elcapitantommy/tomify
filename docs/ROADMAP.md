# Tomify Roadmap

The roadmap now lives in [TOMIFY_ROADMAP.md](TOMIFY_ROADMAP.md), which comes from the [technical review](TOMIFY_TECHNICAL_REVIEW.md). The original pre-build plan that used to be here is in git history.

The tables below record how far `main` has got with each numbered item, checked against the code on 2026-10-16. Update a row when a change lands.

**Status:** Done · Partly done · Not started

## Top 20 tasks

| # | Task | Status | What is on `main` |
| --- | --- | --- | --- |
| 1 | Exclude API and proxy paths from the PWA navigation fallback | Done | `vite.config.ts` sets `navigateFallbackDenylist` for `/api/` and `/navidrome/`. The Worker returns a JSON 404 for unknown `/api/*`. Both are tested in `scripts/build-routing.node-test.mjs`. |
| 2 | Serialise Usenet job advancement in the agent | Partly done | `recovery-agent/usenet-job.mjs` runs one poll per job at a time, with a concurrency test. The agent does not persist `importing` before importing, and `Recovery.tsx` still polls with `setInterval`. |
| 3 | Agent-owned background job runner | Not started | Jobs still advance only when the Worker polls `/v1/jobs/status`. YouTube and Internet Archive acquisition is synchronous. |
| 4 | Crash-safe import manifest and resume | Not started | Imports roll back on error, but nothing resumes or rolls back after a restart. |
| 5 | Recovery agent auth guard and public health minimisation | Partly done | `recovery-agent/config.mjs` refuses to start without a 32-character token unless insecure loopback is set. `/health` still returns the backend list and YouTube cookie state. |
| 6 | Lost-downloader detection and job cancel | Partly done | Torrent jobs can be cancelled (`/v1/jobs/cancel`, used when a torrent item is deleted). There is no lost-downloader timeout, no cancel for Usenet, and `importing` items can still be deleted. |
| 7 | Version and contract reporting with a compatibility gate | Not started | No `/api/version` or agent version. The Worker only explains a bare 404 from an older agent. |
| 8 | CI pipeline and pinned toolchain | Not started | No `.github/workflows` and no `packageManager` in `package.json`. |
| 9 | Single-command, versioned release and agent deploy | Partly done | The systemd example now points at `/opt/tomify/recovery-agent`. There is no release script, symlink swap or added sandbox hardening. |
| 10 | Migrations as the schema source of truth | Not started | `release_metadata` and `live_playback` have no migration, and the Worker still runs DDL on the request path. |
| 11 | Unified release-directory resolver for every backend | Partly done | `resolveReleaseDirectory` in `usenet-import.mjs` matches existing folders ignoring case and accents, for Usenet and torrents. YouTube and Internet Archive imports in `index.mjs` still build paths with `safeName`. |
| 12 | Truthful quality classification | Done | `shared/quality.mjs` sorts imports into lossless, transparent-lossy, lossy or unknown; the Worker marks `recovered`/`needs-upgrade` against the Settings target; files are tagged with their tier. |
| 13 | Duplicate preflight before acquisition | Not started | |
| 14 | Separate pipeline states through to "playable" | Not started | Settings can start a Navidrome scan, but Recovery items do not track scan or playability. |
| 15 | Spotify matching fixes | Not started | `src/lib/catalogue-import.ts` and `scripts/catalogue-import.mjs` still each have a matcher, with no edition-suffix stripping or re-checking of `available` items. |
| 16 | Make the Worker a real TypeScript module | Not started | The Worker is still the string template in `scripts/build-worker.mjs`, now split into `scripts/*-worker.mjs` modules. |
| 17 | Read-only library inventory in the agent | Not started | |
| 18 | Library health dashboard | Not started | |
| 19 | Release import mapped to the MusicBrainz tracklist | Not started | Album completeness fetches MusicBrainz tracklists, but release imports do not use them. |
| 20 | Mobile navigation, Albums paging and favourites | Partly done | On mobile, Playlists is in the tab bar, Spotify import is on the Playlists page, and Settings is in the account sheet. Downloads is not reachable on mobile, the Albums page loads at most 500 albums, and there is no star/unstar. |

## Phase items without a numbered task

| # | Item | Status | What is on `main` |
| --- | --- | --- | --- |
| 0.6 | Stop tagging lossless files `lossy-recovery-copy`; stop marking every import `needs-upgrade` | Done | See task 12. |
| 0.7 | Pin pnpm | Not started | See task 8. |
| 0.8 | Back up and record deployed versions before changes | Unknown | A manual step on the box, so the code cannot show it. |
| 1.8 | Quieter live-playback sync | Not started | `LivePlaybackSync.tsx` polls and publishes on fixed intervals. |
| 1.9 | Atomic final commits; never overwrite `cover.jpg`; clean up SAB downloads | Partly done | Usenet and torrent imports leave an existing `cover.jpg` alone. YouTube and Internet Archive imports replace it, and completed SABnzbd downloads are not removed. |
| 1.10 | Nightly D1 export and agent state backup; uptime check | Not started | |
| 1.11 | Replace the stale `ARCHITECTURE.md` and `ROADMAP.md`; add `DEPLOYMENT.md` | Partly done | Both documents are rewritten. There is no `DEPLOYMENT.md`. |
| 2.9 | Mobile Library tab, Albums paging, recovery source badges, star/unstar, plainer language | Partly done | See task 20. |
| 3.1 | Offline downloads v1 | Not started | The Downloads page is a placeholder, and `src/lib/sourceResolver.ts` always streams. |
| 3.2 | Album completeness view and bulk "recover missing tracks" | Partly done | Administrators can check an album against MusicBrainz and add the missing tracks to Recovery, as one item per track rather than one release job. |
| 3.3 | Supervised promotion and duplicate merge | Not started | |
| 3.4 | Smart playlists, listening statistics, "Anna is playing…" | Not started | Live playback syncs one user's own devices, not other people's. |
| 3.5 | LAN-direct streaming; short-lived Worker sessions | Not started | |
| 3.6 | Scheduled Spotify playlist refresh | Not started | Imported playlists refresh only by hand. |

Phase 2 items 2.1 to 2.8 match tasks 17, 18, 13, 14, 12, 15, 19 and 19, so they are not repeated here.

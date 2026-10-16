# Tomify Roadmap (post-review)

This roadmap comes from [`TOMIFY_TECHNICAL_REVIEW.md`](TOMIFY_TECHNICAL_REVIEW.md) (2026-10-14, `feat/phase-1-pwa` @ `76c3339`). Finding IDs (F-xx) refer to that document.

Tasks are prioritised by impact, then effort, risk and dependencies.

**Effort scale:** S = up to half a day, M = 1–2 days, L = 3–5 days.

---

## Deliverable 5 — Roadmap

### Phase 0 — Immediate fixes (blocking features or risking data integrity)

| # | Item | Findings | Effort |
| --- | --- | --- | --- |
| 0.1 | Stop the service worker hijacking `/api/*` and `/navidrome/*` navigations. Make the Worker return real JSON 404s for unknown `/api/*` paths. | F-01 | S |
| 0.2 | Serialise Usenet job polling and imports. Add a per-job in-process lock and persist `importing` before any work. Make the frontend poll chained, not interval-based. | F-03 | S–M |
| 0.3 | Make the recovery agent refuse to start without a strong token. Strip config details from public `/health`. | F-12, F-13 | S |
| 0.4 | Add a lost-downloader timeout, a "Cancel job" action, and stop treating `importing` as deletable. | F-05, F-06 | S |
| 0.5 | Use the case- and Unicode-insensitive directory resolver for YouTube and Internet Archive imports too. | F-08 | S |
| 0.6 | Stop tagging lossless files `lossy-recovery-copy`. Stop marking every import `needs-upgrade` (interim rule: lossless means `recovered`). | F-07 | S |
| 0.7 | Pin pnpm (`packageManager`) so Cloudflare and local builds are reproducible. | F-18 | S |
| 0.8 | Before touching anything: run `wrangler d1 export` of `tomify-metadata` and `scripts/backup` of `/var/lib/tomify-recovery`. Write down the deployed Worker version and agent commit, and confirm by hand that the agent in `/opt/tomify/recovery-agent` contains `usenet-import.mjs` (`90270a9`). | F-17 | S |

### Phase 1 — Stabilisation (testing, deployment, observability, cleanup, reliability)

| # | Item | Findings | Effort |
| --- | --- | --- | --- |
| 1.1 | Add CI (GitHub Actions): lint, typecheck, test, build, a `sw.js` denylist assertion, and Worker route smoke tests against the built bundle with a fake D1. | F-18 | S |
| 1.2 | Version and contract on both sides: `/api/version`, agent `/v1/status` reporting `{version, contract}`, a Worker compatibility gate, and a Settings display. | F-17 | M |
| 1.3 | Add a release script: tag, then Worker deploy (migrations first), then agent tarball and symlink swap, with rollback. Fix the systemd example and harden its sandbox. | F-17, F-30 | M |
| 1.4 | Agent-owned job runner for all backends (Usenet, YouTube, IA), with a read-only status endpoint. | F-02, F-06 | M |
| 1.5 | Crash-safe import manifests with resume or rollback on startup. | F-04 | M |
| 1.6 | Make migrations the single source of truth (add the missing tables, foreign keys and CHECK constraints) and remove runtime DDL. | F-15 | M |
| 1.7 | Move the Worker out of the string template into real modules with Workers Static Assets; behaviour stays the same. | F-16 | L (start) |
| 1.8 | Quieter live-playback sync: adaptive polling, pause when hidden, send deltas. | F-14 | S |
| 1.9 | Atomic final commits; never overwrite `cover.jpg`; optionally clean up completed SAB downloads. | F-10, F-11 | S |
| 1.10 | Nightly D1 export plus agent state backup; an external uptime check on `/api/version` and the agent `/health`. | — | S |
| 1.11 | Replace the stale `ARCHITECTURE.md` and `ROADMAP.md`; add `DEPLOYMENT.md`. | F-31 | S |

### Phase 2 — Core product improvements (library, metadata, recovery, playback, UX)

| # | Item | Findings | Effort |
| --- | --- | --- | --- |
| 2.1 | Read-only library inventory in the agent (master plus recovery). | F-09 | L |
| 2.2 | Library health dashboard: duplicates, case-only directories, partial albums, orphans, missing artwork, stale D1 rows. | F-08, F-09 | M |
| 2.3 | Duplicate preflight before every acquisition. | F-09 | M |
| 2.4 | Separate pipeline states: downloaded, validated, imported, scanned, playable (Navidrome scan and visibility check). | F-38 | M |
| 2.5 | Quality tiers plus a preferred-target setting; truthful upgrade suggestions. | F-07 | M |
| 2.6 | Spotify matching fixes: better query, remaster neutrality, revalidate `available` entries, one shared matcher. | F-19, F-20, F-21 | M |
| 2.7 | Album-level metadata review; release import mapped to the MusicBrainz tracklist; completeness recorded. | F-29 | L |
| 2.8 | Link imported release tracks to recovery items and pending playlist entries. | F-09 | M |
| 2.9 | UX: mobile Library tab, Albums paging, recovery source badges, star/unstar, plainer recovery language. | F-22, F-23, F-24 | M |

### Phase 3 — Advanced features

| # | Item | Effort |
| --- | --- | --- |
| 3.1 | Offline downloads v1 (track, then album, then playlist) with quality choice, using the existing `sourceResolver` seam. | L |
| 3.2 | Album completeness view plus bulk "recover missing tracks of this album" as one release job. | M |
| 3.3 | Supervised promotion of a recovery copy to master, and supervised merge of duplicate directories, with playlist relinking. | M |
| 3.4 | Smart playlists, listening statistics (from Navidrome scrobbles), and "Anna is playing…". | M |
| 3.5 | LAN-direct streaming fallback; Worker-issued short-lived sessions instead of permanent Subsonic tokens. | M |
| 3.6 | Scheduled Spotify playlist refresh with a diff inbox. | M |

---

## Deliverable 6 — Top 20 actionable tasks

Each task is written so it can be pasted into a GitHub issue or handed to a coding agent.

### 1. Exclude API and proxy paths from the PWA navigation fallback
- **Scope:** Fix the Spotify OAuth callback landing on the SPA 404 page (F-01).
- **Files:** `vite.config.ts` (workbox `navigateFallbackDenylist: [/^\/api\//, /^\/navidrome\//]`); `scripts/build-worker.mjs` (return a JSON 404 for unknown `/api/*` even when the request accepts `text/html`).
- **Acceptance criteria:**
  - The built `dist/sw.js` contains the denylist.
  - With the service worker installed, "Connect Spotify" lands on `/playlists/import/spotify?spotify=connected`.
  - `GET /api/does-not-exist` with `Accept: text/html` returns a 404 JSON response.
- **Tests:** A node test that reads `dist/sw.js` after the build and asserts the denylist regexes are present. A Worker harness test for the callback 302 and the unknown-API 404.
- **Complexity:** S · **Dependencies:** none.

### 2. Serialise Usenet job advancement in the agent
- **Scope:** Prevent concurrent imports of the same job (F-03).
- **Files:** `recovery-agent/index.mjs` (`pollUsenetJob`); `src/pages/Recovery.tsx` (chained `setTimeout` polling).
- **Acceptance criteria:**
  - Two simultaneous `/v1/jobs/status` calls for a completed SAB job produce exactly one import.
  - The second call returns `importing` while the first is still running.
  - The final job state is `completed`, and it is never overwritten by `failed`.
- **Tests:** A node test with a stubbed `importUsenetCompletion` that takes 200 ms, calling `pollUsenetJob` twice in parallel. This requires extracting the job logic into `recovery-agent/jobs.mjs` with injectable dependencies.
- **Complexity:** S–M · **Dependencies:** none.

### 3. Agent-owned background job runner
- **Scope:** Advance downloads and imports without a browser (F-02, F-06). Usenet first, then YouTube and IA.
- **Files:** a new `recovery-agent/jobs.mjs`; `recovery-agent/index.mjs`; Worker `/api/recovery/:id/job` becomes read-only.
- **Acceptance criteria:**
  - Closing every client after queueing still results in an imported album.
  - The status endpoint has no side effects.
  - YouTube and IA acquisition returns `202` with a job.
- **Tests:** A job-runner unit test with a fake downloader and a fake clock. A Worker route test showing that acquire returns 202 for every backend.
- **Complexity:** M · **Dependencies:** task 2.

### 4. Crash-safe import manifest and resume
- **Scope:** No orphan files after an agent restart mid-import (F-04).
- **Files:** `recovery-agent/usenet-import.mjs`, `recovery-agent/index.mjs` (YouTube and IA paths), and `jobs.mjs`.
- **Acceptance criteria:**
  - Kill the agent after N of M tracks have been committed. On restart the job either completes the remaining tracks or rolls back every committed file, according to the manifest.
  - A destination that already exists with an identical sha256 counts as committed.
- **Tests:** A node test that injects a failure after the second file, then runs resume and checks the filesystem state.
- **Complexity:** M · **Dependencies:** task 3.

### 5. Recovery agent auth guard and public health minimisation
- **Scope:** F-12, F-13.
- **Files:** `recovery-agent/index.mjs`, `recovery-agent/recovery-agent.env.example`, `docs/RECOVERY.md`.
- **Acceptance criteria:**
  - The process exits non-zero when the token is missing or shorter than 32 characters, unless the explicit insecure-loopback flag is set.
  - `/health` returns only `{ok, version}`.
- **Tests:** A node test spawning the agent with an empty token and asserting the exit code. A health response shape test.
- **Complexity:** S · **Dependencies:** none.

### 6. Lost-downloader detection and job cancel
- **Scope:** F-05, F-06.
- **Files:** `recovery-agent/usenet.mjs` (`downloaderStatus`), `jobs.mjs`, the Worker recovery routes, and `Recovery.tsx`.
- **Acceptance criteria:**
  - A job missing from the SAB queue and history for 15 minutes (configurable) becomes `failed: downloader-lost`.
  - "Cancel" removes the SAB/NZBGet job and marks the item `missing`.
  - An `importing` item cannot be deleted.
- **Tests:** SAB stub tests for the missing-history case. A cancel API test. A Worker test for the delete guard.
- **Complexity:** S · **Dependencies:** none (simpler after task 3).

### 7. Version and contract reporting with a compatibility gate
- **Scope:** F-17.
- **Files:** `scripts/build-worker.mjs` (inject `TOMIFY_VERSION`/`TOMIFY_CONTRACT`), the agent `/v1/status`, `Settings.tsx`, and `Recovery.tsx` (banner).
- **Acceptance criteria:**
  - `/api/version` returns the git SHA.
  - Settings shows the app and agent versions.
  - On a contract mismatch, search and acquire return 409 with an explanatory message, and the UI shows a banner.
- **Tests:** A Worker harness test with a stubbed agent reporting `contract: 1` while the Worker requires 2.
- **Complexity:** M · **Dependencies:** none.

### 8. CI pipeline and pinned toolchain
- **Scope:** F-18.
- **Files:** `.github/workflows/ci.yml`; `package.json` (`packageManager`); `pnpm-workspace.yaml` (remove the conflicting settings).
- **Acceptance criteria:**
  - Every push runs install, lint, typecheck, test and build, and the run turns red on failure.
  - `pnpm install` succeeds with the pinned version.
- **Tests:** The workflow itself, plus a smoke test of the built Worker bundle.
- **Complexity:** S · **Dependencies:** none.

### 9. Single-command, versioned release and agent deploy
- **Scope:** Deliverable 7 release process; F-30.
- **Files:** `scripts/release.sh`, `scripts/deploy-agent.sh`, `recovery-agent/tomify-recovery.service.example` (correct the `/opt/tomify` paths and add hardening), and `docs/DEPLOYMENT.md`.
- **Acceptance criteria:**
  - The agent is deployed to `/opt/tomify/recovery-agent-<tag>` and swapped in via a symlink.
  - Health reports the new tag.
  - A documented one-command rollback exists.
  - A D1 export is taken before migrations run.
- **Tests:** `shellcheck`; a dry-run mode tested in CI.
- **Complexity:** M · **Dependencies:** task 7.

### 10. Migrations as the schema source of truth
- **Scope:** F-15.
- **Files:** `drizzle/0005_*.sql` (`release_metadata`, `live_playback`, foreign keys, CHECK constraints, a `schema_version` table) and `scripts/build-worker.mjs` / `catalogue-worker.mjs` (remove `ensure*`).
- **Acceptance criteria:**
  - Migrations applied to a copy of the production export produce an identical schema plus the new constraints.
  - No DDL runs on the request path.
  - The harness shows at most 3 D1 statements for the callback.
- **Tests:** Apply the migrations to a local D1 (Miniflare) in CI, then run route tests against it.
- **Complexity:** M · **Dependencies:** tasks 0.8 and 8.

### 11. Unified release-directory resolver for every backend
- **Scope:** F-08.
- **Files:** `recovery-agent/usenet-import.mjs` (export `resolveReleaseDirectory`); `recovery-agent/index.mjs` (YouTube and IA paths); NFC normalisation inside `matchingDirectory`.
- **Acceptance criteria:**
  - Importing via YouTube into an existing `They Might Be Giants/Flood` with wanted artist `they might be giants` reuses the existing directory.
  - NFC and NFD forms of the same name resolve to one directory.
- **Tests:** Extend `usenet-import.node-test.mjs`; add YouTube/IA path tests via an extracted `planDestination()`.
- **Complexity:** S · **Dependencies:** none.

### 12. Truthful quality classification
- **Scope:** F-07.
- **Files:** a new `shared/quality.mjs`; `recovery-agent/metadata.mjs` (correct `TOMIFY_ARCHIVE_STATUS` per source); Worker acquire and job-completion status; `src/lib/recovery.ts` `qualityLabel`; and a settings target.
- **Acceptance criteria:**
  - FLAC/ALAC/WAV are classed `lossless`.
  - Opus ≥ 128, AAC ≥ 192 and MP3 ≥ 245 (or V0) are `transparent-lossy`.
  - `needs-upgrade` is set only when the tier is below the user's target.
  - The UI shows the tier with a plain-language explanation.
- **Tests:** A table-driven unit test over probe fixtures, including a 243 kbps MP3 (transparent, recovery copy, upgrade optional), plus a Worker status mapping test.
- **Complexity:** M · **Dependencies:** none.

### 13. Duplicate preflight before acquisition
- **Scope:** F-09. Interim version, before the full inventory exists.
- **Files:**
  - Agent: a new `POST /v1/preflight`, which scans the target release directory's sidecars and tags.
  - Worker: a call to `/v1/preflight` before acquire.
  - `Recovery.tsx`: a confirmation step.
- **Acceptance criteria:**
  - Acquiring Flood (release) when `Birdhouse In Your Soul.mp3` already exists in recovery shows "1 existing track will be skipped or duplicated" and defaults to skip.
  - Navidrome search finding the same album under the master library shows a warning.
- **Tests:** Fixture directory tests for preflight, plus a Worker flow test.
- **Complexity:** M · **Dependencies:** task 11.

### 14. Separate pipeline states through to "playable"
- **Scope:** F-38.
- **Files:** `src/lib/recovery.ts` (types), the Worker job and acquire routes, `Recovery.tsx`, and a Worker Navidrome helper (`startScan` / `getScanStatus` / `search3`).
- **Acceptance criteria:**
  - The item shows "Imported — waiting for library scan" until Navidrome returns the track (matched by path, title or MBID). After that it shows "Ready to play", with a play button using the Navidrome ID.
  - A failed or missing scan is shown as such.
- **Tests:** A Worker test with a stubbed Navidrome returning the track after N polls.
- **Complexity:** M · **Dependencies:** task 3.

### 15. Spotify matching fixes
- **Scope:** F-19, F-20, F-21.
- **Files:** `src/lib/catalogue-import.ts` (single matcher; title-suffix stripping; primary-artist query with a title-only fallback); delete the duplicate `scripts/catalogue-import.mjs` matcher, or move both into `shared/`; `ImportedPlaylistDetail.tsx` (revalidate `available` IDs via `getSong`).
- **Acceptance criteria:**
  - A Spotify title "Birdhouse in Your Soul - 2010 Remaster" by "They Might Be Giants" auto-matches a local "Birdhouse In Your Soul".
  - A multi-artist "A, B" track matches a local track whose artist is "A".
  - A deleted local track ID is re-matched on open.
- **Tests:** Move the existing node tests to the shared matcher and add remaster, multi-artist and stale-ID cases.
- **Complexity:** M · **Dependencies:** none.

### 16. Make the Worker a real TypeScript module
- **Status:** In progress. PR 16a moved the Vite output to Workers Static Assets; PR 16b replaces the generated Worker string with TypeScript modules. Configurable origins and the full binding reference remain for 16c.
- **Scope:** F-16. Incremental; no behaviour change in the first PR.
- **Files:**
  - A new `worker/` directory: `index.ts`, `routes/*.ts`, `lib/auth.ts`, `lib/d1.ts`.
  - `wrangler.toml`: `main = "worker/index.ts"`, plus an `[assets]` binding with SPA handling.
  - Delete the template string in `build-worker.mjs`.
  - Add `env.NAVIDROME_ORIGIN`.
- **Acceptance criteria:**
  - All existing routes behave identically, verified by a route test suite written *before* the move.
  - The worker bundle is under 150 KB, with assets served by the platform.
- **Tests:** A route test suite (Miniflare or `@cloudflare/vitest-pool-workers`).
- **Complexity:** L · **Dependencies:** tasks 8 and 10.

### 17. Read-only library inventory in the agent
- **Scope:** The foundation for library health.
- **Files:** a new `recovery-agent/inventory.mjs` (walk master and recovery; record path, size, mtime, ffprobe summary, key tags and sidecar link; store in SQLite under the state directory; incremental by mtime) and `POST /v1/inventory/summary`.
- **Acceptance criteria:**
  - A full scan of the library completes without writing anything outside the state directory.
  - A re-scan only probes changed files.
  - The summary returns counts by tier and source.
- **Tests:** A fixture library with case-duplicate directories, an orphan sidecar and a symlink (must be skipped).
- **Complexity:** L · **Dependencies:** task 3 (runs as a job).

### 18. Library health dashboard
- **Scope:** Report duplicates (hash / same recording / case-only directory), partial albums, orphaned `.tomify-source` files and sidecars, D1 rows whose files are missing, and recovery copies shadowing masters.
- **Files:** agent `inventory.mjs` report functions; a Worker route; a new `src/pages/LibraryHealth.tsx`.
- **Acceptance criteria:** The dashboard lists each category with counts and paths. It is read-only. Each row links to the relevant album or recovery item.
- **Tests:** Report function unit tests on the fixture library, and a page render test.
- **Complexity:** M · **Dependencies:** task 17.

### 19. Release import mapped to the MusicBrainz tracklist
- **Scope:** F-29, plus linking release tracks (F-09 part).
- **Files:**
  - Worker: fetch the release tracklist when selecting a release-mode candidate.
  - `usenet-import.mjs`: mapping by disc/track and duration; canonical tags for matched tracks; extras only by opt-in; a completeness record.
  - Worker: create or link `recovery_items` for every imported track, and resolve pending catalogue playlist items.
- **Acceptance criteria:**
  - Flood imports 19 out of 19 with MusicBrainz titles.
  - A download with a bonus track asks before importing the extra.
  - The Spotify playlist entries for Flood tracks become `available` after the scan.
- **Tests:** usenet-import fixtures with an extra file, a missing file, and tags that disagree with the tracklist.
- **Complexity:** L · **Dependencies:** tasks 4, 11 and 13.

### 20. Mobile navigation, Albums paging and favourites
- **Scope:** F-22, F-24, plus read-write favourites.
- **Files:** `AppShell.tsx` (Library tab and sheet), `Albums.tsx` / `navidrome.ts` (offset paging), `navidrome.ts` (`star` / `unstar`), `TrackList.tsx` and `MediaCards.tsx` (heart toggles).
- **Acceptance criteria:**
  - Playlists, Spotify import, Downloads and Settings are reachable on mobile in two taps or fewer.
  - A library with 1,200 albums shows all of them.
  - Starring updates the Favourites page.
- **Tests:** A paging unit test with a stubbed fetcher, and an AppShell render test for mobile links.
- **Complexity:** M · **Dependencies:** none.

---

## Final summary

### 5 most urgent fixes
1. **Service worker hijacks the Spotify OAuth callback** (F-01). Add `navigateFallbackDenylist` for `/api/` and `/navidrome/`.
2. **Concurrent Usenet polls can double-import and record the wrong result** (F-03). Add a per-job lock and persist `importing` first.
3. **Worker/agent version skew silently orphans files** (F-17). At minimum, verify by hand that the deployed agent and Worker both include `90270a9`, then add version reporting.
4. **Recovery agent auth fails open on an empty token** (F-12). Refuse to start without one.
5. **The quality model mislabels everything** (F-07). Lossless files are tagged "lossy" and every import is marked "needs upgrade".

### 5 highest-value new features
1. A **library health dashboard** backed by an agent inventory (duplicates, partial albums, orphans, case-only directories, master vs recovery).
2. **Album completeness, plus album-level recovery** mapped to the MusicBrainz tracklist.
3. A **duplicate preflight** before every acquisition.
4. **Truthful quality tiers** with a user-preferred target and real upgrade suggestions.
5. **Offline downloads v1** (the README's original core goal; the `sourceResolver` seam already exists).

### 5 best architectural improvements
1. **The agent owns job lifecycles** (a background runner with a crash-safe manifest); the browser and Worker only observe.
2. **A versioned Worker/agent contract plus a single tagged release process.**
3. **The Worker becomes a real TypeScript module** with Workers Static Assets, configurable origins and route tests.
4. **Migrations are the schema source of truth**, with no runtime DDL.
5. **A `shared/` module** for normalisation, matching, quality and naming, used by browser, Worker and agent.

### The single most important next development task
**Fix the service worker navigation fallback (Task 1) in the same small PR as CI (Task 8) and the per-job import lock (Task 2).** If only one thing ships: Task 1. It is a ten-line change that restores a broken, user-visible feature, and it is confirmed by both the source and the built `sw.js`. After that, the most important *structural* task is the agent-owned job runner (Task 3), because every recovery-reliability and library-integrity improvement builds on it.

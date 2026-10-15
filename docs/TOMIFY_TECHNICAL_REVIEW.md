# Tomify — Technical and Product Review

**Reviewed:** 2026-10-14 · **Branch:** `feat/phase-1-pwa` @ `76c3339` ("fix: filter multipart fragments from release search") · **Status:** review only, nothing changed or committed.

## How to read this

Every finding carries an evidence tag:

| Tag | Meaning |
| --- | --- |
| **CONFIRMED BY CODE** | Read in source at the cited file/line; behaviour follows directly from it. |
| **CONFIRMED BY TEST** | Reproduced by running the repo's tooling or a local harness against the built artefact. |
| **CONFIRMED LIVE** | Observed against the deployed system. **No finding in this review carries this tag** (see "Limits"). |
| **SUSPECTED** | Strong inference from code plus known external behaviour, not reproduced. |
| **PROPOSED** | A recommendation, not a fact. |

### Limits of this review

- **There was no live verification.** This review ran in a cloud container whose network policy blocks `app.tomify.tomdixon.uk`, `tomify.tomdixon.uk` and `recovery.tomdixon.uk` (proxy `CONNECT 403`), and a separate fetcher could not resolve them (`ENOTFOUND`). So nothing here proves what is deployed, which Worker build is live, or which agent version is on `tomify`. Everything about the live system is inferred from the branch.
- The Windows checkout (`C:\Users\TomDixon\Documents\tomify`) was not available. The repo was cloned fresh from GitHub. `main` has only 3 commits (docs only), so **`feat/phase-1-pwa` is the real product branch**. `.cloudflare-deploy-trigger` (commit `049e7f5`) records that Cloudflare production was switched to build from this branch.
- The Debian host was not inspected. No assumption is made about `/srv/tomify/app`, though note that `recovery-agent/tomify-recovery.service.example` still hard-codes that path (finding F-30).

### Facts established

| Check | Result |
| --- | --- |
| Commits on branch | 140, from 2026-09-28 to 2026-10-14. Two commits are newer than the ones in the brief: `d3d0ef2` (exclude incomplete NZBIndex collections) and `76c3339` (filter multipart fragments). |
| Full-release Usenet import | **Implemented** in `90270a9` (2026-10-13), `recovery-agent/usenet-import.mjs`. Whether it is deployed is **unknown**: the agent is deployed by hand and has no version endpoint. |
| `pnpm lint` | 0 errors, 4 `react-hooks/exhaustive-deps` warnings (AppShell.tsx:36, PlayerRuntime.tsx:39/158/184). |
| `pnpm typecheck` | Clean. |
| `pnpm test` | 27 vitest tests across 7 files plus 62 `node --test` tests. All pass. |
| `pnpm build` | Succeeds. Worker bundle `dist/server/index.js` is 654 KB and inlines every static asset as base64. |
| `pnpm install` with pnpm 10.28 | **Fails** with `ERR_PNPM_CONFIG_CONFLICT_BUILT_DEPENDENCIES` (because `pnpm-workspace.yaml` has both `allowBuilds` and `dangerouslyAllowAllBuilds`). Works with pnpm 9.15.9. |
| CI | None. There is no `.github/` directory. |
| Code size | About 7,600 lines in 114 files. The largest files are `scripts/build-worker.mjs` (811 lines, 64 KB, Worker source held in a template string), `recovery-agent/index.mjs` (553 lines) and `src/pages/Recovery.tsx` (171 very long lines, 25 KB). |

---

## Deliverable 1 — Executive summary

**Current maturity.** This is a capable prototype at a "power-user alpha" stage. It was built very fast: 137 commits in four days, 11–14 October. The streaming client is a real, usable Navidrome front end. The recovery subsystem is unusually careful about provenance, path safety and keeping recovery copies apart from masters. But its **job orchestration is fragile**, and the **library-integrity model (duplicates, quality state, reconciliation) does not exist yet**. Deployment has no CI, no version reporting and no contract between the Worker and the agent.

**Strongest parts**
- Recovery agent safety: subprocesses run without a shell, paths are checked with `realpath` containment and symlinks are rejected (`usenet.mjs:242-283`, `deletion.mjs`). Writes use `COPYFILE_EXCL` and are never overwritten. Originals are kept in `.tomify-source`. Remuxes are stream-copy only. Each file gets a detailed `.tomify.json` provenance sidecar.
- Secret handling: Spotify tokens are AES-GCM encrypted in D1. Indexer and downloader credentials never leave the agent. Tool errors are sanitised (`youtube.mjs:1-9`).
- Player: two `<audio>` elements for near-gapless playback, queue and position persisted and restored, Media Session controls, scrobbling, and cross-device takeover.
- Good unit tests on the pure agent modules (Usenet parsing, SAB states, path translation, release import).

**Weakest parts**
- `scripts/build-worker.mjs`: the whole API lives in a JavaScript string. It is not typechecked, not linted and has no route tests. Hostnames are hard-coded, and the schema is created at runtime on every request.
- Usenet job lifecycle: the import **only runs while a browser is polling**. Polls can overlap, and nothing handles a crash or restart mid-import (F-02, F-03, F-04).
- Quality model: every import is marked `needs-upgrade`, and every file is tagged `lossy-recovery-copy`, even lossless FLAC (F-07).
- Library integrity: there is no duplicate detection against the master library or existing recovery files. Case-insensitive directory reuse covers only the Usenet path (F-08, F-09).

**Largest risks**
1. **Spotify connect is broken for any browser where the PWA service worker is installed** (F-01, High). The cause is in code, and the built `sw.js` confirms it; the Worker route itself works (confirmed by test).
2. A Usenet import can run twice at once and leave D1 saying `failed` while files exist on disk, or the reverse. The result is orphaned files that the app no longer knows how to delete (F-03).
3. Worker/agent version skew silently loses data. Example: an old Worker paired with the `90270a9` agent stores only the first track of an album, so deleting it later leaves 18 tracks orphaned (F-17).
4. Recovery creates duplicates in Navidrome's merged view (`/music` plus `/music/_Recovery`), and the UI's album-family collapsing hides them (F-09, F-23).

**Largest opportunities**
- A **library-health model**: a scanner-backed inventory of master plus recovery, covering duplicates, partial albums, quality tiers, orphans and reconciliation. It is the natural differentiator for "more than a Navidrome skin" and the prerequisite for safe recovery.
- An **album-level recovery workflow** driven by a MusicBrainz tracklist: completeness detection, then release acquisition, then per-track mapping.
- Offline downloads, whose groundwork (`sourceResolver.ts`) already exists.

**Readiness for daily use**
- *Listening:* yes for the household, on the evidence of code and history (not verified live). Caveats: albums are capped at 500 (F-22), mobile has no Playlists or Settings navigation (F-24), favourites and playlists are read-only, and there is no offline playback.
- *Spotify import:* not reliable until F-01 is fixed. Matching will over-report "missing" (F-19).
- *Recovery:* usable **under supervision**, one job at a time, with the Recovery page left open until it finishes. It is not yet safe to run unattended or in bulk.

---

## Deliverable 2 — Feature inventory

| Feature | Status | Confidence | Issues | Recommendation |
| --- | --- | --- | --- | --- |
| Login / session (Subsonic token) | Implemented | High | Token and salt never expire. They are stored in localStorage and sent in URL query strings. Settings wrongly calls the token "revocable" (F-25). | Fix the copy. Consider a Worker-issued session later. |
| Library browse: artists | Implemented | High | Loads every artist in one call; fine at household scale. | — |
| Albums page | Partial | High | Hard cap of `getAlbumList2 size=500` with no paging (`Albums.tsx:25`). Grouping can wrongly merge releases (F-23). | Page through results (offset loop). |
| Artist / album detail, editions | Implemented | Medium | Edition collapsing is heuristic. It hides recovery-vs-master duplicates. | Show source badges ("Recovery") on variants. |
| Track playback, queue, controls | Implemented | Medium | Near-gapless double buffer. Not verified on iOS from here. | — |
| Search | Implemented | High | Navidrome `search3` passthrough, 350 ms debounce. | — |
| Navidrome playlists | Partial | High | Read-only; "New playlist" is disabled. | Phase 2. |
| Favourites | Partial | High | Read-only (no star/unstar). | Add star toggles; it's cheap. |
| Downloads / offline | Missing | High | Placeholder page; `StreamFirstSourceResolver` stub. | Phase 2–3. |
| Mobile layout | Partial | High | Mobile nav has no Playlists, Settings or Downloads (`AppShell.tsx:12`). | Add a "Library" tab. |
| PWA install / update | Implemented | Medium | SW navigation fallback hijacks `/api/*` navigations (F-01). Image cache stores opaque responses. | Add a denylist. |
| Playback persistence / cross-device | Implemented | Medium | Heavy polling (1.5 s / 3 s) with DDL on every request (F-14). | Back off when hidden or idle. |
| Scrobbling / history | Implemented | Medium | Uses Navidrome scrobble. | — |
| Release-type enrichment (MusicBrainz) | Implemented | Medium | Rate limit is per isolate only. Non-Latin titles normalise to empty (F-33). | — |
| Spotify OAuth connect | **Broken** (in an installed PWA) | High | Service worker serves `index.html` for the callback (F-01). | Phase 0 fix. |
| Spotify playlist import / match | Partial | Medium | Search query includes all artists and remaster suffixes, so matches are falsely reported missing (F-19). Matching logic is duplicated, and tests cover the unused copy (F-20). | Fix the query; consolidate the logic. |
| Imported playlist refresh | Partial | Medium | Manual only. `available` entries are never revalidated (F-21). | Revalidate by Navidrome ID. |
| Recovery: YouTube | Implemented | Medium | Synchronous inside a Worker request (F-06). Case-variant directories (F-08). Overwrites `cover.jpg`. | Move to the job model. |
| Recovery: Internet Archive | Implemented | Medium | Same as YouTube. FLAC gets tagged "lossy" (F-07). | — |
| Recovery: NZBIndex / Newznab search | Implemented | Medium | NZBIndex anonymous mode tested. Newznab path is untested live. | — |
| Recovery: SABnzbd | Implemented | Medium | Import is triggered by polling (F-02), races (F-03), can hang forever if history is purged (F-05), and never cleans up completed downloads (F-11). | Agent-side worker loop. |
| Recovery: NZBGet | Partial | Low | Never exercised live. No container path translation. | Treat as experimental. |
| Full-release import | Implemented (deployment unknown) | Medium | Not checked against a MusicBrainz tracklist. Embedded tags override canonical metadata. Can duplicate earlier single-track imports (F-09, F-29). | Add a completeness check. |
| Recovery deletion | Implemented | High | Works by path. Leaves `cover.jpg` and empty directories. Release deletion depends on `importedTracks` being present (F-17). | — |
| Metadata review (MusicBrainz) | Implemented | Medium | Per-track only, with no album-level review. | — |
| Artwork pipeline | Implemented | Medium | Strong validation. Per-track choice can disagree within an album; YouTube and IA overwrite the release cover. | One artwork per release. |
| Quality model / upgrade status | Partial | High | Everything is `needs-upgrade`; no tiers (F-07). | Define tiers. |
| Library health / duplicates / reconciliation | Missing | High | — | Phase 2 cornerstone. |
| Navidrome rescan / visibility tracking | Missing | High | No `startScan`/`getScanStatus` calls; "imported" is conflated with "playable" (F-38). | Add states. |
| Deployment / CI / versioning | Missing | High | No CI, no build SHA, no compatibility check (F-17, F-18). | Phase 1. |

---

## Deliverable 3 — Technical findings

Severity reflects impact on *this* household-scale system. Effort: S ≤ ½ day, M ≈ 1–2 days, L ≈ 3–5 days.

### F-01 · High · PWA / Spotify — Service worker hijacks the OAuth callback (and every `/api/*` navigation)
- **Evidence:** CONFIRMED BY CODE plus CONFIRMED BY TEST.
  - `vite.config.ts:20` sets `navigateFallback: '/index.html'` with no `navigateFallbackDenylist`. The built `dist/sw.js` contains `registerRoute(new NavigationRoute(createHandlerBoundToURL("/index.html")))` with no denylist. So every top-level navigation in scope `/` is answered from the precache, including Spotify's redirect to `/api/catalogue-auth/spotify/callback?code=…&state=…`.
  - React Router has no `/api/*` route (`App.tsx:30`), so the user sees `NotFound` ("That page wandered off").
  - The request never reaches the Worker, so the token is never stored.
  - A local harness running the built `dist/server/index.js` with a fake D1 shows the Worker route itself is correct: `GET /api/catalogue-auth/spotify/callback?state=good&code=c` → `302 /playlists/import/spotify?spotify=connected`.
  - Secondary path: the Worker's own fallback (`build-worker.mjs:801`) also returns `index.html` for any unknown `text/html` path, so a Worker build that predates `c32c711`, or a mistyped `SPOTIFY_REDIRECT_URI` path outside `/api/catalogue-`, would produce the same symptom.
- **Impact:** Spotify connect fails on any browser or installed PWA that has already loaded Tomify. That is almost every real user. It looks like a "deployment mismatch", which sends debugging the wrong way.
- **Fix (PROPOSED):** add `navigateFallbackDenylist: [/^\/api\//, /^\/navidrome\//]` to the workbox config. Make the Worker return a real 404 for unknown `/api/*` paths instead of the SPA. Add a test that asserts the denylist appears in the generated `sw.js`.
- **Effort:** S · **Dependencies:** none.

### F-02 · High · Recovery agent — Usenet import only happens while a browser is polling
- **Evidence:** CONFIRMED BY CODE. The agent has no background loop. The import (`importUsenetCompletion`) runs inside `pollUsenetJob` (`recovery-agent/index.mjs:479-497`). That runs only for `POST /v1/jobs/status`, which the Worker calls only from `GET /api/recovery/:id/job` (`build-worker.mjs:568`). The Worker calls that only from the Recovery page's 3 s interval (`Recovery.tsx:47-53`).
- **Impact:** If you close the app, SAB finishes but nothing is imported until someone reopens Recovery. The import then runs inside an HTTP request chain Browser → Worker → tunnel → agent, which is subject to Cloudflare's ~100 s origin timeout. A 19-track album with artwork and ffmpeg can exceed that, so the UI shows "Could not refresh a recovery job" while the import continues.
- **Fix (PROPOSED):** run an agent-side job runner: a single in-process loop that scans `TOMIFY_RECOVERY_STATE_DIR` every N seconds and advances jobs. Make `/v1/jobs/status` read-only.
- **Effort:** M · **Dependencies:** pairs with F-03 and F-04.

### F-03 · High · Recovery — Overlapping polls can import the same release twice and record the wrong outcome
- **Evidence:** CONFIRMED BY CODE (not reproduced).
  - `Recovery.tsx:50` fires `pollJob` every 3 s via `setInterval`, without waiting for the previous call.
  - Two tabs or two devices also each poll.
  - `pollUsenetJob` has no lock or "importing" marker. It loads the job (still `downloading` on disk), sees SAB `completed` and starts `importUsenetCompletion`.
  - The second call does the same. Whichever loses on `ensureAbsent`/`COPYFILE_EXCL` (`usenet-import.mjs:146,166-167`) sets `job.status='failed'` and saves it. The first later saves `completed`.
  - Any poll that lands between those saves returns `failed`. The Worker then writes `status='failed'` with no `imported_path` (`build-worker.mjs:589-593`), and the UI stops polling because only `queued`/`downloading` are polled.
- **Impact:** D1 says failed while the files exist, or the reverse. Delete cannot find the paths, so files are orphaned. This is a library-integrity risk.
- **Fix (PROPOSED):** make the import an agent-owned state machine (`downloaded → importing → imported`) with a per-job in-process mutex and an `importing` state persisted *before* any work. Status polls should only read state. Also chain the frontend poll (`setTimeout` after completion) instead of `setInterval`.
- **Effort:** M · **Dependencies:** F-02.

### F-04 · Medium · Recovery — No crash-safe resume or idempotency for imports
- **Evidence:** CONFIRMED BY CODE. Rollback in `importUsenetCompletion` (`usenet-import.mjs:196-199`) only runs in-process. If the agent restarts mid-import (systemd `Restart=on-failure`, a deploy, or an OOM kill), any committed files stay. The job file still says `downloading`. The next poll re-imports, `ensureAbsent` throws "A recovery copy already exists", and the job becomes `failed` with orphans. YouTube and IA imports have the same pattern (`index.mjs:302-334`). Temporary files under `/tmp/tomify-recovery-*` are only cleared by `PrivateTmp` when the service restarts.
- **Impact:** Partial albums and files nothing references.
- **Fix (PROPOSED):** write a per-job manifest (planned destinations plus each one's committed or not committed state) before committing anything. On startup or resume, either complete or roll back from the manifest. Treat "destination exists with matching sha256" as already committed.
- **Effort:** M · **Dependencies:** F-02 and F-03.

### F-05 · Medium · Recovery — Jobs can hang forever as `queued`
- **Evidence:** CONFIRMED BY CODE. If the SAB/NZBGet history no longer contains the job (for example it was deleted manually, or history was purged), `downloaderStatus` returns `{status:'queued', message:'Waiting for downloader'}` (`usenet.mjs:221,237`). There is no timeout, maximum age or "missing at downloader" state anywhere.
- **Impact:** Stuck items that cannot be deleted. The Worker blocks DELETE and search while the status is `queued`/`downloading` (`build-worker.mjs:482,519`).
- **Fix (PROPOSED):** distinguish "never seen" from "disappeared": record `seenAtDownloader`. After N minutes absent, move to `failed: downloader-lost`. Add a "Cancel job" action that also removes the job from SAB.
- **Effort:** S · **Dependencies:** none.

### F-06 · Medium · Worker — Synchronous YouTube/IA imports run inside one Worker request; `importing` can stick
- **Evidence:** CONFIRMED BY CODE. `build-worker.mjs:626` sets `status='importing'` and then awaits the full download plus ffmpeg on the agent (IA downloads have a 10-minute timeout, `index.mjs:180`). If the client disconnects, the Worker is cancelled, or the tunnel times out, the catch at `:643` may never run, leaving the item `importing` forever. `importing` is not in the active-job guard, so the user can delete or re-acquire mid-import (`:482,519,553`).
- **Fix (PROPOSED):** move YouTube and IA onto the same agent job model as Usenet (F-02), which also unifies progress reporting.
- **Effort:** M · **Dependencies:** F-02.

### F-07 · Medium · Quality model — Every import is "needs upgrade"; FLAC is tagged "lossy"
- **Evidence:** CONFIRMED BY CODE.
  - The Worker sets `status='needs-upgrade'` for every completed import, whatever the codec (`build-worker.mjs:587,640`).
  - `ffmpegMetadataArguments` writes `TOMIFY_ARCHIVE_STATUS=lossy-recovery-copy` for **every** derivative (`recovery-agent/metadata.mjs:15`), including lossless FLAC from IA or Usenet. The provenance JSON correctly says `internet-archive-recovery-copy`/`usenet-recovery-copy`, so the two disagree.
  - `qualityLabel` (`src/lib/recovery.ts:163`) shows only codec, kbps, kHz and channels. There is no notion of lossless, codec efficiency or "transparent".
  - `recovered` is reachable only by a manual PATCH.
- **Technical assessment:** the right axes are (a) **lossless vs lossy** (`flac`/`alac`/`wav`/`aiff`, with a caveat that lossless-container-of-lossy-source is possible and spectral analysis is out of scope), (b) **codec-normalised perceptual tier** (e.g. Opus ≥ 128 ≈ AAC ≥ 192 ≈ MP3 V0/≥ 245 → "transparent lossy"), and (c) **provenance** (recovery vs archival master). A 243 kbps MP3 is "transparent lossy, recovery copy", not "needs upgrade" in any urgent sense. Container ≠ codec is already handled correctly (`derivative.mjs`).
- **Fix (PROPOSED):** add a pure `classifyQuality(probe) → { tier: 'lossless' | 'transparent-lossy' | 'good-lossy' | 'low-lossy', reason }` in a shared module. Store the tier. Compute `needs-upgrade` from tier against the user's preferred target (a setting, default "lossless master desired"). Write the correct `TOMIFY_ARCHIVE_STATUS`. Never auto-promote.
- **Effort:** M · **Dependencies:** shared module (A-2).

### F-08 · Medium · Library integrity — Case-insensitive directory reuse is only half done
- **Evidence:** CONFIRMED BY CODE. `matchingDirectory` (`usenet-import.mjs:75-86`) reuses an existing artist or album directory regardless of case, **but only for Usenet**. YouTube and IA build paths with `safeName(...)` directly (`index.mjs:280-284, 363-367`), so `they might be giants/flood` and `They Might Be Giants/Flood` can still be created. Existing duplicate directories are never merged. If both exist, the exact match wins, otherwise the first alphabetically. There is no Unicode NFC normalisation, so `Beyoncé` in NFC and NFD produces two directories.
- **Impact:** The known `/srv/music-recovery/they might be giants/flood` duplication is not structurally solved.
- **Fix (PROPOSED):** use one `resolveReleaseDirectory` for all backends, NFC-normalise names, and add a read-only "case/Unicode duplicate directories" report. Then add a supervised merge tool that moves files and rewrites sidecar paths and D1 `imported_path` together.
- **Effort:** S (shared resolver) + M (merge tool) · **Dependencies:** a D1 path-update endpoint.

### F-09 · High · Library integrity — No duplicate detection; release imports duplicate earlier single-track imports
- **Evidence:** CONFIRMED BY CODE.
  - `ensureAbsent` (`usenet-import.mjs:97-101,146`) checks only exact destination paths.
  - Flood case: the earlier track import wrote `Birdhouse In Your Soul.mp3` (no track-number prefix). A release import writes `03 - Birdhouse In Your Soul.mp3`, so both files exist and Navidrome shows the track twice.
  - If the names do collide, the whole release import fails ("A recovery copy already exists").
  - Nothing checks the canonical `/srv/music` tree for the same release. Navidrome sees `/music` and `/music/_Recovery` as one library, so master and recovery copies of one album appear side by side. `collapseReleaseVariants` then merges them into one "family" card (`release-metadata.ts:152`), which hides the problem.
  - The other 18 Flood tracks get no `recovery_items` rows, so Spotify playlist entries for them stay `missing` and can be acquired again.
- **Fix (PROPOSED):** before import, build a duplicate plan using `(normalised albumartist, album, disc, track)` and duration ±2 s across recovery files (from sidecars) and Navidrome (`getAlbum` search for the release). Show a "this will duplicate N tracks" step; offer skip or replace-recovery-copy (never a master). After a release import, link or create `recovery_items` for every imported track and resolve matching pending playlist entries.
- **Effort:** L · **Dependencies:** library inventory (Phase 2), F-08.

### F-10 · Low · Recovery — Non-atomic final writes into a Navidrome-visible directory; YouTube/IA overwrite `cover.jpg`
- **Evidence:** CONFIRMED BY CODE. `copyFile(taggedPath, finalPath, COPYFILE_EXCL)` (`index.mjs:309,392`; `usenet-import.mjs:167`) copies byte by byte into the final, visible name. A scan during the copy can index a truncated file. YouTube and IA always `rename(staged, cover.jpg)`, replacing an existing release cover (`index.mjs:313,396`). The Usenet path correctly creates the cover only if it is absent.
- **Fix (PROPOSED):** `link()`/`rename()` the already-staged dot-file into place (same filesystem), so the commit is atomic. Only write `cover.jpg` if absent or explicitly chosen.
- **Effort:** S.

### F-11 · Low · Operations — Completed Usenet downloads are never cleaned up
- **Evidence:** CONFIRMED BY CODE. Nothing removes the SAB job directory after import. The systemd example mounts `/srv/usenet/completed` read-only (`tomify-recovery.service.example:18`), so the agent could not clean it anyway. Each album stays twice on disk: the SAB copy plus `.tomify-source`.
- **Fix (PROPOSED):** after a verified import, ask SAB to delete the history entry with files (`mode=history&name=delete&del_files=1`). Alternatively, give the agent write access to only its category subdirectory. Make it configurable and default it to on.
- **Effort:** S.

### F-12 · Medium · Security — Recovery agent auth fails open when the token is empty
- **Evidence:** CONFIRMED BY CODE. `authorised()` returns `true` when `TOMIFY_RECOVERY_TOKEN` is unset or empty (`index.mjs:115-116`). The agent is published at `https://recovery.tomdixon.uk`. If the env file ever loses that line, anyone can trigger downloads and deletes inside the recovery root.
- **Severity note:** a probable weakness, not a confirmed vulnerability. The live env is not known.
- **Fix (PROPOSED):** refuse to start without a token of ≥ 32 characters, unless `TOMIFY_RECOVERY_INSECURE_LOCAL=1` is set and it binds to loopback. Also confirm the reverse proxy adds its own auth (Cloudflare Access service token), as `RECOVERY.md:92` recommends.
- **Effort:** S.

### F-13 · Low · Security — Unauthenticated `/health` reveals configuration
- **Evidence:** CONFIRMED BY CODE (`index.mjs:522-525`). It returns the enabled backends and YouTube cookie status publicly.
- **Fix (PROPOSED):** return only `{ok, version}` unauthenticated; move the details behind the token.
- **Effort:** S.

### F-14 · Medium · Performance / cost — Live-playback polling is heavy
- **Evidence:** CONFIRMED BY CODE; cost impact SUSPECTED.
  - Every open client polls `GET /api/live-playback` every 1.5 s and, while it owns playback, publishes its **entire queue** every 3 s (`LivePlaybackSync.tsx:132-137`).
  - Each request runs `CREATE TABLE IF NOT EXISTS` (`build-worker.mjs:655,681`). Auth needs a Navidrome ping on a cache miss, and the cache is per isolate and lasts 30 s (`:63-91`).
  - One open desktop tab makes about 57k Worker requests and about 28k D1 writes a day while playing.
- **Impact:** On Cloudflare's free plan (100k requests a day, 100k D1 rows written a day), two all-day sessions can hit the limit. The plan in use is unknown. It also wastes battery on phones.
- **Fix (PROPOSED):** poll every 1.5 s only while a *remote* device is active; otherwise every 15–30 s. Pause polling when the page is hidden. Publish deltas (position/state) without the queue unless the queue changed. Remove the per-request DDL (F-15).
- **Effort:** S–M.

### F-15 · Medium · Data layer — Schema created at runtime on every request; two sources of truth
- **Evidence:** CONFIRMED BY CODE plus CONFIRMED BY TEST.
  - `ensureRecoveryTables`, `ensureCatalogueTables`, `ensureReleaseTable` and `ensureLivePlaybackTable` run on every request. The harness measured about 15 D1 statements before the callback logic.
  - `ALTER TABLE` statements sit in `try {}` and swallow any error, not just "duplicate column".
  - `drizzle/0001–0004` cover only recovery and catalogue tables. There is no tooling to apply them, and there is no migration for `release_metadata` or `live_playback`.
  - No foreign keys (e.g. `recovery_candidates.recovery_id`, `catalogue_playlist_items.playlist_id`) and no `CHECK` on status columns.
- **Fix (PROPOSED):** make `drizzle/` (or plain numbered SQL) the single source and apply it with `wrangler d1 migrations apply` in the deploy pipeline. Add `0005` for the missing tables and constraints. Delete the runtime `ensure*` functions. Add a `schema_version` check that returns 503 with a clear message if it is behind.
- **Effort:** M.

### F-16 · Medium · Architecture — The Worker is a string template: untyped, unlinted, untested, hard-coded
- **Evidence:** CONFIRMED BY CODE.
  - `scripts/build-worker.mjs` emits the API as a template literal. Helper modules are joined in via `fn.toString()` (`catalogue-worker.mjs:232`, `catalogue-import.mjs:112`).
  - Regexes need double escaping (e.g. `'\\/api\\/recovery…'` at `:474`). Past commits `80d3784` and `c3a0388` were fixes for exactly this template breakage.
  - TypeScript and ESLint never see the routes. There are no route tests (only the helper functions are tested).
  - The Navidrome origin is hard-coded at `:74` and `:786`, and in `navidrome.ts:9`.
  - All static assets are base64-inlined (654 KB Worker), so assets are not edge-cached separately, and every deploy ships every image.
- **Fix (PROPOSED):** make `worker/index.ts` a real module bundled by Wrangler/esbuild, using Workers Static Assets (`[assets] directory="dist"`, `not_found_handling="single-page-application"`). Split routes into `routes/recovery.ts`, `routes/catalogue.ts`, `routes/playback.ts` and `routes/releaseMeta.ts`, with a tiny router and zod-style validation. Move the Navidrome URL to `env.NAVIDROME_ORIGIN`. Do this incrementally: first move the string as-is into a `.js` module, then convert to TypeScript one route group at a time.
- **Effort:** L (incremental).

### F-17 · High · Deployment — The Worker/agent contract is unversioned; skew silently loses data
- **Evidence:** CONFIRMED BY CODE.
  - The Worker deploys from Cloudflare on push to `feat/phase-1-pwa`. The agent is copied to `/opt/tomify/recovery-agent` by hand.
  - Neither side reports a version. `/v1/status` has no `apiVersion`.
  - Concrete example, `90270a9`: an old Worker paired with the new agent stores only `job.result.path` (the first track). `importedTracks` is ignored, so deleting the item removes 1 of 19 files and orphans the rest.
  - Conversely, a new Worker paired with an old agent queues release searches that the agent imports as one track. This was the original Flood bug.
- **Fix (PROPOSED):** add `GIT_SHA`/`BUILD_TIME` to both, injected at build/deploy. `GET /api/version` and agent `/v1/status` return `{ version, contract: N }`. The Worker refuses acquisition with a 409 "agent contract N, need M" when they disagree, and Settings shows both versions. Ship agent and Worker from one tagged commit with one script (Deliverable 7).
- **Effort:** M.

### F-18 · Medium · Delivery — No CI; build depends on the pnpm version
- **Evidence:** CONFIRMED BY TEST. There is no `.github/workflows`. `pnpm install` fails on pnpm 10.28 because `pnpm-workspace.yaml` sets both `allowBuilds` and `dangerouslyAllowAllBuilds: true`. There is no `packageManager` field pinning pnpm.
- **Fix (PROPOSED):** add `"packageManager": "pnpm@9.15.9"` (or fix the workspace file for pnpm 10). Add a GitHub Actions workflow running lint, typecheck, test and build, plus a test that asserts the `sw.js` denylist and Worker routes.
- **Effort:** S.

### F-19 · Medium · Spotify import — Library search query causes false "missing"
- **Evidence:** CONFIRMED BY CODE; impact SUSPECTED. The query is ``${item.artists.join(' ')} ${item.title}`` (`SpotifyPlaylistImport.tsx:30`, `ImportedPlaylistDetail.tsx:13`). Spotify titles often carry `- 2010 Remaster`, `- Radio Edit` or `feat.` credits, and multi-artist tracks join every artist. Navidrome's `search3` requires every word to match, so these return no local candidates. The item becomes `missing`, and "Import + add missing to Recovery" queues tracks you already own, which leads to duplicates (F-09). Separately, a remaster suffix also lowers the Dice title score into the 72–91 "review" band.
- **Fix (PROPOSED):** build the query from the primary artist plus the title stripped of version suffixes (reuse `releaseFamilyTitle`-style stripping for track titles). Fall back to a title-only search. Treat "Remaster/Remastered YYYY" as neutral in scoring (not a version signal).
- **Effort:** S.

### F-20 · Medium · Code quality — Matching logic duplicated; tests cover the copy production doesn't use
- **Evidence:** CONFIRMED BY CODE. The browser uses `matchCatalogueItem` from `src/lib/catalogue-import.ts:21-42`. The node tests exercise `matchCatalogueTrack` in `scripts/catalogue-import.mjs:31-57`, which the Worker never uses. Normalisers are duplicated at least five times (`normalise`, `normaliseCatalogueText`, `normaliseMetadataText`, `recoveryTokens`, `normaliseVariantText`), with different Unicode handling. Only `normaliseMetadataText` strips diacritics.
- **Fix (PROPOSED):** create one `shared/` package of pure ES modules (text normalisation, matching, quality classification), imported by the browser, the Worker (once F-16 lands) and the agent, and test that once.
- **Effort:** M.

### F-21 · Medium · Spotify import — `available` entries are never revalidated
- **Evidence:** CONFIRMED BY CODE. `ImportedPlaylistDetail.tsx:13` only re-searches `missing`/`review`. Entries store a snapshot of the Navidrome track (`local_track_json`). Navidrome track IDs change when files are moved or renamed, for example when a recovery copy is promoted or a duplicate directory merged.
- **Impact:** Dead playlist entries after any library reorganisation.
- **Fix (PROPOSED):** on open, batch-verify `available` IDs (`getSong`). Re-match on a 404 and keep the original position.
- **Effort:** S.

### F-22 · Medium · UX / scale — Albums page silently caps at 500
- **Evidence:** CONFIRMED BY CODE (`Albums.tsx:25`, `api.albums('alphabeticalByName', 500)`; Subsonic's maximum per call is 500). "N releases" counts only what loaded.
- **Fix (PROPOSED):** page with `offset` until a short page comes back. Cache the result as today.
- **Effort:** S.

### F-23 · Low · Metadata — Release-family grouping can merge distinct releases and hides duplicates
- **Evidence:** CONFIRMED BY CODE. `releaseFamilyGroupingTitle` strips *any* trailing parenthetical (`release-metadata.ts:134-137`), so `Greatest Hits (1970–1980)` and `Greatest Hits (1981–1990)` by one artist merge into one card. The keyword regex matches substrings such as `us` inside `(The Music)`.
- **Fix (PROPOSED):** only strip parentheticals that match the edition keyword list (word-bounded). Prefer the MusicBrainz release-group ID when known. Badge recovery-sourced variants.
- **Effort:** S.

### F-24 · Medium · UX — Mobile navigation omits Playlists, Settings and Downloads
- **Evidence:** CONFIRMED BY CODE (`AppShell.tsx:12`). The mobile tabs are Home, Search, Artists, Albums, Recovery and Favourites. Playlists and Spotify import are unreachable on a phone except by URL. Recovery, an admin tool, takes a primary tab slot.
- **Fix (PROPOSED):** use five tabs: Home, Search, Library (Artists, Albums, Playlists, Favourites, Downloads), Recovery (shown for admins only) and Settings via the top bar.
- **Effort:** S.

### F-25 · Low · Security — Long-lived Subsonic credential in localStorage and URLs; misleading copy
- **Evidence:** CONFIRMED BY CODE. `md5(password+salt)` and the salt are generated once at login and reused forever (`navidrome.ts:22-25`). They are sent as query parameters on every stream and cover URL (so they appear in Cloudflare and Navidrome logs and in the service worker's image cache keys), and as `x-tomify-*` headers to the Worker. Settings says "Tomify stores a revocable token" (`Settings.tsx:11`). It can only be revoked by changing the Navidrome password.
- **Severity note:** a probable weakness. It is the normal Subsonic trade-off and acceptable for trusted family devices.
- **Fix (PROPOSED):** correct the copy now. Later, have the Worker mint a short-lived signed session (HttpOnly cookie) after one Subsonic ping, and accept that cookie on the API routes.
- **Effort:** S (copy) / M (sessions).

### F-26 · Low · Security — OAuth `state` is bound to the username, not the browser
- **Evidence:** CONFIRMED BY CODE (`catalogue-worker.mjs:186-194, 163-176`). A login-CSRF variant (an attacker's Tomify user plus the victim's Spotify consent) is theoretical in a two-user household.
- **Fix (PROPOSED):** also set a short-lived HttpOnly `state` cookie and compare it at the callback.
- **Effort:** S.

### F-27 · Medium · Architecture — Core playback now depends on Cloudflare
- **Evidence:** CONFIRMED BY CODE. The default server is rewritten to the same-origin `/navidrome` Worker proxy (`navidrome.ts:13-20`, `build-worker.mjs:784-797`). Every stream byte, including FLAC, goes home → tunnel → Cloudflare → Worker → client, even at home. That contradicts README principle 6 ("no cloud dependency for core playback"). Auth also hairpins to the public Navidrome hostname (`:74`).
- **Fix (PROPOSED):** keep the proxy for API calls and artwork. Optionally let streams use a LAN origin when it is reachable (probe `https://<lan-host>/rest/ping` with a short timeout). At minimum, document the dependency and check Cloudflare's media-proxy terms for the plan in use.
- **Effort:** M.

### F-28 · Medium · Recovery — Track-mode file selection can silently pick the wrong track
- **Evidence:** CONFIRMED BY CODE. `selectCompletedAudio` (`usenet.mjs:285-290`) scores ASCII tokens only, then breaks ties alphabetically. A non-ASCII or numeric title (score 0 for every file) imports `01 - …`, whatever track that is. It also never uses duration.
- **Fix (PROPOSED):** score using the probed title tag plus normalised filename plus duration (±3 s), and require a minimum score or else fail with "no confident match".
- **Effort:** S.

### F-29 · Medium · Recovery — Release import trusts the download, not the canonical tracklist
- **Evidence:** CONFIRMED BY CODE. Release mode imports every audio file it finds (`selectUsenetImportFiles`, `usenet-import.mjs:68-73`), including bonus tracks, samples and other editions. Embedded tags override MusicBrainz for every field (`releaseTrackMetadata`, `:50-66`), which contradicts `RECOVERY.md`'s "MusicBrainz canonical" principle. Album and artist directories come from the most common tag value, not the reviewed release. Nothing checks completeness (19 files expected, 18 received).
- **Fix (PROPOSED):** for release mode, fetch the MusicBrainz release tracklist. Map files to tracks by disc/track number and duration, and show the mapping (matched / extra / missing). Apply canonical tags to matched tracks; extras need explicit opt-in. Record `completeness: 18/19`.
- **Effort:** L · **Dependencies:** an album-level metadata review UI.

### F-30 · Low · Operations — Systemd example is stale and lightly sandboxed
- **Evidence:** CONFIRMED BY CODE. `WorkingDirectory` and `ExecStart` point at `/srv/tomify/app/recovery-agent` (`tomify-recovery.service.example:9,11`), the wrong path the brief warned about, whereas the agent is actually at `/opt/tomify/recovery-agent`. It has no `MemoryMax`, `CPUQuota`, `ProtectKernel*`, `RestrictAddressFamilies`, `SystemCallFilter` or `UMask`, and ffmpeg/yt-dlp run with the agent's full rights.
- **Fix (PROPOSED):** fix the paths. Add `MemoryMax=1G`, `CPUQuota=200%`, `ProtectKernelTunables/Modules/Logs=yes`, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`, `LockPersonality=yes`, `UMask=0027`, `StateDirectory=tomify-recovery`.
- **Effort:** S.

### F-31 · Low · Docs — Architecture and roadmap predate the implementation
- **Evidence:** CONFIRMED BY CODE. `docs/ARCHITECTURE.md` and `docs/ROADMAP.md` were last touched on 2026-09-28 (`8de3144` touched the architecture only to add §14). They do not mention the Worker, D1, the recovery agent or Spotify. The README's "Known limitations" and deployment sections describe the earlier cross-origin plan.
- **Fix (PROPOSED):** replace them with the two documents produced by this review plus a short `docs/DEPLOYMENT.md`.
- **Effort:** S.

### Smaller confirmed items (Low)
- **F-32:** `GET /api/recovery` does 1 + 2N D1 queries and returns every item, with no pagination (`build-worker.mjs:439-441`).
- **F-33:** The Worker's `normalise` and `recoveryTokens` drop non-ASCII. For a fully non-Latin title and artist, both normalise to `''`, so `includes('')` makes the MusicBrainz release-group artist check pass trivially (`build-worker.mjs:195-197, 409-416`).
- **F-34:** `PATCH /api/recovery/:id` allows any status transition, including `recovered` with no file (`:499-510`).
- **F-35:** The service worker image cache is `CacheFirst` for *all* images, including opaque cross-origin Spotify, Apple and CAA previews (these are quota-heavy in Chromium). Cover URLs include the auth token in the cache key (`vite.config.ts:25-29`).
- **F-36:** The agent maps every exception to HTTP 400 (`index.mjs:549-552`), so the Worker cannot tell a bad request from an internal fault.
- **F-37:** The YouTube scorer treats "live" as unwanted only when the wanted title lacks the literal word "live" (`build-worker.mjs:167`), but checks other variants against the same field. That is inconsistent with the catalogue matcher.

### F-38 · Medium · Reliability — Pipeline states are conflated (downloaded / validated / imported / scanned / playable)
- **Evidence:** CONFIRMED BY CODE. The item states are `missing, candidate-found, importing, queued, downloading, recovered, needs-upgrade, failed` (`src/lib/recovery.ts:1`). After the agent's import returns, the item jumps straight to `needs-upgrade`. Tomify never calls Navidrome `startScan`/`getScanStatus` (grep finds no callers) and never checks that the imported track is visible (search by path, title or MBID).
- **Fix (PROPOSED):** split `job.phase` (`queued → downloading → downloaded → validating → importing → imported`) from `library.visibility` (`pending-scan → indexed (navidromeId) → playable`), and from `quality.tier`. After import, the Worker triggers `startScan` (it needs an admin account, or rely on the watcher) and then polls for the track. Only then does the UI say "Ready to play".
- **Effort:** M.

---

## Deliverable 4 — Product improvements

Complexity and risk are rated S/M/L and Low/Med/High.

### 1. Reliability / bugs
| Proposal | What changes | Why / benefit | Cx | Risk | Deps |
| --- | --- | --- | --- | --- | --- |
| SW denylist + real API 404s | workbox config; Worker fallback | Unbreaks Spotify connect; stops future `/api` navigation hijacks | S | Low | — |
| Agent-owned job runner | Background loop; read-only status; per-job lock; persisted phases | Imports happen without a browser; no double imports | M | Med | — |
| Crash-safe import manifest | Planned/committed file list per job; resume/rollback at startup | No orphans after restart or deploy | M | Med | job runner |
| Lost-downloader timeout + cancel | `downloader-lost` state; cancel removes SAB job | No permanently stuck items | S | Low | — |
| Atomic commits | Rename staged files into place | No half-files indexed | S | Low | — |

### 2. Architecture / maintainability
| Proposal | What changes | Why / benefit | Cx | Risk | Deps |
| --- | --- | --- | --- | --- | --- |
| Real Worker module + static assets | `worker/` TypeScript, Wrangler bundling, `[assets]` | Types, lint and tests for the API; smaller deploys | L | Med | CI |
| `shared/` pure modules | Normalisation, matching, quality, path naming | One tested implementation for browser, Worker and agent | M | Low | — |
| Migrations as source of truth | Numbered SQL plus `wrangler d1 migrations apply`; drop runtime DDL | Faster requests; real constraints | M | Med | backup D1 first |
| Versioned agent contract | `contract` integer plus SHA on both sides; Worker compatibility gate | Ends silent skew | M | Low | — |
| Config, not constants | `NAVIDROME_ORIGIN`, `APP_ORIGIN` env | Staging possible; no hairpin | S | Low | — |

### 3. Library intelligence
| Proposal | What changes | Why / benefit | Cx | Risk | Deps |
| --- | --- | --- | --- | --- | --- |
| Library inventory | Agent read-only scan of `/srv/music` and `/srv/music-recovery`: path, size, mtime, probe, tags, sha256 (lazily), sidecar link → SQLite in the agent state dir; summary pushed to D1 | Ground truth for every integrity feature | L | Low (read-only) | job runner |
| Health dashboard | Duplicates (exact hash / same recording / case-only directories), partial albums, orphaned sidecars and `.tomify-source` files, unsupported formats, missing artwork, D1 rows with missing files | The headline "more than a skin" feature | M | Low | inventory |
| Album completeness | Compare each album with its MusicBrainz release tracklist; "Flood: 1/19 (recovery)" | Drives bulk recovery | M | Low | inventory, MBIDs |
| Supervised promotion | Explicit "promote recovery → master" that moves the file, rewrites tags, records provenance and re-links playlists | Clear master/recovery boundary with a sanctioned path across it | M | Med | inventory, F-21 |

### 4. Metadata
| Proposal | What changes | Why / benefit | Cx | Risk | Deps |
| --- | --- | --- | --- | --- | --- |
| Album-level metadata review | Review a release once (tracklist, artwork, date, album artist) and apply it to all tracks | Consistent albums; fixes per-track artwork drift | M | Low | — |
| Precedence policy doc + code | MusicBrainz > reviewed manual > embedded tags > filename, per field | Stops release imports overriding canonical data | S | Low | shared module |
| One cover per release | Choose a release cover once; never overwrite silently | No artwork flip-flop | S | Low | — |

### 5. Recovery
| Proposal | What changes | Why / benefit | Cx | Risk | Deps |
| --- | --- | --- | --- | --- | --- |
| Duplicate preflight | "Already have 1 of 19 in recovery and 0 in master" before acquiring | Prevents duplicates | M | Low | inventory |
| Release-to-tracklist mapping | Map files to MusicBrainz tracks; opt-in extras | Correct full-album imports | L | Med | album review |
| Bulk recovery from a gap list | Acquire a whole missing album (or a playlist's missing tracks grouped by album) as one release job | Turns 19 manual jobs into 1 | M | Med | completeness |
| Quality tiers + preferences | `lossless`/`transparent`/`good`/`low`; target per user | Truthful upgrade suggestions | M | Low | shared module |
| Recovery history / audit | Read-only timeline per item from sidecars and job files | Trust and debuggability | S | Low | — |

### 6. Playback
| Proposal | What changes | Why / benefit | Cx | Risk | Deps |
| --- | --- | --- | --- | --- | --- |
| Offline downloads v1 | IndexedDB/Cache API store per track, the `sourceResolver` path, transcoded "high/normal" via Navidrome `stream?format=` | README's stated core goal | L | Med | — |
| Star / unstar, playlist edit | `star`/`unstar`, `createPlaylist`/`updatePlaylist` | Removes dead-end read-only screens | S–M | Low | — |
| Quieter live sync | Adaptive polling, deltas | Cost and battery | S | Low | — |
| LAN-direct streaming | Prefer LAN Navidrome for streams when reachable | Works without the internet at home | M | Med | — |

### 7. UX
| Proposal | What changes | Why / benefit | Cx | Risk | Deps |
| --- | --- | --- | --- | --- | --- |
| Mobile Library tab | Reachable Playlists, Downloads, Settings | Basic navigation | S | Low | — |
| Recovery language | Show "Downloading → Importing → Waiting for library scan → Ready"; hide codec jargon behind "Details" | Less technical; honest progress | S | Low | F-38 |
| Albums paging + source badges | Full library, a "Recovery" badge on variants | Correct counts; visible duplicates | S | Low | — |
| Accessibility pass | Labelled controls, focus order in Recovery and Player, `role="tablist"` semantics | Currently sparse (`aria-` used 5× in Player, 2× in Recovery) | S | Low | — |

### 8. Infrastructure
| Proposal | What changes | Why / benefit | Cx | Risk | Deps |
| --- | --- | --- | --- | --- | --- |
| CI | Lint, typecheck, test, build, `sw.js` assertion, Worker route tests | Catch regressions before Cloudflare deploys them | S | Low | — |
| One release script | Tag → Worker deploy (with D1 migrations) → agent rsync plus restart → version check | Ends skew | M | Low | versioning |
| Backups | Nightly `wrangler d1 export`; agent state dir and sidecars in the server backup | D1 holds the only copy of playlists and recovery state | S | Low | — |
| Health and monitoring | Agent `/v1/status` with queue depth, disk free, last job error; Worker `/api/version`; one external uptime check | Know when recovery silently stops | S | Low | — |

---

## Deliverable 7 — Architectural direction

**Is it fundamentally sound?** Yes. Keep the three-part shape:

1. **Navidrome** as the library, index and streaming engine. Nothing found justifies replacing it.
2. **A Cloudflare Worker + D1** as the thin, authenticated "Tomify brain" for user-facing state (playlists overlay, recovery queue, release metadata, live playback) and catalogue integrations that need public egress (Spotify, MusicBrainz, artwork lookups).
3. **A media-server agent** for everything that touches files or binaries.

The split matches the constraints: the Worker can't run ffmpeg, and the home server shouldn't hold OAuth or catalogue logic.

**What should change**
- **Move responsibility for long-running work to the agent.** Today the browser, through the Worker, drives the agent's state machine by polling. Invert that: the agent owns jobs and advances them on its own. The Worker *reads* job state (or the agent pushes it to a Worker endpoint). The browser just displays it. This one change fixes F-02, F-03, F-05 and F-06.
- **Make the agent the owner of library truth.** It is the only component that can see files, so it should run the inventory scan and serve the health reports. D1 stores user decisions and summaries, not file truth.
- **Turn the Worker into normal code** (F-16) and add a versioned contract (F-17). That is the largest maintainability gain and the precondition for testing the API.
- **Have one source for shared logic** (F-20), with schema owned by migrations (F-15).

**What should remain**
- The recovery safety model: originals kept, stream-copy derivatives, sidecars, EXCL writes, realpath containment, explicit authorisation, separate recovery root. It is good. Extend it; don't rewrite it.
- The Subsonic client in the browser for library browsing and playback.
- D1 for small per-user state.

**Least disruptive path**
1. Phase 0: fixes that touch only a few lines (SW denylist, agent token guard, lost-job timeout, poll chaining).
2. Add versioning and CI *before* the refactors, so the refactors are protected.
3. Move the Worker string into a real module **without behaviour change**, then convert route groups one at a time, adding route tests as each moves.
4. Add the agent job runner behind the same `/v1` contract (bump `contract`). Keep the existing poll endpoint working as a read-only view during the transition.
5. Build the inventory read-only first, then the health views. Only after that, add supervised write operations (merge directories, promote, dedupe).

**Release process (prevents version skew).** PROPOSED; all steps are cheap.
1. Make the deployable unit a git tag `vYYYY.MM.DD-N` on `feat/phase-1-pwa` (later `main`).
2. CI on the tag: lint, typecheck, tests, build. The Worker is built with `TOMIFY_VERSION=<tag>` and `TOMIFY_CONTRACT=<n>`. A tarball `recovery-agent-<tag>.tgz` is attached to a GitHub Release, containing `VERSION` and `CONTRACT` files.
3. Deploy order for a contract change: **agent first** (it must accept old and new requests for one release), then **Worker** (`wrangler d1 migrations apply` before `wrangler deploy`).
4. `scripts/deploy-agent.sh <tag>` on `tomify` does the following:
   - Download the tarball.
   - Unpack it to `/opt/tomify/recovery-agent-<tag>`.
   - Swap the `/opt/tomify/recovery-agent` symlink atomically.
   - Run `systemctl restart tomify-recovery`.
   - Run `curl -sf 127.0.0.1:8788/health | grep <tag>`.
   - Rollback is the same symlink swap back.
5. The Worker checks `/v1/status.contract`. On mismatch it disables acquisition with a clear banner. Settings shows "App v… · Agent v… · Contract ✓".
6. Before any migration: `wrangler d1 export tomify-metadata --output backups/d1-<date>.sql`.

**Evolution over the next phases.** Stabilise the pipeline (Phase 0–1), then make Tomify *know* the library (inventory, health, completeness: Phase 2), then make recovery *album-aware and preference-driven* (Phase 2–3), then add offline playback and family features (Phase 3).

---

The roadmap (Deliverable 5), the top 20 tasks (Deliverable 6) and the final summary are in [`TOMIFY_ROADMAP.md`](TOMIFY_ROADMAP.md).

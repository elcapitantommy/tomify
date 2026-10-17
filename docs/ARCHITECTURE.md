# Tomify Architecture

This describes Tomify as it is built on `main` today. For what is planned next, see [ROADMAP.md](ROADMAP.md) and [TOMIFY_ROADMAP.md](TOMIFY_ROADMAP.md).

## 1. Overview

Tomify has three running parts:

1. **The PWA**, a React app that runs in the browser and talks to Navidrome and to the Worker.
2. **The Cloudflare Worker**, which serves the PWA, proxies Navidrome, and owns Tomify's own data in D1.
3. **The Debian media server** (host `tomify`), which runs Navidrome, the music library under `/srv/music`, and the recovery agent.

```text
 Browser / installed PWA
        │  HTTPS
        ▼
 Cloudflare Worker (dist/server/index.js) ──────────── D1: tomify-metadata
   ├── Workers Static Assets (dist/client/)
   ├── /navidrome/*  ── proxy ──┐
   ├── /api/*        Tomify API │
   │                            │ Cloudflare Tunnel (cloudflared)
   │   RECOVERY_AGENT_URL ──────┼──────────────────────────────┐
   │                            ▼                              ▼
   │                  Debian box "tomify"
   │                   ├── Navidrome  ── reads /srv/music (incl. /srv/music/_Recovery)
   │                   └── recovery agent (Node, 127.0.0.1:8788)
   │                         ├── yt-dlp, Internet Archive
   │                         ├── SABnzbd / NZBGet (Usenet)
   │                         ├── qBittorrent-nox (torrents, over NordVPN)
   │                         └── ffprobe / ffmpeg → writes /srv/music-recovery
   └── external APIs: MusicBrainz, Spotify, Apple, Deezer, Cover Art Archive
```

Navidrome stays the source of truth for accounts, the library, playlists, favourites, artwork and audio streams. Tomify adds what Navidrome lacks (recovery, Spotify playlist import, release metadata, artwork overrides, playlist sharing, live playback) and keeps that in D1.

## 2. The PWA

- React 18, TypeScript and Vite, under `src/`. Routes are declared in `src/App.tsx`: Home, Artists, Albums, Search, Playlists (including Spotify import and imported playlists), Favourites, Downloads, Recovery and Settings.
- `src/lib/navidrome.ts` is the single typed OpenSubsonic client. Signing in creates a salted token (`createAuthSession`); the password is never stored. When the server is the default (`https://tomify.tomdixon.uk`), requests go through the Worker's same-origin `/navidrome` proxy, which avoids CORS.
- Calls to Tomify's own API (`src/lib/recovery-api.ts`, `catalogue-api.ts`, `completeness-api.ts`, `playlist-shares.ts` and the stores) send the Navidrome username, token and salt as `x-tomify-user`, `x-tomify-token` and `x-tomify-salt` headers.
- State lives in Zustand stores under `src/stores/`: auth, the player and queue, live playback, album artwork overrides and release metadata.
- `src/components/PlayerRuntime.tsx` owns one long-lived `<audio>` element. `src/lib/mediaSession.ts` sets lock-screen metadata and controls. `src/lib/sourceResolver.ts` is the seam for offline audio; today it always streams from Navidrome.
- `src/components/LivePlaybackSync.tsx` publishes this device's playback state to the Worker and picks up commands from the user's other devices.
- The service worker (Workbox via `vite-plugin-pwa`, configured in `vite.config.ts`) precaches the app shell and caches artwork. Its navigation fallback excludes `/api/` and `/navidrome/`. Audio is not cached.
- Styles are one global stylesheet, `src/styles.css`.
- Recovery and Settings are shown only to Navidrome administrators (`adminRole`). On mobile they sit behind the account button in the top bar.

## 3. The Cloudflare Worker

The Worker is a normal TypeScript module rooted at `worker/index.ts`. `pnpm build`:

1. generates `worker/generated/build-info.ts` with the current git SHA and agent contract;
2. typechecks both the app and Worker, then writes the Vite client build to `dist/client/`;
3. asks Wrangler to bundle `worker/index.ts` unminified into `dist/server/index.js` for the route and D1 SQL tests. Deployment bundles the same entry point with minification enabled.

Wrangler deploys those as separate surfaces. Workers Static Assets serves `dist/client/`, applies the cache policy in `public/_headers`, and provides SPA fallback. The `run_worker_first` rules send `/api*` and `/navidrome*` to the Worker before asset lookup. If a non-route request reaches the Worker, it delegates to the `ASSETS` binding.

| Module | Routes | Purpose |
| --- | --- | --- |
| `worker/routes/recovery.ts`, `worker/lib/agent.ts` | `/api/recovery*` | Recovery routes and the recovery-agent client |
| `worker/routes/catalogue.ts` (+ shared `scripts/catalogue-import.mjs`) | `/api/catalogue-auth/spotify/*`, `/api/catalogue-imports/spotify/analyse`, `/api/catalogue-playlists*` | Spotify OAuth, playlist import and matching |
| `worker/routes/release-metadata.ts` | `/api/release-meta*`, `/api/album-completeness/*` | Release metadata, MusicBrainz tracklists and "add missing to Recovery" |
| `worker/routes/album-artwork.ts` | `/api/album-artwork*` | Apple, Deezer and Spotify artwork lookup, overrides and uploads |
| `worker/routes/playlists.ts` | `/api/playlist-shares*` | Sharing playlists between Tomify accounts |
| `worker/routes/live-playback.ts` | `/api/live-playback*` | Cross-device playback state and commands |
| `worker/routes/inventory.ts`, `worker/routes/system-settings.ts` | `/api/inventory*`, `/api/library-health*`, `/api/system*`, quality, scan and preflight routes | Administrative library and server operations |
| `worker/routes/navidrome.ts`, `worker/routes/version.ts` | `/navidrome/*`, `/api/version` | Navidrome proxy and deployed version information |
| `scripts/recovery-metadata.mjs`, `scripts/recovery-artwork.mjs` | (helpers) | MusicBrainz metadata review and artwork resolution for Recovery |

Unknown `/api/*` paths return a JSON `404`. Cloudflare's Static Assets configuration falls back to `index.html` for client-side routes.

### Authentication and admin-only routes

- `authenticate()` checks the `x-tomify-*` headers by calling Navidrome's `ping.view` and caches a success for 30 seconds.
- `isNavidromeAdmin()` calls Navidrome's `getUser.view` and requires `adminRole: true`. It guards:
  - every `/api/recovery` route;
  - `/api/system/reboot` and `/api/system/vpn`;
  - `/api/album-completeness/*`;
  - album artwork lookups, uploads and changes;
  - release metadata edits and MusicBrainz refreshes;
  - Spotify imports that ask to create Recovery items.

  Everyone else gets `403`.
- `/api/album-artwork/image/<id>` serves uploaded covers without sign-in, because `<img>` tags cannot send the headers; the id is random.

### The Navidrome proxy

`/navidrome/*` is forwarded to `NAVIDROME_ORIGIN` with the same method, query string and body, minus the `host` and `origin` headers. The same validated origin is used for the Worker's session, administrator, library-scan and playlist lookups. It must be HTTPS; missing or invalid configuration fails closed with `503 navidrome-unavailable`.

### Configuration

`wrangler.toml` owns the D1 and assets bindings and the non-secret `NAVIDROME_ORIGIN` production default. The other Worker variables and all Worker secrets are set in the Cloudflare dashboard; secret values must never be committed or copied into documentation. Build-time constants are generated rather than configured as Worker bindings.

<!-- worker-configuration:start -->
| Name | Kind | Required or optional | Default | What reads it | What happens when it is missing |
| --- | --- | --- | --- | --- | --- |
| `TOMIFY_DB` | D1 binding (`wrangler.toml`) | Required | `tomify-metadata` | All routes that persist Tomify data | The affected route returns its existing store-unavailable `503`. |
| `ASSETS` | Assets binding (`wrangler.toml`) | Required in production | `./dist/client` | `worker/index.ts` for non-API requests | API routes still run, but unmatched frontend requests return `404`. |
| `NAVIDROME_ORIGIN` | Var (`wrangler.toml`) | Required | `https://tomify.tomdixon.uk` | Authentication, admin checks, library scans, playlist ownership and `/navidrome/*` proxying | The route returns `503 navidrome-unavailable`; no fallback host is contacted. |
| `RECOVERY_AGENT_URL` | Dashboard var | Optional | None | `worker/lib/agent.ts` and Recovery availability | Agent-backed operations report not configured or unavailable. |
| `RECOVERY_AGENT_TOKEN` | Dashboard secret | Optional only when the agent is absent | None | `worker/lib/agent.ts` bearer authentication | Agent requests omit `Authorization`; a protected agent rejects them. |
| `SPOTIFY_CLIENT_ID` | Dashboard var | Optional | None | Spotify OAuth, catalogue import and artwork search | Spotify connection/import is not configured; Spotify artwork lookup is skipped. |
| `SPOTIFY_CLIENT_SECRET` | Dashboard secret | Optional | None | Spotify token exchange and app-level artwork search | Same as a missing client id. |
| `SPOTIFY_REDIRECT_URI` | Dashboard var | Optional | Same-origin `/api/catalogue-auth/spotify/callback` | Spotify OAuth | The request origin supplies the callback URL. |
| `SPOTIFY_TOKEN_ENCRYPTION_KEY` | Dashboard secret | Optional | None | Encrypting stored Spotify user tokens | Spotify OAuth/import is reported as not configured. |
| `SPOTIFY_MARKET` | Dashboard var | Optional | `GB` | Spotify catalogue and artwork searches | Searches use the UK market. |
| `SPOTIFY_ARTWORK_EMBEDDING_ENABLED` | Dashboard var | Optional | `false` | Album-artwork and Recovery artwork selection | Spotify results may be shown but cannot be selected for acquisition. |
| `APPLE_CATALOGUE_COUNTRY` | Dashboard var | Optional | `GB` | Apple catalogue artwork searches | Searches use the UK catalogue. |
| `APPLE_ARTWORK_EMBEDDING_ENABLED` | Dashboard var | Optional | `false` | Album-artwork and Recovery artwork selection | Apple results may be shown but cannot be selected for acquisition. |
| `ANTHROPIC_API_KEY` | Dashboard secret | Optional | None | `worker/features/mix-curator.ts` (Claude picks and names the Home "Made for you" mixes) | Tomify builds simpler mixes itself from the same listening data. |
| `TOMIFY_MIXES_MODEL` | Dashboard var | Optional | `claude-sonnet-5-5` | `worker/features/mix-curator.ts` | Mixes use Claude Sonnet 5.5. |
| `TOMIFY_VERSION` | Build-time constant | Required, generated | Current Git short SHA; then `CF_PAGES_COMMIT_SHA`; then `WORKERS_CI_COMMIT_SHA`; then `unknown` | `/api/version` | Reports `unknown` only when Git and both CI fallbacks are unavailable. |
| `TOMIFY_AGENT_CONTRACT` | Build-time constant | Required, generated | `2` | `/api/version` and the recovery-agent compatibility gate | Build generation supplies it; a missing generated module fails the build. |
| `WORKERS_CI_COMMIT_SHA` | Build-time constant input | Optional | None | `scripts/build-worker-info.mjs` final SHA fallback | `unknown` is used when Git and `CF_PAGES_COMMIT_SHA` are also unavailable. |
| `CF_PAGES_COMMIT_SHA` | Build-time constant input | Optional | None | `scripts/build-worker-info.mjs` first SHA fallback | `WORKERS_CI_COMMIT_SHA`, then `unknown`, is used when Git is unavailable. |
| `VITE_NAVIDROME_URL` | Frontend build-time var | Optional | `https://tomify.tomdixon.uk` | Login's initial server value | Login uses the existing frontend default. |
<!-- worker-configuration:end -->

`VITE_NAVIDROME_URL` and `src/lib/navidrome.ts`'s `DEFAULT_NAVIDROME_SERVER` deliberately remain separate from `NAVIDROME_ORIGIN`. Existing signed-in sessions store their chosen frontend server, and `requestServerUrl` maps that production server to the same-origin `/navidrome` proxy. Changing either frontend value as part of this server configuration would sign users out or bypass that mapping.

## 4. D1 database (`tomify-metadata`)

Migrations live in `drizzle/`:

| Migration | Tables / changes |
| --- | --- |
| `0001_recovery.sql` | `recovery_items`, `recovery_candidates` and their indexes |
| `0002_recovery_metadata.sql` | `recovery_items.metadata_resolution_json` |
| `0003_recovery_artwork.sql` | `recovery_items.artwork_resolution_json` |
| `0004_catalogue_playlists.sql` | `recovery_items.source_json`; `catalogue_playlists`, `catalogue_playlist_items`, `catalogue_oauth_states`, `catalogue_provider_tokens` |
| `0005_release_tracklists.sql` | `release_tracklists` (MusicBrainz tracklists for completeness) |
| `0006_album_artwork.sql` | `album_artwork` (per-album artwork overrides) |
| `0007_playlist_shares.sql` | `playlist_shares`, `tomify_accounts` |
| `0008_album_artwork_uploads.sql` | `album_artwork_uploads` (uploaded covers, base64) |
| `0009_live_playback.sql` | `live_playback`, `live_playback_devices` |
| `0010_quality_settings.sql` | `tomify_settings` (site-wide settings such as the quality target) |
| `0011_recovery_playback.sql` | `recovery_items.playback_json` |
| `0012_schema_catch_up.sql` | `release_metadata`; every other table again with `IF NOT EXISTS`; indexes for the Recovery list, uploads, shares and OAuth state expiry |
| `0013_library_health_dismissals.sql` | `library_health_dismissals` (Library health findings marked as fine) |
| `0014_listening_and_mixes.sql` | `listening_events` (Tomify's own play history, kept 400 days), `made_for_you` (each account's current mixes) |

The migrations are the only source of the schema: `pnpm run deploy` applies new ones before deploying the Worker, and the Worker runs no DDL. A query against a table no migration has created gets a 503 `schema-out-of-date`. Production was baselined with `scripts/d1-baseline.sh`; see [D1 migrations](RECOVERY.md#d1-migrations).

Spotify OAuth tokens are stored encrypted with `SPOTIFY_TOKEN_ENCRYPTION_KEY`. No audio is ever stored in D1.

## 5. The recovery agent

`recovery-agent/` is a small Node.js HTTP service that runs on the Debian box as the `tomify-recovery` systemd unit (`tomify-recovery.service.example`). It is deployed by copying the files to `/opt/tomify/recovery-agent`, separately from the Worker. See [RECOVERY.md](RECOVERY.md#updating-the-recovery-agent).

- It listens on `127.0.0.1:8788`. A Cloudflare Tunnel run by the `tomify-recovery-cloudflared` Docker container exposes it at `RECOVERY_AGENT_URL`; the Worker never connects to the box directly.
- `GET /health` is unauthenticated. Every `/v1/*` endpoint requires `Authorization: Bearer $TOMIFY_RECOVERY_TOKEN`, and the agent refuses to start without a token of at least 32 characters (`config.mjs`).
- Endpoints: `/v1/status`, `/v1/search`, `/v1/acquire`, `/v1/jobs/status`, `/v1/jobs/cancel`, `/v1/jobs/import-remaining`, `/v1/delete`, `/v1/system/vpn/status`, `/v1/system/vpn`, `/v1/system/reboot`. The full contract is in [RECOVERY.md](RECOVERY.md#backend-contract).

| Backend | Code | How it acquires |
| --- | --- | --- |
| YouTube | `youtube.mjs` | `yt-dlp`, anonymous or with an optional cookie file; synchronous |
| Internet Archive | `internet-archive.mjs` | Public Advanced Search and Metadata APIs; synchronous |
| Usenet | `usenet.mjs`, `usenet-job.mjs`, `usenet-import.mjs` | NZBIndex or Newznab search, downloaded by SABnzbd or NZBGet; asynchronous job |
| Torrents | `torrent.mjs` | qBittorrent search plugins or a pasted link, downloaded by qBittorrent-nox over NordVPN; asynchronous job |

Usenet and torrent jobs are stored under the state directory (`TOMIFY_RECOVERY_STATE_DIR`, `/var/lib/tomify-recovery` on the box) and advanced when the Worker polls `/v1/jobs/status`; one in-process lock per job stops two polls importing the same download.

Every import:

1. probes the source with `ffprobe`;
2. keeps the original under a hidden `.tomify-source` folder;
3. writes a tagged `ffmpeg` stream-copy derivative and a `.tomify.json` provenance sidecar;
4. writes `cover.jpg` when artwork was chosen.

`metadata.mjs`, `derivative.mjs` and `artwork.mjs` hold that logic. `deletion.mjs` removes only files inside the recovery directory. `system.mjs` and `vpn.mjs` back the reboot and NordVPN controls, which are off unless `TOMIFY_RECOVERY_ALLOW_REBOOT` / `TOMIFY_RECOVERY_ALLOW_VPN_CONTROL` are `true`.

Configuration comes from `/etc/tomify/recovery-agent.env` (see `recovery-agent.env.example`).

## 6. Storage on the media server

| Path | What it holds |
| --- | --- |
| `/srv/music` | The library SSD and Navidrome's music folder (`TOMIFY_MASTER_DIR`). The agent never writes here directly. |
| `/srv/music/_Recovery` | Recovered files, on the same SSD, so Navidrome shows them alongside the masters |
| `/srv/music-recovery` | Bind mount of `/srv/music/_Recovery`; the only place the agent writes audio (`TOMIFY_RECOVERY_DIR`) |
| `/srv/usenet/completed` | Finished SABnzbd downloads, read-only to the agent |
| `/srv/torrents` | In-progress torrent downloads on the NVMe disk, removed after import |
| `/var/lib/tomify-recovery` | Agent state, including job records |
| `/var/cache/tomify-recovery` | Agent cache |
| `/opt/tomify/recovery-agent` | Deployed agent code |
| `/etc/tomify/recovery-agent.env` | Agent configuration and token |

See [RECOVERY.md](RECOVERY.md#recovery-files-on-the-library-ssd) for the `fstab` entries.

## 7. Build, test and deploy

- Install: `npx -y pnpm@11 install --frozen-lockfile`.
- Check: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
- Tests:
  - vitest for `src/**/*.test.ts(x)`;
  - `node --test` for `recovery-agent/*.node-test.mjs` and `scripts/*.node-test.mjs`;
  - Worker routes are tested against Wrangler's unminified bundle in `scripts/build-routing.node-test.mjs`; the D1 migration test scans that same real bundle so every SQL literal is checked against the migrated schema.
- Cloudflare's unchanged `pnpm build` command produces `dist/client/` and `dist/server/index.js`. The unchanged `npx pnpm run deploy` command applies D1 migrations, uploads the static assets and deploys the Worker according to `wrangler.toml`.
- The recovery agent is copied to the box by hand after any change under `recovery-agent/` ([RECOVERY.md](RECOVERY.md#updating-the-recovery-agent)).

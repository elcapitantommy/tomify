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
   ├── static PWA assets (embedded in the bundle)
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

The Worker is generated, not hand-written. `pnpm build` runs `tsc -b`, `vite build`, then `node scripts/build-worker.mjs`, which:

1. reads every file in `dist/` and embeds it base64-encoded in an `assets` map;
2. concatenates the source of each feature module (exported as a `...WorkerSource` string built from `fn.toString()`);
3. writes the whole Worker as one string template to `dist/server/index.js`, which `wrangler.toml` deploys.

| Module | Routes | Purpose |
| --- | --- | --- |
| `scripts/build-worker.mjs` | `/api/recovery*`, `/api/system/reboot`, `/api/system/vpn`, `/api/live-playback*`, `/api/release-meta*`, `/navidrome/*`, static assets | Core routes, auth, the Navidrome proxy and the agent client |
| `scripts/catalogue-worker.mjs` (+ `catalogue-import.mjs`) | `/api/catalogue-auth/spotify/*`, `/api/catalogue-imports/spotify/analyse`, `/api/catalogue-playlists*` | Spotify OAuth, playlist import and matching |
| `scripts/completeness-worker.mjs` | `/api/album-completeness/*` | MusicBrainz tracklists and "add missing to Recovery" |
| `scripts/album-artwork-worker.mjs` | `/api/album-artwork*` | Apple, Deezer and Spotify artwork lookup, overrides and uploads |
| `scripts/playlist-share-worker.mjs` | `/api/playlist-shares*` | Sharing playlists between Tomify accounts |
| `scripts/recovery-metadata.mjs`, `scripts/recovery-artwork.mjs` | (helpers) | MusicBrainz metadata review and artwork resolution for Recovery |

Unknown `/api/*` paths return a JSON `404`. Any other `GET` that accepts HTML falls back to `index.html` so client-side routes work.

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

`/navidrome/*` is forwarded to `https://tomify.tomdixon.uk` with the same method, query string and body, minus the `host` and `origin` headers. The upstream origin is currently hard-coded in the Worker.

### Configuration

Set as Worker variables or secrets: `RECOVERY_AGENT_URL`, `RECOVERY_AGENT_TOKEN`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REDIRECT_URI`, `SPOTIFY_TOKEN_ENCRYPTION_KEY`, `SPOTIFY_MARKET`, `APPLE_CATALOGUE_COUNTRY`, `APPLE_ARTWORK_EMBEDDING_ENABLED` and `SPOTIFY_ARTWORK_EMBEDDING_ENABLED`. The D1 database is bound as `TOMIFY_DB`.

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
  - Worker routes are tested against the built bundle in `scripts/build-routing.node-test.mjs`.
- Cloudflare builds the site from this repository and deploys `dist/server/index.js` as the Worker (`wrangler.toml`). D1 migrations in `drizzle/` are applied separately with `wrangler d1`.
- The recovery agent is copied to the box by hand after any change under `recovery-agent/` ([RECOVERY.md](RECOVERY.md#updating-the-recovery-agent)).

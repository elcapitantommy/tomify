# Tomify Architecture

This describes Tomify as it is built on `main` today. For what is planned next, see [ROADMAP.md](ROADMAP.md) and [TOMIFY_ROADMAP.md](TOMIFY_ROADMAP.md).

## 1. Overview

Tomify has three running parts (plus TomTube, an optional fourth described in [TOMTUBE.md](TOMTUBE.md)):

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

- Tomifin Downloader is a separate app at its own address (`TOMIFIN_HOSTNAME`, a second Custom Domain on the same Worker), built from `tomifin/index.html` and `src/tomifin/` as another Vite entry point. It shares none of Tomify's shell or sign-in: Jellyfin administrators sign in through the recovery agent (`recovery-agent/jellyfin.mjs`), and the session is an HttpOnly cookie; see [TOMIFIN.md](TOMIFIN.md).
- TomTube is a third Vite entry point (`tomtube/index.html`, `src/tomtube/`) served at `/tomtube/` on Tomify's own address, installed as its own home-screen app. It signs in with the same Navidrome account and requires the same media tokens (`TOMIFY_MEDIA_KEY`) for every media URL; see [TOMTUBE.md](TOMTUBE.md).
- React 18, TypeScript and Vite, under `src/`. Routes are declared in `src/App.tsx`: Home, Artists, Albums, Search, Playlists (including Spotify import and imported playlists), Favourites, Downloads, Recovery and Settings.
- `src/lib/navidrome.ts` is the single typed OpenSubsonic client. Signing in creates a salted token (`createAuthSession`); the password is never stored. When the server is the default (`https://tomify.tomdixon.uk`), requests go through the Worker's same-origin `/navidrome` proxy, which avoids CORS.
- Calls to Tomify's own API (`src/lib/recovery-api.ts`, `catalogue-api.ts`, `completeness-api.ts`, `playlist-shares.ts` and the stores) send the Navidrome username, token and salt as `x-tomify-user`, `x-tomify-token` and `x-tomify-salt` headers.
- State lives in Zustand stores under `src/stores/`: auth, the player and queue, live playback, album artwork overrides and release metadata.
- `src/components/PlayerRuntime.tsx` owns one long-lived `<audio>` element. `src/lib/mediaSession.ts` sets lock-screen metadata and controls. `src/lib/sourceResolver.ts` is the seam for offline audio; today it always streams from Navidrome. `src/lib/mediaRoute.ts` decides where a stream URL points (the Worker, or the box on the home network) and which credential it carries; see [Media sessions and LAN-direct streaming](#media-sessions-and-lan-direct-streaming).
- `src/components/LivePlaybackSync.tsx` publishes this device's playback state to the Worker and picks up commands from the user's other devices.
- The service worker (Workbox via `vite-plugin-pwa`, configured in `vite.config.ts`) precaches the app shell and caches artwork. Its navigation fallback excludes `/api/`, `/navidrome/` and `/tomifin/`, and Tomifin's page is not precached. Audio is not cached.
- Back and Forward return to where you were on a page: `src/hooks/useScrollRestoration.ts` (used by `AppShell`) saves the scroll position per history entry and, on Back, waits for the page's data to load before scrolling back (it gives up after 5 seconds or as soon as the user scrolls). New pages start at the top. The Artists, artist and Albums lists cache their data per user (`useLoad` cache key) so they draw immediately, and the Albums and artist release tabs and sort order live in the URL (`?type=`, `?sort=`) so Back shows the same tab.
- Styles are one global stylesheet, `src/styles.css`. The light theme is generated from it at build time by the Vite plugin in `scripts/light-theme.mjs` (every colour declaration repeated under `:root[data-theme=light]`); `src/stores/theme.ts` and a script in `index.html` set `data-theme` on `<html>`.
- Recovery and Settings are shown only to Navidrome administrators (`adminRole`). On mobile they sit behind the account button in the top bar.

## 3. The Cloudflare Worker

The Worker is a normal TypeScript module rooted at `worker/index.ts`. `pnpm build`:

1. generates `worker/generated/build-info.ts` with the current git SHA and agent contract;
2. typechecks both the app and Worker, then writes the Vite client build to `dist/client/`;
3. asks Wrangler to bundle `worker/index.ts` unminified into `dist/server/index.js` for the route and D1 SQL tests. Deployment bundles the same entry point with minification enabled.

Wrangler deploys those as separate surfaces. Workers Static Assets serves `dist/client/`, applies the cache policy in `public/_headers`, and provides SPA fallback. The `run_worker_first` rules send every path except the hashed `/assets/*` to the Worker before asset lookup, so it can serve Tomifin's address separately. If a non-route request reaches the Worker, it delegates to the `ASSETS` binding.

| Module | Routes | Purpose |
| --- | --- | --- |
| `worker/routes/recovery.ts`, `worker/lib/agent.ts` | `/api/recovery*` | Recovery routes and the recovery-agent client |
| `worker/routes/catalogue.ts` (+ shared `scripts/catalogue-import.mjs`) | `/api/catalogue-auth/spotify/*`, `/api/catalogue-imports/spotify/analyse`, `/api/catalogue-playlists*` | Spotify OAuth, playlist import and matching |
| `worker/routes/release-metadata.ts` | `/api/release-meta*`, `/api/album-completeness/*` | Release metadata, MusicBrainz tracklists and "add missing to Recovery" |
| `worker/routes/album-artwork.ts` | `/api/album-artwork*` | Apple, Deezer and Spotify artwork lookup, overrides and uploads |
| `worker/routes/playlists.ts` | `/api/playlist-shares*` | Sharing playlists between Tomify accounts, and collaborators' edits made as the owner (`POST /api/playlist-shares/navidrome/<id>/songs`) |
| `worker/routes/live-playback.ts` | `/api/live-playback*` | Cross-device playback state and commands |
| `worker/routes/listening.ts`, `worker/routes/smart-playlists.ts` | `/api/listening`, `/api/listening/stats`, `/api/listening/history`, `/api/listening/wrapped`, `/api/smart-playlists*` | Listening history and stats, saved smart-playlist rules |
| `worker/routes/lyrics.ts` (+ `worker/features/lyrics.ts`) | `/api/lyrics` | LRCLIB lyrics for songs Navidrome has none for, saved in D1 |
| `worker/routes/new-releases.ts` (+ `worker/features/new-releases.ts`) | `/api/new-releases`, `/api/new-releases/artists` | New releases from the library's artists: pages send the artist list, the daily cron checks MusicBrainz |
| `worker/routes/push.ts` (+ `worker/features/push.ts`, `worker/lib/web-push.ts`) | `/api/push`, `/api/push/subscription`, `/api/push/test` | Push notification subscriptions; the crons send new-release and Recovery messages |
| `worker/routes/inventory.ts`, `worker/routes/system-settings.ts` | `/api/inventory*`, `/api/library-health*`, `/api/system*`, quality, scan and preflight routes | Administrative library and server operations |
| `worker/routes/navidrome.ts`, `worker/routes/version.ts` | `/navidrome/*`, `/api/version` | Navidrome proxy and deployed version information |
| `worker/routes/hls.ts`, `worker/routes/media-session.ts` (+ `worker/features/media-session.ts`) | `/api/hls/*`, `/api/media-session` | Adaptive streaming through the agent; short-lived media tokens and the LAN address |
| `worker/routes/tomtube.ts` | `/api/tomtube/*`, `/tomtube/*` | TomTube: ad-free YouTube through the TomTube service on the box (a fixed list of paths, signed-in listeners only), and TomTube's page; see [TOMTUBE.md](TOMTUBE.md) |
| `worker/routes/tomifin.ts`, `worker/routes/tomifin-site.ts` | `/api/tomifin/*`; everything on `TOMIFIN_HOSTNAME` | Tomifin Downloader (Jellyfin administrators only): film and TV torrent search and queuing through the recovery agent; see [TOMIFIN.md](TOMIFIN.md) |
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

### Media sessions and LAN-direct streaming

Audio elements cannot send headers either, so stream URLs used to carry the Navidrome login (`u`, `t`, `s`) in the query, where it lasts until the password changes. With `TOMIFY_MEDIA_KEY` set:

- `POST /api/media-session` (normal `x-tomify-*` login) returns `{ token, expiresAt, lanOrigin }`. The token is the login sealed with AES-GCM under `TOMIFY_MEDIA_KEY` (`worker/lib/seal.ts`) with a 4-hour expiry. A token cannot mint another token.
- The player (`src/lib/mediaRoute.ts`) refreshes it at half-life and builds stream and HLS URLs with `mt=<token>` instead of the login (`NavidromeClient.streamUrl` / `hlsUrl`).
- The Worker accepts `mt` on `/navidrome/rest/stream.view` and `/api/hls/*` only, opens it and passes the login on exactly as before. Any other `/navidrome` path with `mt`, or a forged or expired token, gets `401`.
- When `TOMIFY_LAN_ORIGIN` is also set, the player probes `<lanOrigin>/lan/ping` with a 1.5-second timeout (again on network changes, every 5 minutes while it fails, and at each token refresh). If the box answers, the same paths are fetched from the box's LAN listener instead of the Worker, so audio stays on the home network. A LAN stream that fails is retried through the Worker straight away, without counting as an adaptive-streaming failure.
- Without `TOMIFY_MEDIA_KEY` the route answers `404`, and the player keeps the old URLs. Cover-art URLs still carry the login, so the service worker's artwork cache keeps working.

### The Navidrome proxy

`/navidrome/*` is forwarded to `NAVIDROME_ORIGIN` with the same method, query string and body, minus the `host` and `origin` headers. The same validated origin is used for the Worker's session, administrator, library-scan and playlist lookups. It must be HTTPS; missing or invalid configuration fails closed with `503 navidrome-unavailable`.

### Configuration

`wrangler.toml` owns the D1, Workers AI and assets bindings and the non-secret `NAVIDROME_ORIGIN` production default. The other Worker variables and all Worker secrets are set in the Cloudflare dashboard; secret values must never be committed or copied into documentation. Build-time constants are generated rather than configured as Worker bindings.

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
| `TOMIFY_MIXES_MODEL` | Dashboard var | Optional | `claude-sonnet-5-5` | `worker/features/mix-curator.ts` (mixes and the DJ) | Mixes and the DJ use Claude Sonnet 5.5. |
| `AI` | Workers AI binding (`wrangler.toml`) | Optional | Workers AI | `worker/features/dj.ts` (the DJ's voice, Deepgram Aura-2) | The DJ still plays its sets but doesn't speak; `/api/dj/voice` returns `503`. |
| `TOMIFY_DJ_VOICE` | Dashboard var | Optional | `ophelia` | `worker/features/dj.ts` | The Aura-2 voice, used when `TOMIFY_DJ_VOICE_MODEL` is `aura`. |
| `TOMIFY_MEDIA_KEY` | Dashboard secret | Optional | None | `worker/features/media-session.ts` (seals and opens short-lived media tokens); the agent's `TOMIFY_MEDIA_KEY` must be the same value. Also seals party hosts' and collaborative-playlist owners' Navidrome tokens (`worker/features/party.ts`, `worker/features/playlist-share.ts`) | `/api/media-session` returns `404` and stream URLs keep the Navidrome login, as before. Playlists can't be made collaborative. TomTube can't play anything (it accepts only media tokens). |
| `TOMIFY_PARTY_USERNAME` | Dashboard var | Optional | None | `worker/features/party.ts` (a Navidrome account party guests search and see covers with) | Guests search as the host, whose login is stored sealed with `TOMIFY_MEDIA_KEY` while the party runs. Without either, starting a party returns `503`. |
| `TOMIFY_PARTY_PASSWORD` | Dashboard secret | Optional | None | `worker/features/party.ts` (the party account's password; used only with `TOMIFY_PARTY_USERNAME`) | As above. |
| `TOMIFY_LAN_ORIGIN` | `wrangler.toml` var | Optional | None | `worker/routes/media-session.ts` (the box's `https://` address on the home network, for example `https://lan.tomify.tomdixon.uk:8789`) | Players always stream through the Worker. |
| `TOMIFIN_HOSTNAME` | `wrangler.toml` var | Optional | None (set to `tomifin.tomdixon.uk`) | `worker/routes/tomifin-site.ts` (Tomifin Downloader's own address, a second Custom Domain on this Worker) | Tomifin is served at `/tomifin/` on Tomify's address instead. |
| `TOMTUBE_SERVICE_URL` | Dashboard var | Optional | None | `worker/routes/tomtube.ts` (the TomTube service's Cloudflare Tunnel address; see [TOMTUBE.md](TOMTUBE.md)) | `/api/tomtube/*` answers `503 not-configured`; the TomTube page shows that TomTube is not set up. |
| `TOMTUBE_SERVICE_TOKEN` | Dashboard secret | Optional (required with `TOMTUBE_SERVICE_URL`) | None | `worker/routes/tomtube.ts` bearer authentication to the TomTube service; the service's `TOMTUBE_TOKEN` must be the same value | Same as a missing `TOMTUBE_SERVICE_URL`. |
| `TOMTUBE_ALLOWED_USERS` | Dashboard var | Optional | None (every signed-in listener) | `worker/routes/tomtube.ts` (comma-separated Navidrome usernames allowed to use TomTube) | Every signed-in Tomify listener can use TomTube. |
| `TOMIFY_DJ_VOICE_MODEL` | `wrangler.toml` var | Optional | `melotts` (set to `aura`) | `worker/features/dj.ts` | The DJ reads links with MeloTTS, which costs about 8 free neurons a link. Set `aura` to use Aura-2 (about 1,100 a link) first, with MeloTTS as backup. |
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
| `0015_smart_playlists.sql` | `smart_playlists` (each account's saved smart-playlist rules) |
| `0016_lyrics.sql` | `lyrics` (LRCLIB lyrics per song, misses included) |
| `0017_parties.sql` | `parties`, `party_guests`, `party_queue`, `party_votes` (party mode; deleted when a party ends) |
| `0018_listening_wrapped.sql` | `listening_events.genre` (top genres), `listening_years` (each account's saved Wrapped recap per year, written before that year's plays are pruned) |

The migrations are the only source of the schema: `pnpm run deploy` applies new ones before deploying the Worker, and the Worker runs no DDL. A query against a table no migration has created gets a 503 `schema-out-of-date`. Production was baselined with `scripts/d1-baseline.sh`; see [D1 migrations](RECOVERY.md#d1-migrations).

Spotify OAuth tokens are stored encrypted with `SPOTIFY_TOKEN_ENCRYPTION_KEY`. No audio is ever stored in D1.

## 5. The recovery agent

`recovery-agent/` is a small Node.js HTTP service that runs on the Debian box as the `tomify-recovery` systemd unit (`tomify-recovery.service.example`). It is deployed separately from the Worker with `scripts/deploy-agent.ps1`, which installs an immutable release under `/opt/tomify/releases` and switches `/opt/tomify/current` to it. See [DEPLOYMENT.md](DEPLOYMENT.md#updating-the-recovery-agent).

- With `TOMIFY_LAN_PORT`, `TOMIFY_LAN_TLS_CERT`, `TOMIFY_LAN_TLS_KEY` and `TOMIFY_MEDIA_KEY` set, `lan.mjs` also runs an HTTPS listener for players on the home network (LAN-direct streaming): `/lan/ping`, `/navidrome/rest/stream.view` (proxied to Navidrome on the box) and `/api/hls/*` (the same packager as `/v1/hls`). It accepts only media tokens, answers CORS and Private Network Access preflights for `TOMIFY_LAN_ALLOWED_ORIGINS`, and reloads its certificate twice a day. See [DEPLOYMENT.md](DEPLOYMENT.md#lan-direct-streaming).
- It listens on `127.0.0.1:8788`. A Cloudflare Tunnel run by the `tomify-recovery-cloudflared` Docker container exposes it at `RECOVERY_AGENT_URL`; the Worker never connects to the box directly.
- `GET /health` is unauthenticated. Every `/v1/*` endpoint requires `Authorization: Bearer $TOMIFY_RECOVERY_TOKEN`, and the agent refuses to start without a token of at least 32 characters (`config.mjs`).
- Endpoints: `/v1/status`, `/v1/search`, `/v1/acquire`, `/v1/jobs/status`, `/v1/jobs/cancel`, `/v1/jobs/import-remaining`, `/v1/delete`, `/v1/system/vpn/status`, `/v1/system/vpn`, `/v1/system/reboot`, and Tomifin Downloader's `/v1/tomifin/*` (`tomifin.mjs`, sign-in in `jellyfin.mjs`). The full contract is in [RECOVERY.md](RECOVERY.md#backend-contract).

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

`metadata.mjs`, `derivative.mjs` and `artwork.mjs` hold that logic. `deletion.mjs` removes only files inside the recovery directory. `library-moves.mjs` performs the supervised merges and promotions from Library health: journalled renames into `TOMIFY_MASTER_DIR/_Duplicates` that can be undone. `system.mjs` and `vpn.mjs` back the reboot and NordVPN controls, which are off unless `TOMIFY_RECOVERY_ALLOW_REBOOT` / `TOMIFY_RECOVERY_ALLOW_VPN_CONTROL` are `true`.

Configuration comes from `/etc/tomify/recovery-agent.env` (see `recovery-agent.env.example`).

## 6. Storage on the media server

| Path | What it holds |
| --- | --- |
| `/srv/music` | The library SSD and Navidrome's music folder (`TOMIFY_MASTER_DIR`). The agent only writes here for a confirmed merge or promotion from Library health, and only with a `ReadWritePaths=/srv/music` drop-in. |
| `/srv/music/_Recovery` | Recovered files, on the same SSD, so Navidrome shows them alongside the masters |
| `/srv/music-recovery` | Bind mount of `/srv/music/_Recovery`; the only place the agent writes audio (`TOMIFY_RECOVERY_DIR`) |
| `/srv/usenet/completed` | Finished SABnzbd downloads, read-only to the agent |
| `/srv/torrents` | In-progress torrent downloads on the NVMe disk, removed after import |
| `/media/family`, `/media/private` | Jellyfin's Family and Private libraries; Tomifin Downloader's qBittorrent destinations (`TOMIFY_TOMIFIN_FAMILY_DIR`, `TOMIFY_TOMIFIN_PRIVATE_DIR`) |
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
- The recovery agent is deployed with `scripts/deploy-agent.ps1` after any change under `recovery-agent/` or `shared/`. Every deploy step is in [DEPLOYMENT.md](DEPLOYMENT.md).

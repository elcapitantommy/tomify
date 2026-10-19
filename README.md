# Tomify

A self-hosted family music service built around our own CD collection.

The aim is simple: rip the CDs once, keep a lossless master library at home, stream it anywhere, and provide a polished installable web app for Tom and Anna with separate accounts and offline music.

## Goals

- Rip CDs to **FLAC** as the archival/master format.
- Keep one canonical music library on a small Linux media server.
- Use **Navidrome** as the initial music server and streaming engine.
- Give Tom and Anna separate user accounts, favourites, playlists and listening history.
- Build a custom **PWA** front end rather than being tied permanently to Navidrome's supplied UI.
- Allow tracks, albums and playlists to be downloaded to a phone for offline playback.
- Support configurable offline quality so the server can keep FLAC masters while phones store smaller copies.
- Keep the whole system self-hosted, simple to back up, and recoverable without re-ripping the CD collection.

## Proposed shape

```text
CDs
 │
 ▼
Secure ripping / tagging
 │
 ▼
FLAC master library
 │
 ▼
Small Linux server
 ├── Navidrome
 ├── Transcoding
 ├── Metadata / artwork
 └── Backup
        │
        ▼
      HTTPS
        │
        ▼
Custom Tomify PWA
 ├── Tom account
 ├── Anna account
 ├── Streaming
 ├── Playlists / favourites
 ├── Offline downloads
 └── Lock-screen / media controls
```

## Initial technology choices

These are working choices, not sacred cows.

| Area | Initial choice |
| --- | --- |
| Master audio | FLAC |
| CD ripping | Exact Audio Copy or equivalent secure ripper |
| Metadata | MusicBrainz-compatible tagging workflow |
| Server OS | Linux |
| Deployment | Docker Compose |
| Music backend | Navidrome |
| Client API | OpenSubsonic/Subsonic-compatible API |
| Front end | Custom responsive PWA |
| Remote access | HTTPS, with deployment choice documented before exposure |
| Offline storage | Browser/PWA managed local storage |
| Backups | Separate backup of music masters plus application data |

## Principles

1. **The FLAC library is the asset.** Everything else can be rebuilt.
2. **Do not couple the music files to the UI.** Navidrome and Tomify should be replaceable independently.
3. **Streaming and offline playback should use the same library and metadata.**
4. **Offline copies are disposable caches.** The server remains the source of truth.
5. **Start useful, then get sexy.** Navidrome's own UI gets us listening quickly; the custom PWA can replace it incrementally.
6. **No cloud dependency for core playback.** If the internet is down at home, local playback should still work.
7. **Back up before scale.** We do not rip hundreds of CDs twice because we forgot the boring bit.

## MVP

The first usable version is intentionally small:

- Linux host running Docker.
- Navidrome running against a read-only mounted FLAC library.
- Tom and Anna accounts.
- Remote access over HTTPS.
- Reliable ripping/tagging workflow.
- Tested backup and restore.
- Playback from desktop and mobile browsers.

Once that works, the custom Tomify PWA becomes the main development focus.

## Custom PWA target

The PWA should eventually provide:

- Home / recently played / recently added.
- Artists, albums and tracks.
- Search.
- Favourites.
- Personal and shared playlists.
- Persistent player bar.
- Queue management.
- Media Session API integration for lock-screen/headset controls.
- Installable PWA behaviour on supported phones.
- Offline tracks, albums and playlists.
- Download quality selection.
- Offline storage management.
- Clear online/offline state.
- Graceful fallback when the home server is unreachable.

## Offline playback

Tap **Download** on an album or playlist page, or the download button on any track row, and Tomify saves the song to the phone or computer for listening with no connection. The **Downloads** page (in the desktop sidebar, and behind the account button on mobile) lists what is saved with its status (queued, downloading with a percentage, available offline, or failed with the reason), plays it, retries failures and removes it. It shows how much music is stored, the space the browser says is left (`navigator.storage.estimate()`), and whether the browser agreed to keep the downloads (`navigator.storage.persist()`, asked on the first download); without that, the browser may clear them when the device runs low on space.

- **What is saved.** The original file (`stream.view` with `format=raw`, never HLS chunks or a transcode), the song's metadata and its artwork, in IndexedDB (one database per account, `src/lib/offline-db.ts`). Songs download one at a time in the background while Tomify is open, carry on after a reload, and wait while the device is offline. A song in more than one download (a single track and its album, or two playlists) is stored once and kept until nothing includes it.
- **Playing.** Tomify always plays a valid saved copy (its record says it finished and the stored file is the size that was downloaded) instead of streaming, online or not (`LocalFirstSourceResolver` in `src/lib/sourceResolver.ts`). The next song in the queue is pre-loaded from the device too. Anything not downloaded streams as before.
- **Playlists that change.** A playlist edited or reordered after it was downloaded shows **Update download**, which fetches the new songs and lets go of the ones taken out.
- **Running out of space.** If the browser refuses a write for lack of space (iPhone and iPad Safari give a web app far less room than Chrome), or the space left is smaller than the next song, that song and the rest of the queue are marked failed with "Not enough storage space on this device" and nothing half-written is kept. Remove some downloads, then **Retry all**.

There is one quality for now: the original file, so a FLAC album takes its full size. A later **Keep downloaded** mode should keep selected playlists or albums synchronised when the device next has a suitable connection.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how Tomify is built today and [docs/ROADMAP.md](docs/ROADMAP.md) for the roadmap and what is done.

## Non-goals for the first version

- Spotify-style social network.
- Public music sharing.
- Recommendation algorithms.
- Reimplementing a music server before we know we need to.
- DRM.
- Native iOS/Android apps before the PWA has proven insufficient.

## Future ideas

Once the core is solid:

- Smart playlists.
- Shared family playlists.
- Lyrics.
- Artist/album biographies.
- Ratings.
- Listening statistics.
- Chromecast / AirPlay where practical.
- Android Auto / CarPlay options.
- Sonos / Home Assistant integration.
- Automatic library ingest.
- Assisted MusicBrainz tagging and artwork review.
- A dedicated CD ripping queue/workflow.
- Family presence such as “Anna is playing…”.

---

**Working title:** Tomify. Because apparently cancelling Spotify is how software projects are born.

## Tomify web app

The first custom client is implemented as a **React 18 + TypeScript + Vite PWA**. This deliberately small stack keeps the interface independently deployable while leaving Navidrome responsible for accounts, library data, artwork and streams. Zustand owns persistent player/queue state; all OpenSubsonic traffic goes through one typed client.

### Local development

Requirements: Node.js 20 or newer and Corepack. The repository pins pnpm 11.28.6 through `packageManager`, so local development and CI use the same package manager.

Production builds embed the current Git short SHA and application/agent contract version. `GET /api/version` exposes the site values, while Settings compares them with the authenticated recovery-agent status. Recovery operations stop with `recovery-agent-outdated` when the deployed agent predates the site's required contract; agent updates are documented in [Updating the recovery agent](docs/DEPLOYMENT.md#updating-the-recovery-agent).

```bash
corepack enable
cp .env.example .env.local
pnpm install
pnpm dev
```

`VITE_NAVIDROME_URL` sets the default server shown on the login screen. It is not a secret. The selected server remains editable at sign-in, so local and production servers need not share a hostname. Navidrome must allow requests from the development or deployed frontend origin.

The Worker's separate `NAVIDROME_ORIGIN` controls server-side session checks, admin checks, library scans, playlist lookups and the `/navidrome` proxy. Its production value is committed as a non-secret `[vars]` entry in `wrangler.toml`; missing or non-HTTPS values fail closed. Keep the frontend default aligned with it for new sign-ins, but do not replace the frontend setting with the Worker var: saved sessions and `requestServerUrl` rely on the existing frontend value. Every Worker binding, variable, secret and build constant is listed in [the architecture configuration table](docs/ARCHITECTURE.md#configuration).

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

GitHub Actions runs the frozen-lockfile install, lint, typecheck, production build, and complete test suite on every push and pull request. Build deliberately runs before tests because the Worker routing tests inspect the generated service worker and Worker bundle.

`pnpm build` writes the Vite application to `dist/client/` and asks the exactly pinned Wrangler dev dependency to bundle the TypeScript Worker from `worker/index.ts` into an unminified `dist/server/index.js` for route and SQL tests. Use `pnpm exec wrangler dev` when testing the complete local deployment, including Worker routes and Cloudflare's Static Assets routing; its custom build step refreshes the git SHA exposed by `/api/version`. `pnpm dev` runs the frontend development server only.

### Implemented

- Navidrome token authentication, persisted without storing the password, with logout and useful failure states.
- Home, artists, artist detail, albums, multi-disc album detail, debounced search, playlists, favourites, offline downloads and settings.
- A heart on every track row and album card stars or unstars it in Navidrome. The heart changes at once and flips back if the server refuses, and the Favourites page updates without a reload.
- Navidrome playlists can be created and edited in Tomify: **New playlist** on the Playlists page, the **+** button on any track row or **Add to playlist** on an album to add music, and **Edit** on your own playlist to rename it, move tracks up or down, remove tracks or delete it (deleting also removes its Tomify shares). Edits save straight away through the Subsonic `createPlaylist`, `updatePlaylist` and `deletePlaylist` calls; reordering rewrites the whole track list with `createPlaylist` and sends long song lists as a POST form (OpenSubsonic `formPost`). Only the owner sees the editing controls.
- Playlists are private to the account that made them, with a **Share** button for sharing one with other Tomify accounts (read-only; recipients see it under **Shared with you**). Navidrome itself would hand admins every user's playlists and everyone other users' public ones, so Tomify lists only your own plus those shared with you. Navidrome has no per-user sharing, so sharing a Navidrome playlist also marks it public in Navidrome (other Subsonic clients can then see it) and unsharing it from everyone makes it private again. An account appears in the Share list once it has signed in to Tomify. Shares live in the D1 `playlist_shares` table (`drizzle/0007_playlist_shares.sql`).
- Persistent HTML5 player with queue, seek, volume, mute, shuffle (reorders the upcoming songs once, so nothing repeats; turning it off restores the original order), repeat, previous/next and full-screen mobile now playing.
- Media Session metadata (absolute artwork in six sizes, or only the album's Tomify replacement cover when it has one, refreshed as soon as replacements load or change), transport controls and position updates.
- Installable manifest, app icons, standalone mode, cached app shell and cached artwork.
- Offline downloads of tracks, albums and playlists, played from the device in preference to streaming (see [Offline playback](#offline-playback)).
- A source-aware Recovery queue with MusicBrainz metadata review, provider-ranked cover art, D1 provenance, safe recovery-copy deletion and an optional media-server acquisition agent.
- OAuth-backed Spotify playlist import as catalogue metadata only, with Navidrome matching, ambiguous-match review, ordered pending Recovery entries, duplicate preservation, and manual refresh diffs. Matching ignores reissue labels on titles (` - 2010 Remaster`, `(Remastered 2009)`, `(Deluxe Edition)`, ` - Mono`, ` - Single Version`, `feat.` credits) but still treats live, remix, acoustic and similar versions as different recordings. It searches the library by the first credited artist and the bare title, then by the title alone. Opening an imported playlist re-checks every ready entry with Navidrome `getSong`; an entry whose track has moved is matched again, and one with no match left goes back to missing. The matcher lives in `src/lib/catalogue-match.mjs`, shared by the app and the Worker build.
- Album completeness against the MusicBrainz tracklist (administrators only, run with **Check completeness** on the album page rather than on every visit), with edition choice, duplicate-copy and extra-track notes, one-click "add missing to Recovery" (per track, or as one album search), and an incomplete-albums list in Library health.
- On the album page, administrators can **Edit metadata** (release type and date) and click the album artwork to replace it, either with an Apple, Deezer or Spotify match or with **Upload from device**. Other accounts see neither, and the Worker answers `403` to their metadata edits, artwork changes and completeness checks.
- Library album artwork upgrades from Apple (1200px) and Deezer (1000px), with Spotify optional, chosen per album or in a resumable bulk run from Settings.
- Recovery, Library health and the server controls in Settings are shown only to Navidrome administrators, and the Worker enforces the same boundary. On mobile, Recovery (administrators only) and Settings sit behind the account button in the top bar (with Sign out), Library health is opened from Settings, and the bottom tab bar has Playlists in their place. Back from a page opened from the account sheet reopens the sheet. Settings has a **Restart media server** button that reboots the home server through the recovery agent when SSH cannot reach it, NordVPN status with **Connect**/**Disconnect** buttons, and a **Full library scan** button (reboot and VPN control are off until enabled on the server; see docs/RECOVERY.md).
- Usenet recovery through NZBIndex and/or Newznab indexers and SABnzbd or NZBGet, searching any mix of artist, album and track.
- Torrent recovery from a torrent search (qBittorrent's search plugins and an optional Prowlarr or Jackett, seeded results only) or a pasted magnet or `.torrent` link, downloaded by qBittorrent-nox over the box's VPN (five at a time by default, `TOMIFY_TORRENT_MAX_ACTIVE`) with live speed, seeds and time left, archives unpacked, audio imported, and the torrent removed afterwards (or when the item is deleted).
- A read-only Library health dashboard for administrators, backed by the incremental recovery-agent inventory. It reports duplicate recordings and similar directory names, partial albums, orphaned provenance files, recovery copies shadowing masters, and imported D1 rows whose files are missing. Results come from the stored atomic inventory; viewing them does not scan or modify either library, while **Scan now** starts the existing background scan. Findings that are legitimate can be marked as fine so they stop being counted. Duplicates can be merged and Recovery copies promoted over their masters from the same page: it shows the planned moves first, moves copies to `_Duplicates` rather than deleting them, relinks matched songs in playlists, and lists recent changes with **Undo** (see docs/RECOVERY.md).

### Deploying

Cloudflare builds and deploys the site on every push to `main`; the recovery agent is deployed separately from the Windows checkout. Both, plus D1 migrations, box dependencies, secrets and backups, are covered in [DEPLOYMENT.md](docs/DEPLOYMENT.md).

### Recovery imports

The Recovery page (Navidrome administrators only) accepts wanted music from any mix of artist, album and track (at least one; leave the track blank to ask for a whole album), searches pluggable candidate backends and keeps source, match, measured quality and import status together. The media-server agent supports YouTube, Internet Archive's public catalogue/file APIs and Usenet (NZBIndex and Newznab indexers, downloading through SABnzbd or NZBGet), and torrents (searched with qBittorrent's search plugins and an optional Prowlarr or Jackett, showing only results with seeds, or pasted as links) downloaded through qBittorrent-nox. A Usenet search can combine artist, album and track in one query; an album search imports the whole release, and a single-track import from a larger download offers **Import rest of download** to take the remaining tracks without downloading again. Before importing, the confirm step warns about tracks already in the recovery library or an album already in your Navidrome library, and can skip the tracks you already have. All paths require an explicit source-specific authorisation confirmation, inspect the resulting file with FFprobe, preserve the original stream, tag a distinct FFmpeg stream-copy derivative and write only to the separate recovery library. Recovery files never replace verified masters automatically.

Every import is sorted into a quality tier (lossless, transparent lossy, lossy or unknown) and marked **Recovered** or **Needs upgrade** against the preferred quality chosen in **Settings → Recovery quality**, which also has a **Re-check quality labels** button for items imported earlier; see [Quality tiers](docs/RECOVERY.md#quality-tiers).

See [docs/RECOVERY.md](docs/RECOVERY.md) for the agent setup, backend contract and legal/quality boundaries.

Downloads and imports finish on the media server even with no browser open: the agent advances its own queued jobs every `TOMIFY_JOB_POLL_SECONDS` (10 by default), and the Recovery page only shows their progress (see [Background jobs](docs/RECOVERY.md#background-jobs)).

The agent also runs the library inventory in the background, one scan at a time. It never writes to either music library and only re-probes files whose size or modification time changed; see [Read-only library inventory](docs/RECOVERY.md#read-only-library-inventory).

The recovery agent is deployed separately from the site. After any change under `recovery-agent/` or `shared/` is merged, deploy it from Windows with `.\scripts\deploy-agent.ps1` (or `./scripts/deploy-agent.sh` on Linux/macOS). Run `.\scripts\deploy-agent.ps1 -Setup` once first so deploys need no password. Releases switch atomically, are health-checked, and roll back automatically if startup fails; see [Updating the recovery agent](docs/DEPLOYMENT.md#updating-the-recovery-agent). An out-of-date agent makes newer Recovery features fail.

`scripts/backup.sh` backs up the D1 database and the agent's state nightly on the media server, and an external uptime check should watch the site and the agent's `/health`; see [Backups and uptime checks](docs/DEPLOYMENT.md#backups-and-uptime-checks).

### PWA and iOS notes

The service worker precaches the application shell and uses a bounded cache for artwork; audio is not cached by the service worker (downloaded songs live in IndexedDB, see [Offline playback](#offline-playback)). On compatible iOS Safari/Home Screen PWA versions, the active track sets title, artist, album and HTTPS artwork immediately, and registers play, pause, previous, next and seek handlers. Playback uses two long-lived audio elements (the playing track and the next one, pre-loaded while playing), so navigation does not interrupt it.

On a patchy connection (for example mobile data in a car) a stream that drops or hangs is reloaded from where it stopped: Tomify retries after 1, 3, 6 and 10 seconds, retries straight away when the phone comes back online, and treats 15 seconds of buffering while playing as a dropped stream. A next track whose pre-load failed is loaded fresh rather than handed over. Only after every retry fails does the player show as paused. While a stream is buffering, Tomify tells the lock screen and car that playback is paused at the current position, so their progress bar doesn't keep moving over silence; it switches back to playing as soon as sound resumes.

**Adaptive streaming.** On the Tomify music server, tracks stream as HLS: the recovery agent on the box cuts each track into 6-second AAC chunks at 64, 128 and 256 kbps, and the player (hls.js on Android and desktop, Safari's own HLS on iPhone) picks the bitrate chunk by chunk from how fast the chunks arrive. A weak signal drops to a smaller stream mid-track instead of stalling, and quality climbs back when the signal improves. About a minute of audio is kept buffered ahead. The choice is per device under **Streaming quality** (in Settings; non-administrators see only this and Sign out there): **Adaptive** (default), **Original on Wi-Fi** (lossless on Wi-Fi, adaptive on mobile data; only Chrome-based browsers report the connection type, so others count as mobile data) or **Always original** (the untouched file, as before). If adaptive streaming fails for any reason other than a chunk lost to a signal drop (the agent is out of date, switched off or can't read a track, the phone can't decode it, a stream hangs, or it hasn't started 8 seconds after pressing play), the player switches to the original file at the same position and tries adaptive again after 10 minutes. Setup and cache settings are in [docs/RECOVERY.md](docs/RECOVERY.md#adaptive-streaming-hls).

**Streaming at home and short-lived stream links.** Once set up on the Worker and the box (both off by default; steps in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#short-lived-media-tokens-and-lan-direct-streaming)), stream and adaptive-stream links carry a token that expires after 4 hours instead of the Navidrome login, and a player on the home network streams straight from the box over HTTPS instead of through Cloudflare. The player checks that the box answers within 1.5 seconds before using it, and anything that fails there, such as leaving home mid-song, carries on through the Worker. Chrome and Edge ask once for permission to reach devices on the local network.

**Volume normalisation.** Songs play at an even loudness using the library's ReplayGain tags (written by rsgain on import; see [ReplayGain tagging](docs/RECOVERY.md#replaygain-tagging)). The choice is per device under **Volume normalisation** in Settings: **Automatic** (default: album gain while an album plays in order, so its quiet and loud songs keep their balance, and track gain otherwise), **Album**, **Track** or **Off**. Songs are normalised to -14 LUFS, the level Spotify and YouTube use: rsgain's tags aim at -18 LUFS, which played everything about 7 dB quieter than the masters, so the agent and player lift every tag by 4 dB (`REPLAYGAIN_PREAMP_DB` in `shared/replaygain.mjs`), still capped so peaks stay 1 dB below full scale. Adaptive streams arrive with the gain baked in by the agent, which is the only way this works on an iPhone, where a web page can't change the volume. Original files are turned down with the player's volume instead, so a song mastered quieter than the reference plays as it is rather than being boosted, and on iPhone **Always original** plays without normalisation. Songs without tags play untouched. Needs the agent from the same release: deploy it before the site.

**Equaliser.** On desktop and Android, Settings → Playback has a ten-band equaliser (31 Hz to 16 kHz, ±12 dB) with Flat, Bass boost, Treble boost, Vocal and Loudness presets or your own bands, saved per device. Both player elements run through one Web Audio chain (`src/lib/equaliser.ts`), with the whole chain turned down by the biggest boost so it never clips. The chain is only built the first time the equaliser is switched on, because an element routed through Web Audio can't be taken out again; switching it off afterwards flattens the filters. It isn't offered on iPhone or iPad, where WebKit suspends a page's audio processing when the screen locks and music would stop, or with a music server other than Tomify's own, whose streams Web Audio can't read across origins.

**Gapless and crossfade.** The next song in the queue is always loaded in a second audio element, and about 0.12 s before the current song ends it starts, so songs play back to back without the gap an `ended` event leaves (live and continuous albums run straight on). **Crossfade** in Settings → Playback (Off, or 1 to 12 seconds, per device) starts the next song that much earlier and fades the two across with equal-power curves. Songs from the same album, DJ sets and repeat-one stay gapless, a fade never runs longer than half of either song, and skipping by hand changes song at once. A next song that isn't buffered yet starts when the current one ends, as before. iPhone and iPad ignore a web page's volume, so there songs play gapless without fading. The logic is in `src/lib/crossfade.ts` and the hand-over in `PlayerRuntime`.

Only one track is ever heard, except while one song hands over to the next. The pre-loaded next track is stopped if anything starts it early, pausing stops both audio elements, and if Tomify is open more than once on the same phone (an installed app plus a browser tab, or a second window Android opened), the copy that starts playing tells the others to stop.

Apple controls which Media Session actions appear, and may omit seeking on some iOS releases. Background playback and lock-screen behaviour require verification on the actual target iPhones over HTTPS; automated desktop tests cannot prove OS-level Control Center presentation. Cross-origin artwork and audio must remain reachable while the phone is locked.

### Playing across devices

Tomify works like Spotify Connect between the tabs and apps signed in to the same account:

- One device plays at a time. Starting music on a device takes playback over, and the device that was playing pauses itself.
- While another device is playing, the player bar, queue and full-screen player show and control it ("Playing on Windows · Chrome"). Play, pause, seek, skip, shuffle, repeat, volume and **Add to queue** all act on that device, and the buttons update straight away rather than after the round trip.
- The device button (speaker icon) lists every device with Tomify open on the account. Pick one to move playback there at the same track and position, or press **Play on this device** in the full-screen player to bring it here.
- A paused device stays in control for a minute so it can be resumed from elsewhere. After that, other devices go back to their own player, loaded with the track and position where it stopped, so pressing play carries on from there.
- Closing or reloading a tab removes it from the device list and marks its playback as paused, so other devices stop showing it as playing. A reload never replays an old remote command, and commands older than 30 seconds are dropped.
- Syncing checks every 1–1.5 seconds while something is playing and backs off to every 10 seconds when nothing changes. A background tab that is playing keeps checking (so it still hears pause from your phone); a background tab that is not playing checks every 20 seconds.
- An iPhone app in the background may stop checking in. Other devices then keep showing it as playing until its current track would have ended.

The state lives in the D1 tables `live_playback` and `live_playback_devices` (`drizzle/0009_live_playback.sql`). The Worker code is in `worker/features/live-playback.ts`, routed by `worker/routes/live-playback.ts`.

### Lyrics

The microphone button in Now Playing swaps the artwork for the song's lyrics, and Tomify remembers which you had open. Synced lyrics follow the song, lighting up the line being sung and scrolling with it (scroll yourself and they stop following for a few seconds); tap a line to jump there. Unsynced lyrics show as plain text. They follow playback on another device too.

- **Where they come from.** Lyrics Navidrome already has come first: tags in the file or an `.lrc` file beside it, read with OpenSubsonic `getLyricsBySongId`. Otherwise the Worker searches [LRCLIB](https://lrclib.net) by artist and title (`GET /api/lyrics`), preferring synced lyrics within 3 seconds of the song's length.
- **Saved once.** The Worker saves each answer in D1 (`lyrics`, `drizzle/0016_lyrics.sql`), so a song is looked up on LRCLIB once for every device. A miss is saved too and tried again after a month; LRCLIB being down is not saved as a miss. The browser keeps answers for the session.

### Made for you mixes

Home's **Made for you** shelf holds five or six mixes built from your own library and listening, such as what you have on repeat, a mix around an artist you love with similar music, old favourites you haven't played in a while, unplayed songs from new albums, and deep cuts. Open a mix to play or shuffle it, or **Save as playlist** to keep it in Navidrome. Your favourite albums are still on Home under **Favourite albums**.

- **Listening history.** Navidrome only keeps a play count and the last time each song played, so the player also records each play in D1 (`listening_events`): how long you listened and whether you finished it or skipped it. Plays that can't be sent wait in the browser and go with the next one. A track counts as skipped when you move on before half of it or 30 seconds, whichever is less. Songs you keep skipping are left out of mixes, and history older than 400 days is pruned.
- **Building.** The first visit to Home each day (mixes older than 20 hours) asks the Worker to rebuild them, signed in as you. It gathers candidates from Navidrome (most played, recently played and recently added albums, favourites, a random sample, and top and similar songs for the artists you play most, from Navidrome's Deezer, ListenBrainz or Last.fm agents) and from the listening history. **Refresh** rebuilds on demand, at most once every 10 minutes. Two tabs never build at once.
- **Claude.** With the Worker secret `ANTHROPIC_API_KEY` set, Claude (Sonnet 5.5 by default, or `TOMIFY_MIXES_MODEL`) picks, orders and names the mixes from that candidate pool. It only sees the pool, so every song is one you own. A daily build costs roughly 5–10p. Without the key, or if Claude fails, Tomify builds the mixes itself with simple rules, and the shelf says which made them.
- To turn Claude on: create a key at console.anthropic.com, then `npx wrangler secret put ANTHROPIC_API_KEY` (or add it in the Cloudflare dashboard under the tomify Worker's Settings → Variables and Secrets as a secret). Press **Refresh** on Home to rebuild straight away.

The Worker code is `worker/features/mixes.ts` (gathering, simple mixes, storage), `worker/features/mix-curator.ts` (the Claude call) and `worker/features/listening.ts`; the tables are created by `drizzle/0014_listening_and_mixes.sql`.

### Song radio

**Start radio** (the radio-tower button on any track row on desktop, and beside the title in Now Playing) plays that song and follows it with similar songs from your library, topping the queue up with another 15 whenever four or fewer are left, so it never runs out. The queue is headed **Radio · <song>**. Starting anything else, or turning shuffle or repeat on, ends the radio.

- **Similar.** Every song in the library (read once and cached for 30 minutes, as for smart playlists) is scored against the first song: songs by similar artists from Navidrome's `getSimilarSongs2` (Last.fm, ListenBrainz or Deezer agents), shared genres and moods, a close tempo (half and double time count), the same artist and a similar year, plus a little randomness so no two radios are alike. The BPM, genre and mood tags come from the agent's style tagging. The scoring is in `src/lib/song-radio.ts`, the queue handling in `src/stores/radio.ts`.
- **Variety.** As in the DJ, an artist never plays twice in a row and has at most three songs in the last 60 (the cap only gives way when nothing else is left). A song never repeats, counting other editions of it, until a small library has all been played.

### Smart playlists, listening stats and who's listening

- **Smart playlists.** **New smart playlist** on Playlists saves a set of rules: genres, artist, year range, favourites only, minimum rating or play count, last played (never, within or not within N days), added in the last N days, an order (random, most or least played, recently added or played, newest or oldest) and a length. Only the rules are stored (D1 `smart_playlists`); each time the playlist opens, the browser reads the whole library from Navidrome once (cached for 30 minutes) and picks the matching songs, so it always reflects what is in the library and what you have played. **Save as playlist** keeps a dated copy in Navidrome. Play counts, last played and ratings are Navidrome's own.
- **Listening stats.** **Listening stats** in the sidebar (or the account sheet on mobile) shows plays, hours listened, the share skipped, and your top artists, albums and tracks over the last 7 days, 30 days or year, from Tomify's listening history (`GET /api/listening/stats?days=`). Skipped plays don't count towards the top lists.
- **Listening now.** Home shows what other accounts on the music server are playing ("Anna is playing…"), from Navidrome's `getNowPlaying`, checked every 30 seconds. Entries older than 10 minutes are hidden, and **Play** starts the same song for you.

### Party mode

**Party mode** (sidebar, or the account sheet on mobile) lets people at a party add songs from their phones. The host names the party and starts it; Tomify shows a six-letter access code and a link (`/join/<code>`) to share. Guests open the link, type their name and need no Tomify account. They can search the library, add songs, see what's playing and what's next, and vote for other guests' songs.

- **Playing.** The host's device plays the songs: the next guest song goes straight after the current track, one at a time, so votes keep reordering the rest until it's their turn. Without votes, guests take turns, so one person adding five songs doesn't fill the next five slots. Keep Tomify playing on the device that started the party (another open tab on the same account only joins in while it is the one playing).
- **Limits.** The host sets a wait between adds for each guest (off, 30 seconds to 10 minutes), how many songs each guest can have waiting, and whether voting is on. A song already queued, or played in the last hour, can't be added again. The host can remove any song or guest (a removed guest's waiting songs go too), and **End party** deletes it all. A party also ends by itself 12 hours after the host's player last checked in.
- **Login.** Guests search and see covers through the Worker. If `TOMIFY_PARTY_USERNAME`/`TOMIFY_PARTY_PASSWORD` are set (a Navidrome account just for this), the Worker uses that. Otherwise it uses the host's own Navidrome token, sealed with `TOMIFY_MEDIA_KEY` and deleted when the party ends. Guests only ever get song details (no file paths) and covers.
- **Code.** `worker/features/party.ts` (routes under `/api/party`, D1 tables from `drizzle/0017_parties.sql`), `src/stores/party.ts` (the host's player), `src/pages/Party.tsx` and `src/pages/PartyGuest.tsx`.

### Tomify DJ

Press **DJ** on Home (it shows **Starting DJ…** while the first songs are picked) and Tomify plays your library like a radio show: sets of three to five songs, each introduced by a short spoken link ("Morning Tom. Here's one you haven't played since March…"). While the DJ talks the music waits, then the set plays. The next set is chosen while the current one plays, never repeats a song from the session, plays each artist at most once per set, and rests the artists from the last few sets (about 12 songs) while your library has enough others; asking for an artist by name brings them straight back. Type into **Tell the DJ** ("something calmer", "more 80s", "deep house around 124 bpm") and the songs after the current one change to match, for the rest of the session. Or hold the mic button next to it, say what you want, and let go: the music pauses while you talk, the DJ answers out loud ("Upbeat it is! Here's…") and the new set starts straight away. A quick tap, or nothing heard, puts the music back on. Speech is heard by the browser where it can (Chrome, Edge, Safari); otherwise, or after the browser's recognition fails, the recording is sent to `/api/dj/listen`, which hears it with Workers AI Whisper (`@cf/openai/whisper-large-v3-turbo`, about 47 neurons a minute, so a few seconds' request costs about 5). Songs tagged with BPM, genre and mood (see [BPM, genre and mood tags](docs/RECOVERY.md#bpm-genre-and-mood-tags)) let the DJ keep a whole set to one style or tempo: songs matching a named genre, mood or tempo go to the front of the pool, a genre the library has brings its songs in, and Claude sees each song's tempo, genre and mood and orders the set by tempo. Playing anything else, or **Stop DJ**, ends it.

- Claude (the same key and model as the mixes) picks each set from your library and listening history and writes the link. Without the key the DJ still picks a set, one song per artist, and reads a plain intro.
- With `TOMIFY_DJ_VOICE_MODEL=aura` the voice is Workers AI's Deepgram Aura-2 (`AI` binding in `wrangler.toml`), the British female voice `pandora` by default; set `TOMIFY_DJ_VOICE` to another Aura-2 voice to change it (for example `ophelia`, a bubblier American female voice, or `draco`, a British male voice). Workers AI's free daily allowance covers light use; beyond it a link costs a fraction of a penny.
- The voice is MeloTTS (`@cf/myshell-ai/melotts`) by default: about 8 Workers AI neurons a link, so the free 10,000 a day go a long way. Aura-2 sounds better but costs about 2,700 neurons per 1,000 characters (roughly 1,100 a link), and the free allowance is shared by every model, so Aura-2 alone uses it up in about nine links. Tomify's own `wrangler.toml` sets `TOMIFY_DJ_VOICE_MODEL = "aura"` (the account is on Workers Paid) to use Aura-2 first; set it in `wrangler.toml` rather than the dashboard, since a deploy replaces dashboard variables; when it's refused the Worker falls back to MeloTTS and the panel says why. If MeloTTS is refused too, the phone's voice is the last fallback.
- Every link is spoken. A failed voice request is retried, and fetched again when the link comes up; if the recorded voice still can't be had or won't play, the browser's own voice reads the link instead, and the DJ panel says why (for example a Workers AI error or quota message; `wrangler tail` shows the same as `DJ voice failed`). The recorded voice plays through Web Audio, started from the DJ tap so later links aren't blocked, at the same loudness as the song it leads into: the voice is measured and matched to how loud that song will play (its ReplayGain tags and your normalisation setting, or the library average of about -11.5 LUFS when untagged), 1 dB above it, at your volume setting, with a limiter against clipping (`src/stores/dj.ts`). DJ sets and mixes carry the songs' ReplayGain tags, so they play normalised too. The music never waits more than 30 seconds.
- A set with Claude costs about 1p, so roughly 4–6p per hour of listening including the voice.
- On iPhone the DJ keeps going only while Tomify is open; the browser may not let the voice start from the background.

The Worker code is `worker/features/dj.ts` (`POST /api/dj/segment` and `POST /api/dj/voice`); the player side is `src/stores/dj.ts` and `src/components/DjPanel.tsx`.

### Known limitations

- Drag-to-reorder is not included yet (playlists reorder with up/down buttons).
- Offline downloads store only the original file (no smaller phone copies yet), download only while Tomify is open, and are not refreshed automatically when an album or playlist changes on the server. Signing out leaves an account's downloads on the device.
- Authentication tokens live in browser local storage. This is appropriate for trusted household devices; a shared device should be signed out after use.
- A cross-origin deployment requires correct Navidrome CORS configuration. A same-origin proxy avoids that operational edge.

### Deployment recommendation

Keep the working Navidrome tunnel untouched while testing Tomify at `app.tomify.tomdixon.uk`, with `VITE_NAVIDROME_URL=https://tomify.tomdixon.uk`. Once accepted, the clean final shape is:

```text
tomify.tomdixon.uk       static Tomify PWA
api.tomify.tomdixon.uk   existing Navidrome service/tunnel
```

That split is explicit and independently deployable. Navidrome should allow the PWA origin, or an edge proxy can present `/rest`, `/stream` and `/getCoverArt` under the app origin if iOS/CORS testing shows a need. Do not change the current tunnel until the alternate hostname has been proven.

### Recommended next task

Offline downloads v1 (roadmap 3.1) is in. Next for offline listening: smaller download qualities for phones (an agent-made AAC copy), and **Keep downloaded** so edited playlists update themselves on Wi-Fi.

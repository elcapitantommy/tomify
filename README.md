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

A user should be able to tap **Download** on a track, album or playlist.

The PWA will request either the original file or a transcoded copy from the server, store the audio plus required metadata/artwork locally, and make it available from an **Offline / Downloads** section with no network connection.

Planned qualities:

- Original / FLAC
- High quality
- Normal quality
- Space saver

Exact codecs/bitrates will be chosen during implementation based on browser support.

A later **Keep downloaded** mode should keep selected playlists or albums synchronised when the device next has a suitable connection.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the proposed system design and [docs/ROADMAP.md](docs/ROADMAP.md) for the staged build plan.

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
- ReplayGain.
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

Requirements: Node.js 20 or newer and pnpm 9 or newer.

```bash
cp .env.example .env.local
pnpm install
pnpm dev
```

`VITE_NAVIDROME_URL` sets the default server shown on the login screen. It is not a secret. The selected server remains editable at sign-in, so local and production servers need not share a hostname. Navidrome must allow requests from the development or deployed frontend origin.

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

### Implemented

- Navidrome token authentication, persisted without storing the password, with logout and useful failure states.
- Home, artists, artist detail, albums, multi-disc album detail, debounced search, playlists, favourites, downloads placeholder and settings.
- Playlists are private to the account that made them, with a **Share** button for sharing one with other Tomify accounts (read-only; recipients see it under **Shared with you**). Navidrome itself would hand admins every user's playlists and everyone other users' public ones, so Tomify lists only your own plus those shared with you. Navidrome has no per-user sharing, so sharing a Navidrome playlist also marks it public in Navidrome (other Subsonic clients can then see it) and unsharing it from everyone makes it private again. An account appears in the Share list once it has signed in to Tomify. Shares live in the D1 `playlist_shares` table (`drizzle/0007_playlist_shares.sql`; the Worker also creates it on first use, so deploying needs no extra step).
- Persistent HTML5 player with queue, seek, volume, mute, shuffle, repeat, previous/next and full-screen mobile now playing.
- Media Session metadata (absolute artwork in six sizes), transport controls and position updates.
- Installable manifest, app icons, standalone mode, cached app shell and cached artwork.
- A playback source resolver boundary ready to prefer IndexedDB audio before the network in the next phase.
- A source-aware Recovery queue with MusicBrainz metadata review, provider-ranked cover art, D1 provenance, safe recovery-copy deletion and an optional media-server acquisition agent.
- OAuth-backed Spotify playlist import as catalogue metadata only, with Navidrome matching, ambiguous-match review, ordered pending Recovery entries, duplicate preservation, and manual refresh diffs.
- Album completeness against the MusicBrainz tracklist, with edition choice, duplicate-copy and extra-track notes, and one-click "add missing to Recovery".
- Library album artwork upgrades from Apple (1200px) and Deezer (1000px), with Spotify optional, chosen per album or in a resumable bulk run from Settings.
- Settings is shown only to Navidrome administrators. It has a **Restart media server** button that reboots the home server through the recovery agent when SSH cannot reach it, NordVPN status with **Connect**/**Disconnect** buttons, and a **Full library scan** button (reboot and VPN control are off until enabled on the server; see docs/RECOVERY.md).
- Usenet recovery through NZBIndex and/or Newznab indexers and SABnzbd or NZBGet, searching any mix of artist, album and track.
- Torrent recovery from a torrent search (qBittorrent's search plugins, seeded results only) or a pasted magnet or `.torrent` link, downloaded by qBittorrent-nox over the box's VPN with live speed, seeds and time left, archives unpacked, audio imported, and the torrent removed afterwards (or when the item is deleted).

### Recovery imports

The Recovery page accepts wanted music from any mix of artist, album and track (at least one; leave the track blank to ask for a whole album), searches pluggable candidate backends and keeps source, match, measured quality and import status together. The media-server agent supports YouTube, Internet Archive's public catalogue/file APIs and Usenet (NZBIndex and Newznab indexers, downloading through SABnzbd or NZBGet), and torrents (searched with qBittorrent's search plugins, showing only results with seeds, or pasted as links) downloaded through qBittorrent-nox. A Usenet search can combine artist, album and track in one query; an album search imports the whole release, and a single-track import from a larger download offers **Import rest of download** to take the remaining tracks without downloading again. All paths require an explicit source-specific authorisation confirmation, inspect the resulting file with FFprobe, preserve the original stream, tag a distinct FFmpeg stream-copy derivative and write only to the separate recovery library. Recovery files never replace verified masters automatically.

See [docs/RECOVERY.md](docs/RECOVERY.md) for the agent setup, backend contract and legal/quality boundaries.

The recovery agent is deployed separately from the site. After any change under `recovery-agent/` is merged, copy it to the media server and restart it (see [Updating the recovery agent](docs/RECOVERY.md#updating-the-recovery-agent)); an out-of-date agent makes newer Recovery features fail.

### PWA and iOS notes

The service worker precaches the application shell and uses a bounded cache for artwork; audio is deliberately not cached yet. On compatible iOS Safari/Home Screen PWA versions, the active track sets title, artist, album and HTTPS artwork immediately, and registers play, pause, previous, next and seek handlers. Playback uses one long-lived audio element, so navigation does not interrupt it.

Apple controls which Media Session actions appear, and may omit seeking on some iOS releases. Background playback and lock-screen behaviour require verification on the actual target iPhones over HTTPS; automated desktop tests cannot prove OS-level Control Center presentation. Cross-origin artwork and audio must remain reachable while the phone is locked.

### Known limitations

- Offline audio downloads, favourite editing, playlist editing and drag-to-reorder are not included yet.
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

Implement a versioned IndexedDB download repository for track metadata, artwork and audio blobs, then add a local-first source resolver (`valid local copy → object URL; otherwise Navidrome stream`). Start with one-track download/remove/retry and airplane-mode tests before album or playlist orchestration.

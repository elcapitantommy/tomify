# Tomify Architecture

## 1. Overview

Tomify separates the valuable part of the system — the music library — from the replaceable parts — server software and clients.

```text
                         ┌──────────────────────┐
                         │       CD drive       │
                         └──────────┬───────────┘
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │ Secure rip + tagging │
                         │ FLAC + metadata      │
                         └──────────┬───────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────┐
│                    Small Linux media server                │
│                                                            │
│  /srv/music     canonical FLAC library                     │
│  /srv/tomify    application/config data                    │
│  /srv/backup    optional local staging                     │
│                                                            │
│  Docker Compose                                            │
│   ├── Navidrome                                            │
│   ├── reverse proxy / TLS                                  │
│   └── Tomify PWA/API helper services if required later     │
└───────────────────────────┬────────────────────────────────┘
                            │ HTTPS
                ┌───────────┴───────────┐
                │                       │
                ▼                       ▼
          Tomify PWA               Navidrome UI
          primary client           fallback/admin client
                │
       ┌────────┴────────┐
       │                 │
       ▼                 ▼
     Tom               Anna
```

## 2. Music library

### Canonical format

The server library should use **FLAC** for CD rips.

Reasons:

- Lossless archival copy.
- No need to re-rip if a different delivery format is wanted later.
- Suitable for direct playback on LAN.
- Suitable as a source for server-side transcoding.

The FLAC files are the irreplaceable output of the ripping effort and should be treated as primary data.

### Suggested layout

```text
/srv/music/
  Artist/
    Album/
      01 - Track.flac
      02 - Track.flac
```

Folder names are for human sanity only. Tags should be regarded as the authoritative metadata used by the server.

Important tags include:

- Artist
- Album artist
- Album
- Title
- Track number
- Disc number
- Date/year
- Genre where useful
- MusicBrainz identifiers where available
- Embedded or associated artwork

Compilations and multi-disc releases need a consistent tagging policy before large-scale ripping begins.

## 3. Ripping workflow

Proposed first workflow:

1. Insert CD into a desktop optical drive.
2. Rip securely using Exact Audio Copy or an equivalent secure ripper.
3. Verify the rip where possible.
4. Retrieve/review metadata.
5. Save as FLAC.
6. Review artwork and naming.
7. Copy/import the finished album into the canonical server library.
8. Navidrome indexes the new material.
9. Backup job captures the new master files.

A future dedicated ingest workflow could automate steps 4–8, but the first priority is trustworthy rips rather than clever automation.

## 4. Navidrome

Navidrome is the initial backend because it solves the boring but substantial music-server problems immediately:

- Library indexing.
- User accounts.
- Album/artist browsing.
- Streaming.
- Playlists.
- Favourites.
- Play counts/history.
- Artwork.
- Transcoding.
- OpenSubsonic/Subsonic-compatible client access.

The music directory should be mounted read-only into Navidrome where practical:

```text
host: /srv/music
container: /music
mode: read-only
```

Navidrome application data lives separately and is backed up independently.

## 5. Tomify PWA

The custom Tomify client should treat Navidrome as a service, not as its UI framework.

### Core responsibilities

- Authentication/user session.
- Browse/search.
- Playback.
- Queue.
- Playlists/favourites.
- Responsive mobile/desktop UI.
- Installable PWA behaviour.
- Media Session integration.
- Offline library.
- Local download management.

### Initial screens

```text
Home
Artists
Albums
Playlists
Favourites
Downloads
Search
Settings
Now Playing
```

### Player behaviour

The player should support:

- Play/pause.
- Previous/next.
- Seeking.
- Queue display/editing.
- Shuffle/repeat.
- Artwork.
- Lock-screen/headset controls where the platform permits.
- Seamless selection between a local offline copy and the streamed version.

The UI should not care which transport supplied the audio once playback begins.

## 6. Offline design

Offline playback is a core product requirement.

### User flow

Users should be able to download:

- One track.
- One album.
- One playlist.

Each item should expose a clear status:

```text
Not downloaded
Queued
Downloading
Available offline
Update available
Download failed
```

### Local data

For every offline track, store:

- Track identifier.
- Album/artist identifiers.
- Title/artist/album metadata.
- Duration.
- Artwork reference or cached artwork.
- Chosen offline quality.
- Audio blob/file.
- Source revision or equivalent information needed to detect replacement.

IndexedDB or another appropriate persistent browser storage mechanism should be used for structured metadata and binary audio storage rather than relying only on the service-worker HTTP cache.

### Playback resolution

At play time:

```text
Is a valid offline copy present?
        │
    yes │ no
        │
        ▼
play local copy
              or
              ▼
        request stream
```

If the device is offline and no local copy exists, Tomify should fail cleanly rather than hanging on a dead network request.

### Download quality

Initial concept:

- Original
- High
- Normal
- Space saver

The exact codec/bitrate matrix is deliberately deferred until implementation testing across the target phones/browsers.

The server should retain FLAC regardless of chosen mobile quality.

### Keep downloaded

A later synchronisation mode should support:

> Keep this playlist downloaded

When a selected playlist changes, the PWA compares the desired set with local storage and downloads/removes items according to user settings when an appropriate connection is available.

This should be explicit and predictable rather than silently consuming storage or mobile data.

## 7. Accounts and family use

Tom and Anna should have separate Navidrome-backed identities.

Separate:

- Listening history.
- Favourites.
- Personal playlists.
- Preferences.

Optionally shared:

- Shared playlists.
- Family playlists.
- Common music library.

Tomify should avoid inventing its own account database unless the backend API proves insufficient.

## 8. Network and remote access

The service must work:

- Locally on the home network.
- Remotely over encrypted HTTPS.
- In offline mode for downloaded music.

The production deployment should not expose raw Navidrome ports directly to the public internet.

A reverse proxy or private-access design should terminate HTTPS and forward only the required service.

Before public exposure, document:

- DNS.
- TLS certificate handling.
- Authentication.
- Rate limiting where useful.
- Update policy.
- Backup/restore.
- Whether direct public HTTPS or a private overlay such as Tailscale is preferred.

The PWA origin and API origin should be planned to avoid unnecessary cross-origin complexity.

## 9. Storage

Suggested server structure:

```text
/srv/music/              # FLAC masters
/srv/tomify/
  navidrome/             # database/config/cache as appropriate
  app/                   # custom app state if introduced later
  proxy/                 # reverse proxy config
  compose/               # deployment files
```

The library volume should be sized for growth rather than the current CD count alone.

## 10. Backups

The backup priority order is:

1. FLAC master library.
2. Navidrome database/config.
3. Tomify application/config data.
4. Deployment configuration.
5. Rebuildable caches.

The backup system should have at least one copy that is not on the same physical disk as the music server.

Before a large ripping campaign, perform an actual restore test.

The key rule:

> A backup is not considered real until a sample album and application database have been restored from it.

## 11. Failure model

The system should degrade sensibly.

### Navidrome unavailable

- Existing downloaded music still plays.
- PWA shows server unavailable.
- Streaming/browsing uncached material is disabled.

### Internet unavailable but home LAN works

- Local server playback should continue.
- Remote DNS dependencies should not unnecessarily prevent LAN use.

### Tomify PWA bug

- Navidrome's own web UI remains available as a fallback.

### Server disk failure

- Restore FLAC library and application data from backup.
- No CD re-ripping should be required.

### Phone storage pressure

- User can inspect downloads by track/album/playlist.
- Tomify can show total offline storage usage.
- User can remove local copies without deleting server library items.

## 12. Security boundaries

- Music files should not be writable by the public-facing application unless a future ingest feature explicitly requires it.
- Secrets belong in deployment configuration/environment files, not Git.
- HTTPS is mandatory for remote use.
- Tomify must never treat an offline cached session as permission to modify another user's server data.
- Admin functionality should remain separate from normal playback where possible.

## 13. Deliberately deferred choices

These should be decided by testing rather than guessing now:

- Final PWA framework.
- Exact offline codec/bitrates.
- Direct HTTPS vs private overlay for remote access.
- Final reverse proxy.
- Artwork caching strategy.
- Whether any helper backend is needed between Tomify and Navidrome.
- Chromecast/AirPlay implementation.
- Native app requirement.

The architecture should let these change without touching the canonical music collection.

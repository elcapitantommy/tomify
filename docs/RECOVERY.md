# Recovery and authorised-source imports

Tomify Recovery is a queue for rebuilding missing tracks without confusing a convenience copy with an archival master. Wanted-track data, candidate decisions, measured quality, import state and provenance are stored in Tomify's D1 database. Audio remains on the home media server.

## What v1 does

- Adds wanted tracks with artist, title, release, duration and track number.
- Searches YouTube through a pluggable backend and ranks candidates by title, artist, duration and official artist/label signals.
- Penalises likely live, remix, karaoke, nightcore, sped-up, slowed and cover versions unless those words are part of the wanted title.
- Shows the channel, duration, match confidence and source URL before selection.
- Requires a source-specific authorisation basis before acquisition. Owning a physical copy is not presented as permission to download an unrelated upload.
- Downloads public, unauthenticated YouTube candidates only when confirmed, then uses FFprobe to measure codec, container, bitrate, sample rate, channels and duration.
- Uses FFmpeg stream-copy tagging to avoid a second lossy encode and writes a `.tomify.json` provenance sidecar.
- Writes only into a dedicated recovery directory. Existing files are not overwritten and the configured FLAC master tree must be separate.
- Marks every YouTube result `lossy-recovery-copy` and initially `needs-upgrade`; it is never promoted to an archival master automatically.

Tomify does not provide cookies, account login, DRM handling, signature bypasses or access-control circumvention to the recovery agent.

## Components

```text
Recovery page
    |
    +-- Tomify Worker + D1
    |      wanted tracks, candidates, state, quality and provenance
    |
    +-- acquisition backend interface
           |
           +-- YouTube recovery agent (v1)
           +-- CD rip / purchased download / recovered file (future)
```

The hosted Worker cannot execute media binaries. `recovery-agent/index.mjs` is a deliberately small Node.js service for the Linux media server. It shells out without a command shell, validates destinations and source hosts, and never writes to the canonical master tree.

## Media-server setup

Requirements: Node.js 20+, `yt-dlp`, `ffprobe` and `ffmpeg`.

1. Copy `recovery-agent/recovery-agent.env.example` to `/etc/tomify/recovery-agent.env` and set a long random token.
2. Keep `TOMIFY_RECOVERY_DIR=/srv/music-recovery` separate from `TOMIFY_MASTER_DIR=/srv/music`.
3. Install the example systemd unit, adjusting its paths and user if needed.
4. Put the agent behind an authenticated HTTPS reverse proxy that the hosted Tomify Worker can reach. Do not expose the unauthenticated loopback service directly.
5. Set hosted secrets `RECOVERY_AGENT_URL` and `RECOVERY_AGENT_TOKEN` for the Tomify Site, then redeploy.

The recovery directory may be added to Navidrome as a separate library path after review. It should not be merged over `/srv/music` by an automated job.

## Backend contract

An acquisition backend exposes:

- `POST /v1/search` with `{ backend, track }`, returning `{ candidates }`.
- `POST /v1/acquire` with `{ backend, candidate, track, authorisation }`, returning `{ path, quality, provenance }`.

That boundary is intentionally source-neutral. A later CD-rip, purchased-download or recovered-file backend can implement the same result shape without changing the Recovery page or D1 model.

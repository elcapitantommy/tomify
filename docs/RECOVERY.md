# Recovery and authorised-source imports

Tomify Recovery is a queue for rebuilding missing tracks without confusing a convenience copy with an archival master. Wanted-track data, candidate decisions, measured quality, import state and provenance are stored in Tomify's D1 database. Audio remains on the home media server.

## What v1 does

- Adds wanted tracks with artist, title, release, duration and track number.
- Searches YouTube through a pluggable backend and ranks candidates by title, artist, duration and official artist/label signals.
- Penalises likely live, remix, karaoke, nightcore, sped-up, slowed and cover versions unless those words are part of the wanted title.
- Shows the channel, duration, match confidence and source URL before selection.
- Resolves the selected candidate against MusicBrainz recordings before import, using artist/title similarity, duration, MusicBrainz search confidence and a strong album preference when an entered album is available.
- Presents entered and canonical metadata side by side. Strong matches default to the MusicBrainz artist, title, album, release date and track/disc positions, with an individual opt-out for every field group.
- Treats YouTube only as the audio and provenance source. Video titles are never split or promoted into canonical library metadata.
- Leaves entered metadata unchanged when MusicBrainz has no sufficiently strong, unambiguous match or is unavailable.
- Resolves artwork from the canonical metadata through a provider boundary ordered Apple catalogue, optional Spotify, Cover Art Archive, then YouTube thumbnail. Clean square images of at least 1000px rank highest; 600px square images are preferred and lower/non-square results are labelled fallback quality.
- Accepts provider-neutral wanted-track provenance from catalogue imports. Spotify playlist items retain their track, album, artist, playlist, position, ISRC, release, explicit and artwork references while MusicBrainz remains canonical metadata authority.
- Shows artwork candidates, provider, expected dimensions and confidence during metadata review, with explicit candidate selection or **No artwork**.
- Requires a source-specific authorisation basis before acquisition. Owning a physical copy is not presented as permission to download an unrelated upload.
- Uses anonymous YouTube extraction by default. An optional exported-cookie session can expose the formats available to a YouTube Premium account without storing a Google username or password.
- Inspects every audio format exposed for the selected video, chooses the strongest genuine audio stream available to that session, and records the selected format ID.
- Uses FFprobe to measure the downloaded source and derivative codec, container, bitrate, sample rate, channels and duration. It never claims that a higher nominal output bitrate improves a lower-quality source.
- Retains the original downloaded audio in a hidden `.tomify-source` directory, creates a separately identified FFmpeg stream-copy/tagging derivative, and writes a `.tomify.json` provenance sidecar. A future compatibility transcode must retain the source and record `transcoded: true`.
- Validates selected artwork server-side by HTTPS host, response MIME, file signature, byte size and FFprobe dimensions. It writes release-level `cover.jpg` and embeds attached art only for supported MP4/M4A, MP3 and FLAC derivatives; WebM/Opus and other containers remain audio-only with `cover.jpg` alongside them.
- Writes only into a dedicated recovery directory. Existing files are not overwritten and the configured FLAC master tree must be separate.
- Deletes queue-only items directly from D1. For imported items, deletion first removes the recovery derivative, its `.tomify.json` sidecar and the matching preserved original under `.tomify-source`; D1 state is retained if that filesystem cleanup fails.
- Marks every YouTube result `lossy-recovery-copy` and initially `needs-upgrade`; it is never promoted to an archival master automatically.

Tomify does not capture credentials, accept Google passwords, circumvent DRM or bypass access controls. Exported cookies are sensitive session credentials: they stay entirely on the media server and are never stored in D1, browser storage, frontend code, Worker assets, logs or API responses.

## Canonical metadata review

Selecting a YouTube candidate triggers a MusicBrainz recording search using the wanted artist/title plus any available album and duration evidence. Tomify stores the resulting suggestion, recording/release/release-group identifiers, confidence and resolution time on the existing Recovery item. That saved result is reused for 30 days when the same candidate is selected again.

MusicBrainz calls identify Tomify with a descriptive user agent and are serialised at no more than one request per 1.1 seconds per Worker isolate. A result is only confirmed when the combined score is strong, artist and title similarity clear, supplied album evidence agrees, duration is within tolerance and the leading alternatives are not ambiguous.

At import, the Worker reconstructs the effective metadata from the immutable wanted fields plus the user's per-field choices; it does not accept arbitrary replacement tags from the browser. Both `wantedMetadata` and `resolvedMetadata`, together with the MusicBrainz decision and confidence, are written to candidate provenance and the `.tomify.json` sidecar.

The recovery agent uses the effective metadata for its recovery directory and filename and writes artist, title, album, date, track/disc number, MusicBrainz recording/release/release-group IDs and ISRC where the output container supports those tags. This does not change the recovery boundary: every artifact remains under `TOMIFY_RECOVERY_DIR`, separate from the canonical master tree.

## Artwork resolution and storage

Artwork matching never uses a fuzzy release title alone. Apple and Spotify results must pass artist similarity and, when a canonical album is known, release similarity; year/date contributes only supporting evidence. Cover Art Archive is queried only as a fallback from the resolved MusicBrainz release ID. Front images are preferred and comments suggesting a booklet, case, tray, disc, vinyl sleeve or scan are penalised. The selected YouTube candidate thumbnail is always last-resort fallback quality.

The public Apple and Spotify catalogue policies restrict downloading or retaining their visual content. Tomify therefore resolves and displays those catalogue candidates but will not make them selectable for acquisition by default. An operator who has independently established suitable usage rights can explicitly enable either provider in the hosted Worker environment:

```text
APPLE_ARTWORK_EMBEDDING_ENABLED=true
APPLE_CATALOGUE_COUNTRY=GB

# Optional; Spotify is not required.
SPOTIFY_CLIENT_ID=server-side-secret
SPOTIFY_CLIENT_SECRET=server-side-secret
SPOTIFY_MARKET=GB
SPOTIFY_ARTWORK_EMBEDDING_ENABLED=true
```

Spotify credentials and access tokens remain server-side and are never included in D1, browser code, agent requests or provenance. Without Spotify credentials its provider returns no candidates. Apple catalogue search itself needs no user authentication.

The recovery agent accepts only allow-listed artwork hosts, follows HTTPS redirects, caps downloads at 25 MiB and accepts JPEG, PNG or WebP only when the declared MIME agrees with the file signature. FFprobe verifies the fetched dimensions. Images larger than 1200px are reduced to approximately 1200px without upscaling smaller fallbacks, and the stored release image is normalised to JPEG.

For MP4/M4A, MP3 and FLAC, FFmpeg maps the preserved audio stream with `-c:a copy` and adds a separate attached-picture stream. WebM, Opus, Ogg, MKA and other unsupported or unreliable attached-art containers are kept audio-only with the same stream-copy rule. Every selected image is also written atomically as `Artist/Album/cover.jpg` so Navidrome can detect release artwork independently of embedded-art support. Because that file is shared by a recovered release, deleting an individual Recovery track does not delete `cover.jpg`.

Artwork provenance records the provider and provider ID, original and final fetched URLs, fetched and final dimensions, source and final MIME types, acquisition time, `cover.jpg` path, storage mode and whether the derivative received embedded art.

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

The hosted Worker cannot execute media binaries. `recovery-agent/index.mjs` is a deliberately small Node.js service for the Linux media server. It shells out without a command shell, validates destinations and source hosts, and never writes to or deletes from the canonical master tree. Artifact deletion accepts only absolute imported paths that remain inside `TOMIFY_RECOVERY_DIR`, rejects non-regular files and is idempotent when an artifact has already been removed.

## Media-server setup

Requirements: Node.js 20+, `yt-dlp`, `ffprobe` and `ffmpeg`.

1. Copy `recovery-agent/recovery-agent.env.example` to `/etc/tomify/recovery-agent.env` and set a long random token.
2. Keep `TOMIFY_RECOVERY_DIR=/srv/music-recovery` separate from `TOMIFY_MASTER_DIR=/srv/music`.
3. Install the example systemd unit, adjusting its paths and user if needed.
4. Put the agent behind an authenticated HTTPS reverse proxy that the hosted Tomify Worker can reach. Do not expose the unauthenticated loopback service directly.
5. Set hosted secrets `RECOVERY_AGENT_URL` and `RECOVERY_AGENT_TOKEN` for the Tomify Site, plus any optional artwork-provider configuration above, then redeploy.

The recovery directory may be added to Navidrome as a separate library path after review. It should not be merged over `/srv/music` by an automated job.

## Optional authenticated YouTube session

Authentication is optional. Without it—or when it fails—the backend uses anonymous YouTube extraction. Tomify never stores a Google/YouTube username or password.

Export a Netscape-format cookie file from a browser session you control, transfer it directly to the server, and place it outside both the repository and every web-served directory:

```bash
sudo install -d -m 700 -o tom -g tom /opt/tomify/secrets
sudo install -m 600 -o tom -g tom /path/to/exported-cookies.txt /opt/tomify/secrets/youtube.cookies
sudo chown tom:tom /opt/tomify/secrets/youtube.cookies
sudo chmod 600 /opt/tomify/secrets/youtube.cookies
```

Set this only in `/etc/tomify/recovery-agent.env`:

```text
TOMIFY_YOUTUBE_COOKIES=/opt/tomify/secrets/youtube.cookies
```

`/opt/tomify/secrets/` must remain readable only by the recovery-agent service account. Never copy it into the Tomify checkout, `public/`, a container image, backup intended for source artifacts, D1, or Cloudflare configuration. The supplied `.gitignore` also rejects common cookie filenames as a second line of defence.

Restart and check the local status without printing the path or cookie contents:

```bash
sudo systemctl restart tomify-recovery
curl -s http://127.0.0.1:8788/health
```

Expected status includes `"youtubeAuthentication":"configured"`. To perform an authenticated extraction diagnostic through the protected API without returning video metadata or secrets:

```bash
curl -s -X POST --config - http://127.0.0.1:8788/v1/diagnostics/youtube-auth -d '{}' <<EOF
header = "Authorization: Bearer ${TOMIFY_RECOVERY_TOKEN}"
header = "Content-Type: application/json"
EOF
```

Using standard input for the curl configuration keeps the expanded token out of the process command line. Load `TOMIFY_RECOVERY_TOKEN` from the protected service environment in the administrative shell first; do not paste the value into shell history.

The result reports only whether the cookie session is configured and extraction succeeds. Tomify sanitises tool failures and does not echo the cookie path or command line. If the cookie is missing, unreadable, more permissive than mode `600`, expired, or rejected, authenticated mode is disabled and ordinary searches/imports fall back to anonymous extraction where possible.

## Backend contract

An acquisition backend exposes:

- `POST /v1/search` with `{ backend, track }`, returning `{ candidates }`.
- `POST /v1/acquire` with `{ backend, candidate, track, artwork, authorisation }`, returning `{ path, quality, artwork, provenance }`.
- `POST /v1/delete` with `{ importedPaths }`, removing only each recovery derivative, its sidecar and its matching `.tomify-source` original.
- `POST /v1/status`, returning backend capability state without secret paths or values.

All `/v1/*` endpoints, including deletion, use the same `TOMIFY_RECOVERY_TOKEN` bearer authentication. The Worker calls deletion before removing an imported item from D1. If the agent rejects a path or any filesystem operation fails, the Worker returns an actionable error and leaves the D1 item and candidates intact so the operation can be inspected and retried.

That boundary is intentionally source-neutral. A later CD-rip, purchased-download or recovered-file backend can implement the same result shape without changing the Recovery page or D1 model.

YouTube provenance records the video ID and URL, channel/uploader, title, acquisition timestamp, selected format ID, all available audio-format summaries, measured source quality, derivative details, and whether authenticated access was actually used. Cookies themselves are never provenance.

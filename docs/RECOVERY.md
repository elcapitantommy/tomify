# Recovery and authorised-source imports

Tomify Recovery is a queue for rebuilding missing tracks without confusing a convenience copy with an archival master. Wanted-track data, candidate decisions, measured quality, import state and provenance are stored in Tomify's D1 database. Audio remains on the home media server.

## What v1 does

- Adds wanted tracks with artist, title, release, duration and track number.
- Searches YouTube or Internet Archive through the same pluggable backend contract and ranks candidates by title, artist and duration evidence.
- Penalises likely live, remix, karaoke, nightcore, sped-up, slowed and cover versions unless those words are part of the wanted title.
- Shows the channel, duration, match confidence and source URL before selection.
- Resolves the selected candidate against MusicBrainz recordings before import, using artist/title similarity, duration, MusicBrainz search confidence and a strong album preference when an entered album is available.
- Presents entered and canonical metadata side by side. Strong matches default to the MusicBrainz artist, title, album, release date and track/disc positions, with an individual opt-out for every field group.
- Treats acquisition providers only as audio/provenance sources. YouTube titles and Internet Archive item metadata are never promoted over the MusicBrainz canonical review.
- Leaves entered metadata unchanged when MusicBrainz has no sufficiently strong, unambiguous match or is unavailable.
- Resolves artwork from the canonical metadata through a provider boundary ordered Apple catalogue, optional Spotify, Cover Art Archive, then YouTube thumbnail. Clean square images of at least 1000px rank highest; 600px square images are preferred and lower/non-square results are labelled fallback quality.
- Accepts provider-neutral wanted-track provenance from catalogue imports. Spotify playlist items retain their track, album, artist, playlist, position, ISRC, release, explicit and artwork references while MusicBrainz remains canonical metadata authority.
- Shows artwork candidates, provider, expected dimensions and confidence during metadata review, with explicit candidate selection or **No artwork**.
- Requires a source-specific authorisation basis before acquisition. Owning a physical copy is not presented as permission to download an unrelated upload.
- Uses anonymous YouTube extraction by default. An optional exported-cookie session can expose the formats available to a YouTube Premium account without storing a Google username or password.
- Uses Internet Archive's public Advanced Search and Metadata APIs without credentials, inspects each returned item's files, and favours original lossless audio over derivatives where available.
- Inspects every audio format exposed for the selected video, chooses the strongest genuine audio stream available to that session, and records the selected format ID.
- Uses FFprobe to measure the downloaded source and derivative codec, container, bitrate, sample rate, channels and duration. It never claims that a higher nominal output bitrate improves a lower-quality source.
- Preserves Opus-in-WebM downloads unchanged as `.webm` under `.tomify-source`, but exposes them to Navidrome as `.opus` derivatives created by lossless FFmpeg container remuxing with `-c:a copy`. The Opus audio stream is not re-encoded, and provenance retains the distinct source and derivative containers.
- Retains the original downloaded audio in a hidden `.tomify-source` directory, creates a separately identified FFmpeg stream-copy/tagging derivative, and writes a `.tomify.json` provenance sidecar. A future compatibility transcode must retain the source and record `transcoded: true`.
- Validates selected artwork server-side by HTTPS host, response MIME, file signature, byte size and FFprobe dimensions. It writes release-level `cover.jpg` and embeds attached art only for supported MP4/M4A, MP3 and FLAC derivatives; WebM/Opus and other containers remain audio-only with `cover.jpg` alongside them.
- Writes only into a dedicated recovery directory. Existing files are not overwritten and the configured FLAC master tree must be separate.
- Deletes queue-only items directly from D1. For imported items, deletion first removes the recovery derivative, its `.tomify.json` sidecar and the matching preserved original under `.tomify-source`; D1 state is retained if that filesystem cleanup fails.
- Marks every YouTube result `lossy-recovery-copy` and initially `needs-upgrade`; it is never promoted to an archival master automatically.
- Marks Internet Archive imports `internet-archive-recovery-copy`. A lossless file is still a recovery source, not proof of an archival master.

Tomify does not capture credentials, accept Google passwords, circumvent DRM or bypass access controls. Exported cookies are sensitive session credentials: they stay entirely on the media server and are never stored in D1, browser storage, frontend code, Worker assets, logs or API responses.

## Canonical metadata review

Selecting any acquisition candidate triggers a MusicBrainz recording search using the wanted artist/title plus any available album and duration evidence. Tomify stores the resulting suggestion, recording/release/release-group identifiers, confidence and resolution time on the existing Recovery item. That saved result is reused for 30 days when the same candidate is selected again.

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

For MP4/M4A, MP3 and FLAC, FFmpeg maps the preserved audio stream with `-c:a copy` and adds a separate attached-picture stream. WebM, Opus, Ogg, MKA and other unsupported or unreliable attached-art containers are kept audio-only with the same stream-copy rule. In particular, an Opus stream downloaded in WebM remains an unchanged `.webm` original but is remuxed without transcoding into a Navidrome-compatible `.opus` derivative. Every selected image is also written atomically as `Artist/Album/cover.jpg` so Navidrome can detect release artwork independently of embedded-art support. Because that file is shared by a recovered release, deleting an individual Recovery track does not delete `cover.jpg`.

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
           +-- Internet Archive recovery agent (v1)
           +-- CD rip / purchased download / recovered file (future)
```

The hosted Worker cannot execute media binaries. `recovery-agent/index.mjs` is a deliberately small Node.js service for the Linux media server. It shells out without a command shell, validates destinations and source hosts, and never writes to or deletes from the canonical master tree. Artifact deletion accepts only absolute imported paths that remain inside `TOMIFY_RECOVERY_DIR`, rejects non-regular files and is idempotent when an artifact has already been removed.

## Media-server setup

Requirements: Node.js 20+, `yt-dlp`, `ffprobe` and `ffmpeg`. Internet Archive search/download uses Node's built-in HTTPS fetch and needs no provider credentials.

1. Copy `recovery-agent/recovery-agent.env.example` to `/etc/tomify/recovery-agent.env` and set a long random token.
2. Keep `TOMIFY_RECOVERY_DIR=/srv/music-recovery` separate from `TOMIFY_MASTER_DIR=/srv/music`.
3. Install the example systemd unit, adjusting its paths and user if needed.
4. Put the agent behind an authenticated HTTPS reverse proxy that the hosted Tomify Worker can reach. Do not expose the unauthenticated loopback service directly.
5. Set hosted secrets `RECOVERY_AGENT_URL` and `RECOVERY_AGENT_TOKEN` for the Tomify Site, plus any optional artwork-provider configuration above, then redeploy.

The recovery directory may be added to Navidrome as a separate library path after review. It should not be merged over `/srv/music` by an automated job.

## Internet Archive backend

Internet Archive candidates are discovered with field-restricted public audio searches, then verified against the item's current Metadata API file list before import. Tomify constructs the download URL from the validated item identifier and filename rather than trusting a browser-supplied URL. Downloads are HTTPS-only, redirects are limited to `archive.org` and its download hosts, and the default maximum file size is 1 GiB. Operators can lower or raise that bound with `TOMIFY_ARCHIVE_MAX_BYTES`.

The candidate review links to the Archive item so the user can inspect its description, uploader, licence and rights statement. Archive availability alone is not permission: import still requires the same explicit authorisation basis. Provenance records the item/file identifiers, final download URL, creator, collection, licence/rights fields, file format/source, byte count and supplied hashes. The downloaded bytes are preserved unchanged in `.tomify-source`; tagging and artwork are applied only to the stream-copy derivative.

## Newznab, NZBIndex and Usenet backend

The optional Usenet backend searches one or more Newznab-compatible indexers, NZBIndex, or both, and queues an explicitly selected result in either SABnzbd or NZBGet. It supports three independent query modes: artist, track title, or release/album. Results are shown in a provider-neutral review list with their indexer, title, advertised size, age when available, and a link to the provider's detail page. Search results are not treated as evidence of permission.

This backend is for lawful recovery only. The operator must retrieve only content they are authorised to copy. Tomify does not bypass subscriptions, authentication, takedowns, encryption, or other access controls. Acquisition remains disabled until the existing source-specific authorisation confirmation is completed for the selected result.

Keep all indexer and downloader credentials on the recovery server. Newznab remains supported: configure `TOMIFY_NEWZNAB_INDEXERS_JSON` as a JSON array of `{ "id", "name", "url", "apiKey", "categories" }` objects in `/etc/tomify/recovery-agent.env`.

NZBIndex needs no account or API key for normal use. Tomify enables its documented search and NZB download endpoints by default and makes anonymous requests when `TOMIFY_NZBINDEX_API_KEY` is unset or blank. Although the current API page describes the `key` query parameter as required, both endpoints currently accept anonymous requests. If NZBIndex has separately issued you a key, you may add it to the protected server environment file; do not put it in Worker variables, D1, the browser, or a URL stored in Tomify:

```text
TOMIFY_NZBINDEX_API_KEY=
```

No base URL is required: Tomify uses the documented `https://api.nzbindex.com/api/search` and `/api/download/{collection-id}.nzb` endpoints, and links reviews to `https://www.nzbindex.com/collection/{collection-id}`. When a non-empty optional API key is configured, Tomify attaches it as the documented `key` query parameter only to server-to-server search and NZB download requests. Newznab and NZBIndex can be used together by configuring `TOMIFY_NEWZNAB_INDEXERS_JSON`; leave it as `[]` to use NZBIndex alone.

Configure exactly one downloader:

```text
TOMIFY_SABNZBD_URL=http://127.0.0.1:8080
TOMIFY_SABNZBD_API_KEY=replace-me
TOMIFY_USENET_DOWNLOAD_DIR=/srv/usenet/completed
TOMIFY_USENET_CATEGORY=music
TOMIFY_USENET_MAX_BYTES=2147483648
TOMIFY_RECOVERY_STATE_DIR=/var/lib/tomify-recovery
```

For NZBGet, use `TOMIFY_NZBGET_URL`, `TOMIFY_NZBGET_USERNAME`, and `TOMIFY_NZBGET_PASSWORD` instead of the SABnzbd settings. Indexer URLs must use HTTPS, except for loopback development services. Credentials and credential-bearing NZB download URLs are used only by the recovery agent; they are never returned to the Worker, browser, D1, or provenance.

Restart the service after editing the environment, then confirm that `/health` lists `usenet`:

```bash
sudo systemctl restart tomify-recovery
curl -s http://127.0.0.1:8788/health
echo
```

NZBIndex always counts as an available indexer, with or without its optional key. Usenet is available when exactly one downloader is configured and `TOMIFY_USENET_DOWNLOAD_DIR` is set; configured Newznab indexers are searched alongside NZBIndex.

Acquisition is asynchronous. The UI reports queued, downloading, completed, or failed job state and progress while polling through the Worker. On completion, the agent resolves the downloader path and rejects anything outside `TOMIFY_USENET_DOWNLOAD_DIR`, symlinks, non-regular files, excessive file counts, and downloads over `TOMIFY_USENET_MAX_BYTES`. It chooses the audio file whose name best matches the wanted track, verifies it with FFprobe, preserves the unchanged source beneath `.tomify-source`, and creates the Navidrome-facing derivative through the same stream-copy and metadata pipeline as other Recovery sources. Existing recovery artifacts and canonical masters are never overwritten.

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

- `POST /v1/search` with `{ backend, track, searchMode? }`, returning `{ candidates }`.
- `POST /v1/acquire` with `{ backend, candidate, track, artwork, authorisation }`, returning `{ path, quality, artwork, provenance }`.
- For asynchronous Usenet acquisition, `POST /v1/acquire` returns an opaque job and `POST /v1/jobs/status` reports queued/downloading/completed/failed state, progress, and the final import result.
- `POST /v1/delete` with `{ importedPaths }`, removing only each recovery derivative, its sidecar and its matching `.tomify-source` original.
- `POST /v1/status`, returning backend capability state without secret paths or values.

All `/v1/*` endpoints, including deletion, use the same `TOMIFY_RECOVERY_TOKEN` bearer authentication. The Worker calls deletion before removing an imported item from D1. If the agent rejects a path or any filesystem operation fails, the Worker returns an actionable error and leaves the D1 item and candidates intact so the operation can be inspected and retried.

That boundary is intentionally source-neutral. A later CD-rip, purchased-download or recovered-file backend can implement the same result shape without changing the Recovery page or D1 model.

YouTube provenance records the video ID and URL, channel/uploader, title, acquisition timestamp, selected format ID, all available audio-format summaries, measured source quality, derivative details, and whether authenticated access was actually used. Cookies themselves are never provenance.

Internet Archive provenance records the item identifier and details URL, exact filename and final download URL, creator, item title, collection, licence/rights statements, format, original/derivative source flag, byte count, supplied MD5/SHA-1 values, acquisition time, measured audio quality and derivative details.

Usenet provenance records the provider type and name, opaque result or collection identifier, posted title and date when supplied, selected search mode, details URL, advertised size/age, downloader type, completed file count, measured source quality, and derivative details. It never records indexer API keys, downloader credentials, or credential-bearing download URLs.

# Recovery and authorised-source imports

Tomify Recovery is a queue for rebuilding missing tracks without confusing a convenience copy with an archival master. Wanted-track data, candidate decisions, measured quality, import state and provenance are stored in Tomify's D1 database. Audio remains on the home media server.

## Who can use Recovery

Recovery is only for Navidrome administrators (accounts with `adminRole`). The Worker checks the role with Navidrome's `getUser` API on every `/api/recovery` request, on every album completeness request (the check itself and **Add missing to Recovery**), on album artwork lookups and changes, on release metadata edits and MusicBrainz refreshes, and on Spotify imports that add missing tracks, and answers `403` for everyone else, so hiding the controls is not the only guard. Other accounts still see artwork and release types chosen by an administrator, and can import Spotify playlists without Recovery. The completeness panel no longer runs when an album opens: an administrator presses **Check completeness** to compare it with MusicBrainz. In the PWA, administrators reach Recovery from the sidebar on desktop, and from the account button in the top bar on mobile, which also holds Settings and Sign out (non-administrators see only Sign out there). The mobile tab bar shows Playlists in Recovery's old place for everyone. This needs only a site deploy; the agent is unchanged.

## What v1 does

- Adds wanted music from any combination of artist, album and track (at least one), plus optional duration and track number. Leaving the track blank asks for the whole album.
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
- Deletes queue-only items directly from D1. For imported items, deletion first moves the recovery derivative, its `.tomify.json` sidecar and the matching preserved original under `.tomify-source` into the recovery trash, `TOMIFY_RECOVERY_DIR/.tomify-deleted/<UTC timestamp>/`, keeping their relative paths; D1 state is retained if that move fails. Nothing is erased: the trash is a hidden folder with an empty `.ndignore`, so Navidrome and Library health ignore it, and a file is restored by moving it back to the same relative path under `TOMIFY_RECOVERY_DIR` and running a full library scan. Empty the trash by hand (`rm -r /srv/music-recovery/.tomify-deleted/<timestamp>`) once nothing in it is wanted.
- Classifies every import into a quality tier and marks it `recovered` when the tier meets the preferred quality set in Settings, otherwise `needs-upgrade`. See [Quality tiers](#quality-tiers). Either way the files stay recovery copies, never verified masters, and nothing is promoted to an archival master automatically.
- Waits for Navidrome to scan each import before calling it playable. See [Library scan after import](#library-scan-after-import).
- Marks Internet Archive imports `internet-archive-recovery-copy`. A lossless file is still a recovery source, not proof of an archival master.
- Searches torrents through qBittorrent's search plugins and, when configured, a Prowlarr or Jackett indexer manager, showing only results that have seeds, or accepts a pasted magnet or `.torrent` link per item. Either way it downloads the torrent with qBittorrent-nox over NordVPN, shows live speed, seeds, peers and time left, unpacks archives, imports the audio and then removes the torrent and its data. See [Torrent links and qBittorrent](#torrent-links-and-qbittorrent) and [Torrent search](#torrent-search).

Tomify does not capture credentials, accept Google passwords, circumvent DRM or bypass access controls. Exported cookies are sensitive session credentials: they stay entirely on the media server and are never stored in D1, browser storage, frontend code, Worker assets, logs or API responses.

## Quality tiers

Tomify sorts every recovered file into one of four tiers. The classifier is `shared/quality.mjs`, used by the Worker, the recovery agent and the Recovery page alike, and it works from the source file as FFprobe measured it.

| Tier | Meaning |
| --- | --- |
| `lossless` | FLAC, ALAC, WAV/PCM or AIFF (also APE, WavPack, TTA, TrueHD and MLP). |
| `transparent-lossy` | Lossy, but at a bitrate that sounds the same as lossless: Opus from 128 kbps, AAC from 192 kbps, MP3 from 240 kbps or tagged as LAME V0. |
| `lossy` | Any other lossy file with a measured bitrate, including Vorbis. |
| `unknown` | No usable codec or bitrate. |

The MP3 line is 240 kbps rather than 245 because LAME V0 is variable bitrate and averages roughly 240–260 kbps, so a 243 kbps V0 rip counts as transparent. Quieter V0 material that averages lower is still transparent when its encoder settings tag says V0.

**Settings → Recovery quality → Preferred quality** (administrators only) chooses which tier is good enough: **Lossless only**, **Transparent or better** (the default) or **Any copy**. The value is stored in D1 (`tomify_settings`, key `quality_target`). When an import completes, the Worker marks the item `recovered` if its tier meets the target and `needs-upgrade` if not; `unknown` never meets a target. The Recovery page shows each candidate's tier with a short explanation next to its codec and bitrate.

Changing the target does not rewrite existing items. **Re-check quality labels** in the same section recomputes `recovered` and `needs-upgrade` for every imported item from the source quality stored at import (the `.tomify-source` probe in provenance, otherwise the candidate's codec and bitrate). It also re-checks items that were set by hand with **Mark acceptable**, so run it only when you want every label to follow the target.

The agent writes the tier into each file's `TOMIFY_ARCHIVE_STATUS` tag (`lossless`, `transparent-lossy`, `lossy` or `unknown`). Files imported before this change keep their old `lossy-recovery-copy` tag. The provenance sidecar's `archiveStatus` still names the source, for example `usenet-recovery-copy`.

## Read-only library inventory

The recovery agent can inventory both `TOMIFY_MASTER_DIR` and `TOMIFY_RECOVERY_DIR` without changing either library. It walks regular audio files without following symbolic links and records each file's absolute path, byte size, modification time, FFprobe codec/bitrate/sample-rate/duration summary, shared quality tier, key music tags and MusicBrainz identifiers. Recovery provenance sidecars are linked to their audio and preserved `.tomify-source` path; malformed and orphan sidecars are retained. Hidden directories are otherwise skipped, and so is any directory holding an empty `.ndignore` file, which Navidrome also ignores. On the media server `/srv/music/_Duplicates`, where duplicate copies are moved before deletion, has one so it is left out of both. Preserved `.tomify-source` audio is recorded separately, without probing or counting it as a library track, so missing and unreferenced originals can be reported. The recovery library is only counted once: a directory inside `TOMIFY_MASTER_DIR` that is the recovery library itself, such as the `/srv/music/_Recovery` bind mount on the media server, is left out of the master walk.

The result is `library-inventory.json` under `TOMIFY_RECOVERY_STATE_DIR` (normally `/var/lib/tomify-recovery`). The box runs Node.js 20 and the agent has no npm dependencies, so this is JSON rather than SQLite. It is written to a temporary file in the same state directory and renamed into place only after a complete scan. Later scans reuse an entry when its size and modification time are unchanged, probe only new or changed audio, and remove files that disappeared. The inventory scanner performs no write, rename, directory creation or deletion in either music library; its only writes are under the state directory.

One scan runs in the background at a time. The authenticated agent endpoints are:

- `POST /v1/inventory/scan` starts a scan and returns `202`; another start while it is running returns the same running status without starting a second scan.
- `POST /v1/inventory/status` returns progress, discovered/processed/probed/reused counts and the last completed scan time.
- `POST /v1/inventory/summary` returns file and byte totals plus counts by master/recovery library, quality tier and provenance-sidecar backend.
- `POST /v1/inventory/report` reads the stored inventory without scanning and reports matching fingerprints, duplicate recordings, similar directory names, partial albums, orphaned sources/sidecars and recovery copies shadowing masters. The Worker supplies cached MusicBrainz tracklists when available, so this route accepts request bodies up to 16 MB (every other route stays at 64 KB). Similar directory names are only compared with folders at the same place in either library (artist folders with artist folders, albums of the same artist), and names that differ in a number or Roman numeral (`Greatest Hits 1` / `Greatest Hits 2`, `Past Masters I` / `Past Masters II`) are never reported as typos. Duplicate recordings and recovery copies shadowing masters only count copies on the same album (album artist and album tag, or the folder when untagged): a song on its original album and on a compilation is not a duplicate.

The Worker exposes the same operations to Navidrome administrators under `/api/inventory/*`. For the report it also compares recovered/imported D1 rows with the inventory and lists rows whose selected candidate path is missing. Only a completed scan newer than the import counts: before the first scan finishes, or for imports made since the last scan, nothing is reported as missing. **Settings → Library health** opens the read-only dashboard; it has expandable results, links back to known albums or Recovery items, the last completed scan time and a **Scan now** button. Nothing on it moves a file until a merge or promotion is confirmed (below), and it never deletes one. **Mark as fine** on a finding (for example the same edit on two singles of a box set) stores it in D1 table `library_health_dismissals` (migration 0013) and moves it to a collapsed **Marked as fine** list, where **Report again** undoes it; a finding is matched by its category and exact set of paths, so it is reported again if those files change. Missing-file findings cannot be marked. An older deployed agent returns `inventory-not-available`, and the page asks for an agent redeploy instead of treating that as a general failure.

To start a scan directly on the media server, load the protected token into the administrative shell and use standard input for curl's configuration so the token is not placed on the process command line:

```bash
curl -s -X POST --config - http://127.0.0.1:8788/v1/inventory/scan -d '{}' <<EOF
header = "Authorization: Bearer ${TOMIFY_RECOVERY_TOKEN}"
header = "Content-Type: application/json"
EOF
```

Use `/v1/inventory/status`, `/v1/inventory/summary` and `/v1/inventory/report` the same way. The inventory endpoints need the agent redeployed with `scripts/deploy-agent.ps1` after this change is merged.

## Supervised merge and promotion

Library health findings under **Duplicates and similar directories** have a **Merge…** button, and those under **Recovery copies shadowing masters** have **Promote…**. Each opens a panel that asks the agent for a plan and lists every planned move before anything changes:

- **Merge** keeps the copy (file or folder) chosen with the radio buttons and moves every other copy to `TOMIFY_MASTER_DIR/_Duplicates/<path relative to its library>`. Recovery copies go under `_Duplicates/_Recovery/…` (the name of the recovery folder inside the master library), together with their `.tomify.json` sidecar and the preserved original under `.tomify-source`. A folder merge moves the other folders whole, including any tracks only they hold; it does not combine their contents.
- **Promote** moves the master file to `_Duplicates/…` and then moves the Recovery file and its sidecar into the master's folder under the master's file name with the Recovery file's extension. With the same extension the path is unchanged, so Navidrome keeps the song ID; with a different extension Navidrome sees a new song on its next scan. The preserved original stays in Recovery, where the sidecar still points.

Nothing is deleted. `_Duplicates` gets an empty `.ndignore` if it has none, so Navidrome and the inventory skip it; empty it by hand once nothing in it is wanted. Paths must be absolute and inside `TOMIFY_MASTER_DIR` or `TOMIFY_RECOVERY_DIR`, never the roots themselves, symbolic links, hidden folders, `_Duplicates`, `.tomify-deleted` or `.tomify-source`. Applying re-plans on the agent and refuses if any destination already exists. Moves are plain renames: across filesystems or mounts they fail with a clear error (`EXDEV`) rather than copying. Because `/srv/music-recovery` is a bind mount of `/srv/music/_Recovery`, the agent finds that folder by its device and inode and renames Recovery files through `/srv/music/_Recovery/…`, which stays within the `/srv/music` mount.

Each apply writes a journal to `TOMIFY_RECOVERY_STATE_DIR/library-moves/<id>.json` (id, createdAt, kind, label, moves, status) before the first rename and again afterwards. If a rename fails part-way, the moves already made are renamed back and the journal is marked `rolled-back`. **Recent moves** on the page lists the newest 50 journals; **Undo** renames an applied change back in reverse order, refusing if anything now occupies an original path, and marks it `undone`. A journal left `applying` means the agent stopped mid-change; check its moves by hand.

After a change the page asks Navidrome for a quick scan; run **Scan now** to refresh the report. Playlist relinking is best effort. Before applying, the browser looks each copy up with Navidrome `search3` by title and matches songs by exact file size and extension (Navidrome does not report real paths). When the kept copy and a moved copy each match exactly one song, the moved song ID is replaced by the kept one in the administrator's own Navidrome playlists, in D1 `catalogue_playlist_items.local_track_id`, and in Recovery playback records. Byte-identical copies (fingerprint findings), folder merges, other users' playlists and promotions that change the extension are not relinked, and undo does not change relinked songs back. A Recovery record whose file was merged or promoted away is listed under **Recovery records with missing files** after the next scan; deleting that record in Recovery moves its remaining preserved original to the recovery trash.

The agent routes are `POST /v1/library/moves/plan`, `/apply`, `/undo` and `/list`; the Worker exposes them to Navidrome administrators as `/api/library-moves/*`. The agent must be able to write to the master library, which the shipped systemd unit does not allow (`ProtectSystem=strict` makes `/srv/music` read-only). To enable moves, add a drop-in with `sudo systemctl edit tomify-recovery`:

```ini
[Service]
ReadWritePaths=/srv/music
```

then restart the service. Without it every apply fails with a permission error and moves nothing. The feature needs the agent redeployed (`.\scripts\deploy-agent.ps1`) and a site deploy.

## Library scan after import

An imported file is not playable in Tomify until Navidrome has scanned it, so each imported item also carries a playback state next to its Recovered or Needs-upgrade status (D1 column `recovery_items.playback_json`, `drizzle/0011_recovery_playback.sql`):

- **Imported, waiting for library scan** (`scan-pending`). When an import completes, the Worker asks Navidrome for a quick scan (`startScan` without `fullScan`), unless a scan is already running. If one was running, it starts its own scan once that finishes, because the running scan may have passed the folder before the file landed.
- **Ready to play** (`ready`). While the Recovery page is open it asks the Worker to look again, at most every 15 seconds per item. The Worker searches Navidrome (`search3`) by artist and title and keeps the track whose path matches the imported file when Navidrome reports a path, or whose MusicBrainz recording ID matches. The play button plays that Navidrome song through the normal player. For a release import it plays the wanted track, or the first imported track.
- **Not found in library after scan** (`scan-failed`). The track is still missing ten minutes after the import. **Retry scan** starts another scan and waits ten more minutes. If it keeps failing, check that the recovery directory is inside one of Navidrome's music folders.

The Worker code is in `worker/features/library-scan.ts`, routed through `worker/routes/system-settings.ts`.

## ReplayGain tagging

Navidrome passes ReplayGain tags on to players (the OpenSubsonic `replayGain` field on every song) but never measures loudness itself, so Tomify's loudness normalisation only works on tagged files. When `RSGAIN_PATH` is set, the agent runs [rsgain](https://github.com/complexlogic/rsgain) over every import's staged derivatives before the import manifest records them (`recovery-agent/loudness.mjs`, called from `runManifestImport`). It writes ReplayGain 2.0 track and album gain and peak tags (EBU R128, -18 LUFS reference), one rsgain run per album folder, so album gain covers the tracks that import brings. Because tagging happens before the sha256 is taken, a resumed or rolled-back import still recognises its files. Preserved originals under `.tomify-source` are never touched.

Tagging is best effort. If rsgain fails on an album the error goes to the agent log and the import carries on untagged; if the binary is missing, tagging switches itself off until the agent restarts. Tracks added to an album that is already in recovery get album gain for the new tracks only.

To turn it on:

1. Install rsgain on the box: `sudo apt install rsgain` on Debian 13, or on Debian 12 the `.deb` from the [rsgain releases](https://github.com/complexlogic/rsgain/releases) (`sudo apt install ./rsgain_*_amd64.deb`).
2. Add `RSGAIN_PATH=/usr/bin/rsgain` to `/etc/tomify/recovery-agent.env` and redeploy the agent ([Updating the recovery agent](#updating-the-recovery-agent)).

To tag what is already in the libraries, run once on the box as the user that owns the files, then start a Navidrome scan (Settings, or wait for the scheduled one):

```sh
rsgain easy -S -m MAX /srv/music
```

`easy` treats each folder as an album, `-S` skips files that already have ReplayGain tags (so it is safe to re-run) and `-m MAX` uses every core. It only rewrites tags, never audio, but it does change each file's size and modification time, so the next backup copies them again. `/srv/music/_Recovery` is inside `/srv/music` on the current box, so this covers recovery files too.

## BPM, genre and mood tags

Navidrome returns BPM, genre and mood on every song (`bpm`, `genres` and `moods` in OpenSubsonic) but only reads them from tags, so the DJ can only build a set of one tempo or style from tagged files. The agent adds whichever of the three a file is missing (`recovery-agent/track-style.mjs`, called from `runManifestImport` before ReplayGain tagging):

- **BPM** is measured on the box: ffmpeg decodes up to five minutes of the track and [bpm-tools](https://www.pogo.org.uk/~mark/bpm-tools/) works out the tempo, written as a whole number. It looks for tempos between 84 and 146 BPM, so very fast music (drum and bass at 174) is recorded at half speed.
- **Genre** comes from MusicBrainz: the recording's genres, then its release group's, then the artist's, up to three, most voted first (for example `Deep House; House`). Tracks without a MusicBrainz recording id are matched by an exact artist and title search. With a Last.fm key, Last.fm's top tags fill in when MusicBrainz has none, keeping only tags MusicBrainz lists as genres.
- **Mood** is one or two of Chill, Upbeat, Energetic, Dark, Sad, Romantic, Dreamy and Aggressive, folded from the tags listeners gave the track on Last.fm (and MusicBrainz, which rarely has any). Without a Last.fm key most tracks get no mood.

Tags a file already has are never replaced, and the audio is never touched: the file is copied with `ffmpeg -c copy` with the new tags added, then swapped in. FLAC, Ogg, Opus and MP3 get all three. M4A gets BPM and genre (MP4 has no mood tag ffmpeg can write), and because ffprobe can't read an M4A's BPM back, its tempo is measured again on every backfill run. Other formats are left alone. MusicBrainz calls are limited to one every 1.1 seconds, so a looked-up import takes about a second or two longer per track. A failed lookup or analysis is logged and the import carries on.

To turn it on:

1. Install bpm-tools: `sudo apt install bpm-tools`.
2. Add to `/etc/tomify/recovery-agent.env`: `BPM_PATH=/usr/bin/bpm`, `STYLE_LOOKUP=on` and, for moods, `LASTFM_API_KEY=<key>` (a free key from [last.fm/api/account/create](https://www.last.fm/api/account/create)). Redeploy the agent ([Updating the recovery agent](#updating-the-recovery-agent)).

To tag what is already in the libraries, run as the user that owns the files, then start a Navidrome scan:

```sh
set -a; . /etc/tomify/recovery-agent.env; set +a
node /opt/tomify/current/recovery-agent/style-backfill.mjs --dry-run --limit 20 /srv/music   # see what it would add
node /opt/tomify/current/recovery-agent/style-backfill.mjs /srv/music
```

It prints a line for each file it tags. It skips hidden folders such as `.tomify-source`, files that already have all three tags, and files it looked up before without finding anything (marked with a `TOMIFY_STYLE_CHECKED` date tag; `--recheck` looks them up again). It is safe to stop and re-run. Expect a few seconds per track, so a large library takes hours; running it under `nohup` or `tmux` lets it carry on after you log out. Like rsgain, it rewrites each file it tags, so take a backup first and expect the next backup to copy those files again.

## Canonical metadata review

Selecting any acquisition candidate triggers a MusicBrainz recording search using the wanted artist/title plus any available album and duration evidence. Tomify stores the resulting suggestion, recording/release/release-group identifiers, confidence and resolution time on the existing Recovery item. That saved result is reused for 30 days when the same candidate is selected again.

MusicBrainz calls identify Tomify with a descriptive user agent and are serialised at no more than one request per 1.1 seconds per Worker isolate. A result is only confirmed when the combined score is strong, artist and title similarity clear, supplied album evidence agrees, duration is within tolerance and the leading alternatives are not ambiguous.

At import, the Worker reconstructs the effective metadata from the immutable wanted fields plus the user's per-field choices; it does not accept arbitrary replacement tags from the browser. Both `wantedMetadata` and `resolvedMetadata`, together with the MusicBrainz decision and confidence, are written to candidate provenance and the `.tomify.json` sidecar.

The recovery agent uses the effective metadata for its recovery directory and filename and writes artist, title, album, date, track/disc number, MusicBrainz recording/release/release-group IDs and ISRC where the output container supports those tags. YouTube, Internet Archive, Usenet and torrent imports all use the same safe directory resolver, reusing existing artist and album folders regardless of case or NFC/NFD Unicode composition. This does not change the recovery boundary: every artifact remains under `TOMIFY_RECOVERY_DIR`, separate from the canonical master tree.

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

For MP4/M4A, MP3 and FLAC, FFmpeg maps the preserved audio stream with `-c:a copy` and adds a separate attached-picture stream. WebM, Opus, Ogg, MKA and other unsupported or unreliable attached-art containers are kept audio-only with the same stream-copy rule. In particular, an Opus stream downloaded in WebM remains an unchanged `.webm` original but is remuxed without transcoding into a Navidrome-compatible `.opus` derivative. Every selected image is also published atomically as `Artist/Album/cover.jpg` so Navidrome can detect release artwork independently of embedded-art support. An existing `cover.jpg` is never replaced; provenance records that the existing cover was kept. Because that file is shared by a recovered release, deleting an individual Recovery track does not delete `cover.jpg`.

The preserved original and Navidrome derivative are first copied to hidden temporary files in their destination directories, then published atomically without replacing an existing name. If either publish or the later sidecar write fails, Tomify removes every file created by that track import, including a newly created cover, leaving the release directory as it was.

Artwork provenance records the provider and provider ID, original and final fetched URLs, fetched and final dimensions, source and final MIME types, acquisition time, `cover.jpg` path, storage mode and whether the derivative received embedded art.

## Library album artwork

Albums already in the Navidrome library can show catalogue artwork in place of their library cover. Tomify searches Apple's iTunes catalogue first (1200px, no account or key), then Deezer (1000px, no account or key), then Spotify when `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` are set. It never downloads the image or writes to the music server: the chosen image URL is stored per Navidrome album ID in the D1 `album_artwork` table and drawn wherever that album, or a track from it, appears in Tomify (cards, album page, player, queue, now playing and the Media Session). If the image fails to load, the library cover is shown. Other Subsonic clients keep seeing the library cover. Because nothing is retained, the `*_ARTWORK_EMBEDDING_ENABLED` flags are not needed.

Titles are compared both as written and with trailing edition qualifiers removed (`(Remastered 2009)`, `[Deluxe]`, ` - Special Edition`), so a plain library title matches a catalogue's edition names; an exact edition match still ranks first. Any credited artist can satisfy the artist gate.

- **Album page (administrators):** click the album artwork to open the *Album artwork* panel, which searches straight away and lists up to six matches across all catalogues (*Find better artwork* searches again). Searches ignore edition qualifiers ("(Remastered 2009)", "- Deluxe Edition") and disc markers from albums split per disc ("- Disc 2", "CD1", "[Disc 1]", ", Disc One"), because catalogues list the whole release under its plain title, so each disc gets the release's cover. When nothing matches, the panel names the catalogues that answered and the title it searched for, and any catalogue that could not be searched says why (for example Spotify's *Active premium subscription required for the owner of the app*, which means the Spotify developer app behind `SPOTIFY_CLIENT_ID` belongs to an account without Premium; the connected account's Premium does not count). A connection made through an earlier Spotify app is refused with 403 after the app is replaced, so Tomify retries such a search once with the app's own credentials. **Upload from device** picks an image file instead: the browser shrinks it to at most 1200px and saves it as JPEG, and the Worker checks it is a real JPEG, PNG or WebP under 1 MB before storing it in the D1 `album_artwork_uploads` table (`drizzle/0008_album_artwork_uploads.sql`). It is served from `/api/album-artwork/image/<id>` without sign-in, because image tags cannot send Tomify's headers; the id is random and changes with each upload. Choosing other artwork, keeping the library cover or undoing removes the stored upload. Like catalogue artwork, an upload is shown only in Tomify and never written to the music server. Choosing one, or *Keep library artwork*, is a manual choice; *Undo my choice* removes it.
- **Settings → Upgrade album artwork:** walks every library album and applies the best match only when it is a square image of at least 600px with at least 85% confidence, stopping at the first catalogue that gives one. Albums with a manual choice are skipped, and so are albums that already have Tomify artwork and albums the run checked in the last 30 days without a confident match (remembered in this browser), so pressing Upgrade again after an app update or a stop carries on rather than starting over. Albums whose check failed are retried. When matching improves (for example, ignoring disc markers), the remembered list is cleared, so the next run searches those albums again. Apple allows roughly 20 searches a minute, so albums are spaced three seconds apart (about 25 minutes for 500 albums); the run lives in the app, not the page, so it keeps going while you browse, and it can be stopped at any time.

A catalogue that fails or rate-limits is skipped while another still answers. Only when every catalogue fails is the album reported: rate limits return HTTP 429 with the shortest `retryAfter`, which the bulk run waits out before retrying the album; other failures return 502 with each catalogue's message and count as failed. The run stops after five failures in a row.

Spotify searches use the account connected for playlist import when there is one, falling back to client credentials. Spotify's 2026 Development Mode rules can refuse app-only tokens, and refuse every request when the developer app's owner has no Premium subscription; Spotify's own error text is included in the failure message.

API: `GET /api/album-artwork` (overrides and available providers), `POST /api/album-artwork/lookup`, `/auto`, `/select` and `/reset`, each with `{ albumId, name, artist, year }` as needed. `/select` accepts only HTTPS Apple, Deezer or Spotify image hosts.

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
           +-- Usenet (NZBIndex/Newznab via SABnzbd or NZBGet)
           +-- Torrent links via qBittorrent-nox
           +-- CD rip / purchased download / recovered file (future)
```

The hosted Worker cannot execute media binaries. `recovery-agent/index.mjs` is a deliberately small Node.js service for the Linux media server. It shells out without a command shell, validates destinations and source hosts, and never writes to or deletes from the canonical master tree. Artifact deletion accepts only absolute imported paths that remain inside `TOMIFY_RECOVERY_DIR`, rejects non-regular files, moves artifacts into the `.tomify-deleted` trash rather than erasing them, and is idempotent when an artifact has already been removed.

## Media-server setup

Requirements: Node.js 20+, `yt-dlp`, `ffprobe` and `ffmpeg`, plus qBittorrent-nox and 7-Zip for torrent links. Internet Archive search/download uses Node's built-in HTTPS fetch and needs no provider credentials.

1. Copy `recovery-agent/recovery-agent.env.example` to `/etc/tomify/recovery-agent.env` and set a random `TOMIFY_RECOVERY_TOKEN` containing at least 32 characters.
2. Keep `TOMIFY_RECOVERY_DIR=/srv/music-recovery` separate from `TOMIFY_MASTER_DIR=/srv/music`.
   On the current box, recovered files physically live on the library SSD at `/srv/music/_Recovery` (so Navidrome sees them under the library), and `/srv/music-recovery` is a bind mount of that folder. The agent still only writes through `/srv/music-recovery`, never anywhere else under the master tree. See [Recovery files on the library SSD](#recovery-files-on-the-library-ssd).
3. Deploy the recovery-agent runtime from the primary Windows checkout at `C:\Users\TomDixon\Documents\tomify` with `scripts\deploy-agent.ps1` ([Updating the recovery agent](DEPLOYMENT.md#updating-the-recovery-agent)). Releases live under `/opt/tomify/releases`, with `/opt/tomify/current` pointing at the active one. The Debian box does not need a Git checkout and does not use `/srv/tomify/app`.
4. Put the agent behind an authenticated HTTPS reverse proxy that the hosted Tomify Worker can reach. The current deployment uses a Cloudflare Tunnel, run by the `tomify-recovery-cloudflared` Docker container on the box, which forwards `RECOVERY_AGENT_URL` to `127.0.0.1:8788`. Do not expose the unauthenticated loopback service directly. To run downloads over a VPN without breaking the tunnel or SSH, see [Running recovery downloads over NordVPN](#running-recovery-downloads-over-nordvpn).
5. Set hosted secrets `RECOVERY_AGENT_URL` and `RECOVERY_AGENT_TOKEN` for the Tomify Site, plus any optional artwork-provider configuration above, then redeploy.

The agent fails closed at startup when `TOMIFY_RECOVERY_TOKEN` is missing or shorter than 32 characters. Local development without authentication requires the explicit `TOMIFY_RECOVERY_ALLOW_INSECURE_LOOPBACK=true` opt-in and is accepted only with a loopback `TOMIFY_RECOVERY_HOST` such as `127.0.0.1` or `::1`. Never enable insecure mode on the Debian service.

### Recovery files on the library SSD

The 1.8 TB SSD (`/dev/sda1`) is mounted at `/srv/music` and holds all music, recovered files included. The NVMe system disk only holds in-progress torrent downloads (`/srv/torrents`), which are deleted after import. `/etc/fstab` contains:

```
UUID=0a4c05dc-3e2f-422f-8b0c-8c6e64639f8c /srv/music ext4 defaults,noatime 0 2
/srv/music/_Recovery /srv/music-recovery none bind,nofail,x-systemd.requires-mounts-for=/srv/music 0 0
```

`findmnt /srv/music-recovery` should show `SOURCE /dev/sda1[/_Recovery]`. If it shows an `nvme` source, the SSD is not mounted, or an older bind is still stacked on `/srv/music/_Recovery`. Stop `tomify-recovery` and Navidrome, run `sudo umount` on `/srv/music-recovery` and then on `/srv/music/_Recovery` until `findmnt /srv/music/_Recovery` prints nothing (unmount `/srv/music-mp3` first if it reports busy), then `sudo mount /srv/music-recovery` and `sudo mount /srv/music-mp3`.

Earlier deployments did it the other way round: the files sat on the NVMe at `/srv/music-recovery` and were bind-mounted into `/srv/music/_Recovery`. To move such a box over, arm a reboot fail-safe first (`sudo systemd-run --on-active=20min --unit=ssd-failsafe /bin/systemctl reboot`). Then:

1. Stop the agent and Navidrome, and unmount the old bind as above.
2. Copy the files with `sudo rsync -aHAX /srv/music-recovery/ /srv/music/_Recovery/` and check the sizes match with `du -sh`.
3. Move the old folder aside with `sudo mv /srv/music-recovery /srv/music-recovery.old`, then create an empty mount point with `sudo install -d -o tom -g tom /srv/music-recovery`.
4. Replace the old fstab line with the bind line above, run `sudo systemctl daemon-reload` and mount it.
5. Start the agent and Navidrome again.
6. Cancel the fail-safe (`sudo systemctl stop ssd-failsafe.timer`) and reboot once. Check `findmnt` again before deleting `/srv/music-recovery.old`.

### Updating the recovery agent

Moved to [DEPLOYMENT.md](DEPLOYMENT.md#updating-the-recovery-agent).

The recovery directory may be added to Navidrome as a separate library path after review. It should not be merged over `/srv/music` by an automated job.

## Adaptive streaming (HLS)

The agent also serves adaptive streams for the player (see the README, "Adaptive streaming"). The Worker route `GET /api/hls/<trackId>/<file>?u=&t=&s=` checks the listener's Navidrome login, then asks the agent for `GET /v1/hls/<trackId>/<file>` with the agent token and the listener's login. On the first request for a track the agent:

1. asks Navidrome for the track's size and length (`getSong`) and reads the exact length with ffprobe from the start of the stream,
2. starts one ffmpeg that reads the original straight from Navidrome (`stream.view?format=raw`, using the listener's login) as it downloads and writes all three bitrates (AAC 64k, 128k and 256k, 48 kHz stereo) as 6-second MPEG-TS chunks, and
3. answers playlists straight away from the track's length, serving each chunk as soon as ffmpeg finishes it, so playback starts within a second or so while encoding carries on at many times real time.

**Loudness-normalised streams.** `GET /api/hls/<trackId>/track/<file>` and `/album/<file>` (agent `/v1/hls/<trackId>/<track|album>/<file>`) ask for the same stream with the track's ReplayGain baked in: the agent reads `replayGain` from `getSong` and adds ffmpeg's `volume` filter with the track or album gain (album falls back to track and the other way round) lifted by 4 dB to play at -14 LUFS rather than the tags' -18, capped so peaks stay 1 dB below full scale (`shared/replaygain.mjs`). This is how the player normalises on an iPhone, where a web page can't change the volume. Each mode is packaged and cached separately (`<trackId>.track.p4`, `<trackId>.album.p4` beside `<trackId>` in the cache; the suffix is the pre-amp, so changing it packages normalised streams again and the old copies age out of the cache), so a device normalising by album uses up to one extra copy per track it plays. A track with no ReplayGain tags is packaged untouched. Retagging a file changes its size, so the next play packages it again with the new gain. The tags come from [ReplayGain tagging](#replaygain-tagging). An agent from before this change answers the mode paths with `not-found`, which the Worker reports as `hls-unavailable`, so a newer player falls back to original files: deploy the agent before a site that asks for normalised streams.

Once all three bitrates are written the chunks stay cached. The listener's login is in ffmpeg's command line while it runs, so it is visible to other accounts on the box in `ps`. A cached track is packaged again if Navidrome reports a different file size (the file was replaced). Only two tracks are packaged at once (the one playing and the pre-loaded next one); skipping through tracks stops the encoders of the ones skipped. The least recently played tracks are deleted once the cache passes its limit. A 4-minute song takes about 13 MB of cache.

Settings in `/etc/tomify/recovery-agent.env` (all optional):

| Variable | Default | Meaning |
| --- | --- | --- |
| `TOMIFY_HLS_ENABLED` | `true` | `false` turns adaptive streaming off; players then stream originals. |
| `TOMIFY_NAVIDROME_URL` | `http://127.0.0.1:4533` | Navidrome as the box itself reaches it. If nothing answers there (for example Navidrome in Docker without a published port), the agent fetches through the public Navidrome origin the Worker passes along instead, which works but sends each track out and back through the tunnel once. |
| `TOMIFY_HLS_CACHE_DIR` | `$TOMIFY_RECOVERY_STATE_DIR/hls-cache` | Must be writable by the service; `/var/cache/tomify-recovery/hls` is already allowed by the unit. |
| `TOMIFY_HLS_CACHE_MAX_BYTES` | `2147483648` (2 GB) | Cache size before old tracks are removed. |

No contract bump is needed: a site with this change talks to an older agent by falling back to original streams. After deploying the agent, check from the box with `curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" -H 'x-tomify-navidrome-user: <user>' -H 'x-tomify-navidrome-token: <token>' -H 'x-tomify-navidrome-salt: <salt>' http://127.0.0.1:8788/v1/hls/<trackId>/master.m3u8` (expect `200`), or just play a track in Tomify and watch for `/api/hls/` requests in the browser's network panel. If Navidrome listens on another port, set `TOMIFY_NAVIDROME_URL` and restart the agent.

## D1 migrations

Moved to [DEPLOYMENT.md](DEPLOYMENT.md#d1-migrations).

## Backups and uptime checks

Moved to [DEPLOYMENT.md](DEPLOYMENT.md#backups-and-uptime-checks).

## Restarting the media server from Tomify

**Settings → Restart media server** reboots the Debian box through the recovery agent's tunnel, for when SSH cannot reach it (for example after a VPN change). The button asks for confirmation, only Navidrome administrators may use it (the Worker checks `adminRole` with Navidrome's `getUser` API), and the agent waits three seconds after answering before running `systemctl reboot`. Playback, downloads and imports in progress stop, and the site is unavailable until the box and its tunnel containers are back.

It is off by default. To enable it on the server:

1. Add `TOMIFY_RECOVERY_ALLOW_REBOOT=true` to `/etc/tomify/recovery-agent.env`.
2. Allow the service account to reboot without a password with a polkit rule. Minimal Debian installs do not include polkit, so install it first (`/etc/polkit-1/rules.d` only exists once it is installed):

   ```bash
   sudo apt install polkitd
   sudo tee /etc/polkit-1/rules.d/50-tomify-reboot.rules >/dev/null <<'EOF'
   polkit.addRule(function (action, subject) {
     if ((action.id == "org.freedesktop.login1.reboot" || action.id == "org.freedesktop.login1.reboot-multiple-sessions") && subject.user == "tom") {
       return polkit.Result.YES
     }
   })
   EOF
   ```

   Check the rule without rebooting: `pkcheck --action-id org.freedesktop.login1.reboot --process $$ && echo allowed` should print `allowed`. Use the `User=` from the `tomify-recovery` unit if it is not `tom`. The rule covers only reboots; it grants no other privileges, and the unit keeps `NoNewPrivileges=true`.
3. Copy the updated agent files (including `system.mjs`) and run `sudo systemctl restart tomify-recovery`. `/v1/status` then reports `"reboot":"enabled"`.

If the agent has reboot disabled or has not been updated, the button shows the reason and nothing happens. The tunnel and the agent must still be reachable for the button to work, so it cannot help when the whole box is offline.

## VPN and library scan controls in Settings

Settings is only shown to Navidrome administrators (on mobile, through the account button in the top bar): everyone else sees just a sign-out button, and the Worker and Navidrome check `adminRole` again on every admin action, so hiding the page is not the only guard.

**Full library scan** calls Navidrome's `startScan` with `fullScan=true`, which rescans every file instead of only changed folders, then follows `getScanStatus` until it finishes. It needs no agent changes; Navidrome refuses it for non-administrators.

**VPN** shows NordVPN's status (country, city, server and IP) and has **Connect** and **Disconnect** buttons. Connect always goes to `TOMIFY_VPN_CONNECT_TARGET` (default `United_Kingdom`); the browser cannot pick a server. Disconnecting asks first: torrents stop (qBittorrent is bound to `nordlynx`) and SABnzbd and yt-dlp use the home connection until you reconnect. Disconnecting does not turn autoconnect off, so the next reboot reconnects.

Neither action touches the allowlist, Tailscale or the tunnel containers. Both are safe only because NordVPN's firewall and kill switch are off (see below): with the kill switch on, a disconnect cuts the box off the internet, and with the firewall on, Tailscale drops. The agent reads `nordvpn settings` before every change and refuses unless both read as disabled.

To enable it on the box:

1. Add `TOMIFY_RECOVERY_ALLOW_VPN_CONTROL=true` to `/etc/tomify/recovery-agent.env` (and optionally `TOMIFY_VPN_CONNECT_TARGET=United_Kingdom`).
2. Let the service account talk to `nordvpnd`. The CLI needs membership of the `nordvpn` group; check with `id tom` and, if it is missing, run `sudo usermod -aG nordvpn tom` (use the unit's `User=` if it is not `tom`). No sudoers or polkit rule is needed.
3. Copy the updated agent files (including `vpn.mjs`) and run `sudo systemctl restart tomify-recovery`; the restart also picks up the new group. `/v1/status` then reports `"vpn":"enabled"`.
4. Check from the box, as the service account: `sudo -u tom nordvpn status` should print the status rather than a permission error.

If the button shows *VPN control is turned off*, step 1 is missing; *NordVPN did not answer* usually means step 2 is missing or `nordvpnd` is not running.

When Connect or Disconnect fails, the card shows what `nordvpn` printed (for example *You are not logged in*). Agents before this change showed only `nordvpn failed: exit 1`; run the same command on the box (`nordvpn connect United_Kingdom`) to see the reason.

The agent's unit hides `/home` (`ProtectHome=true`), so the agent gives the `nordvpn` CLI its own home under the state directory (`<TOMIFY_RECOVERY_STATE_DIR>/nordvpn-cli`). An older agent fails with `mkdir /home/tom: permission denied`; copying the current agent files fixes it.

## Running recovery downloads over NordVPN

The recovery side (yt-dlp, Internet Archive fetches and SABnzbd) can run over NordVPN, but the box also has to keep accepting SSH from the LAN and over Tailscale, and keep its Cloudflare Tunnel up. The hosted Worker never connects to the box directly: it calls `RECOVERY_AGENT_URL`, which Cloudflare routes down a tunnel to the agent on `127.0.0.1:8788`. Two `cloudflared` Docker containers run on the box: `tomify-recovery-cloudflared` for the agent and `cloudflared` for Navidrome. `cloudflared` only makes outbound connections to Cloudflare's tunnel edge, so nothing needs to be port-forwarded, but those connections must survive the VPN.

Connecting the NordVPN Linux client with default settings breaks both: its firewall drops inbound LAN traffic, so SSH stops answering, and the tunnel's edge connections are torn down when the default route moves into the VPN. With autoconnect or the kill switch on, this persists across reboots. The setup below keeps the whole box on the VPN, with three exceptions: the LAN, inbound SSH, and Cloudflare's tunnel edge.

### If you are locked out

If the site still works, use **Settings → Restart media server** (see [Restarting the media server from Tomify](#restarting-the-media-server-from-tomify)); with `nordvpnd` disabled at boot the box returns with the VPN off. Otherwise:

If `nordvpnd` is disabled at boot (`sudo systemctl disable nordvpnd`, as the steps below do until the setup is proven), a power cycle brings the box back with the VPN off. If it is still enabled and autoconnect is on, a power cycle alone is not enough, because NordVPN reconnects during boot. Use a keyboard and monitor on the box if you can. Otherwise, from the LAN, start this loop on the Windows PC before powering the box back on; it retries until SSH answers in the gap before NordVPN connects:

```powershell
while ($true) { ssh -o ConnectTimeout=3 -t tom@tomify "sudo systemctl stop nordvpnd" ; if ($LASTEXITCODE -eq 0) { break } ; Start-Sleep 1 }
```

Once you have a shell, stop NordVPN from taking the box again before changing anything else:

```bash
sudo systemctl disable nordvpnd  # never start NordVPN at boot until the setup below is proven
sudo systemctl stop nordvpnd     # drops the VPN and its firewall rules (skip if the loop above already did this)
sudo systemctl start nordvpnd    # runs it for this session only, disconnected
nordvpn disconnect
nordvpn set autoconnect off
nordvpn set killswitch off
nordvpn settings                 # confirm both are now disabled
```

Then confirm the site's link to the agent is back:

```bash
docker ps --filter name=cloudflared         # tomify-recovery-cloudflared and cloudflared should both be Up
systemctl status tomify-recovery --no-pager
curl -s http://127.0.0.1:8788/health; echo
```

If a tunnel container has stopped or its logs (`docker logs --tail 20 tomify-recovery-cloudflared`) show repeated errors, restart it with `docker restart tomify-recovery-cloudflared` (or `cloudflared`). The account running `nordvpn` must be in the `nordvpn` group (`sudo usermod -aG nordvpn tom`, then log in again).

### Allowlist the LAN, SSH and the tunnel

Find the LAN subnet first (the `/24`-style network on the interface that carries the default route):

```bash
ip -4 route show default          # e.g. "default via 192.168.1.1 dev enp3s0"
ip -4 -br addr show               # e.g. "enp3s0 UP 192.168.1.20/24" means 192.168.1.0/24
```

Then, with NordVPN still disconnected:

```bash
sudo systemctl start nordvpnd                    # the settings below need the service running; it stays disconnected
nordvpn set lan-discovery enable                 # keeps all private LAN ranges reachable, including yours
nordvpn allowlist add port 22 protocol TCP       # inbound SSH
nordvpn allowlist add subnet 198.41.192.0/19     # Cloudflare Tunnel edge (region1 and region2)
nordvpn allowlist add subnet 100.64.0.0/10       # Tailscale addresses (SSH over the tailnet)
nordvpn allowlist add port 41641 protocol UDP    # Tailscale direct connections stay outside the VPN
nordvpn settings                                 # check the allowlist
```

Tailscale addresses (`100.x.y.z`) sit in the carrier-grade NAT range, which LAN discovery does not treat as local, so SSH over Tailscale needs the two Tailscale lines above; restart `tailscaled` after adding them if the box is already connected. LAN discovery replaces allowlisting your LAN subnet by hand; NordVPN refuses to allowlist a private subnet while it is on, so knowing the subnet is only useful for checking that it is a private range (192.168.x.x, 10.x.x.x or 172.16–31.x.x). Allowlisted subnets are routed outside the VPN, so the tunnel keeps connecting from the home connection, just as it did before. `198.41.192.0/19` covers the IPv4 addresses behind `region1.v2.argotunnel.com` and `region2.v2.argotunnel.com` used by both tunnel protocols (QUIC and HTTP/2 on port 7844). To make sure `cloudflared` does not try IPv6 edges, which the allowlist above does not cover, set `TUNNEL_EDGE_IP_VERSION=4` in both containers' environment (or add `--edge-ip-version 4` to their `tunnel run` command) and recreate them.

### Connect with a fail-safe

Arm an automatic reboot before the first connection, so a mistake undoes itself after ten minutes instead of needing someone at the box. With `nordvpnd` disabled at boot, the reboot always comes back with the VPN off; stopping the service alone has been seen to leave Tailscale unreachable:

```bash
systemctl is-enabled nordvpnd                   # must say disabled, or the reboot reconnects the VPN
sudo systemd-run --on-active=10min --unit=nordvpn-failsafe /bin/systemctl reboot
nordvpn connect
```

From another terminal on the Windows PC, check that a **new** SSH session opens (`ssh tom@tomify`; if that name resolves to the box's Tailscale address this also proves Tailscale works), then on the box:

```bash
nordvpn status                                  # Connected
curl -s https://api.ipify.org; echo             # a NordVPN address, not your home IP
docker logs --tail 20 tomify-recovery-cloudflared   # "Registered tunnel connection", no repeated errors
docker logs --tail 20 cloudflared
curl -s http://127.0.0.1:8788/health; echo
```

Finally open Recovery on the site and run a search. If everything works, cancel the fail-safe and only then make it persistent:

```bash
sudo systemctl stop nordvpn-failsafe.timer
sudo systemctl enable nordvpnd
nordvpn set autoconnect on United_Kingdom
nordvpn set firewall off         # required for Tailscale; see below
nordvpn set killswitch off       # the kill switch needs NordVPN's firewall
```

Then reboot once (Settings → Restart media server, or `sudo reboot`) and repeat the SSH, tunnel container and Recovery checks to confirm autoconnect comes up with the allowlist in place. If SSH does not come back, revoke the NordVPN token in your Nord Account and press **Restart media server** again: autoconnect cannot log in, so the box boots with the VPN off.

### Tailscale and NordVPN's firewall

`tailscaled` marks its own traffic (fwmark `0x80000`) and routes it outside every VPN through the main table (`ip rule` priority 5210). NordVPN's firewall drops that traffic. A `tailscaled` that logged in before NordVPN connected keeps its existing connections and appears to work, but as soon as it restarts or has to reconnect to Tailscale's servers it stays logged out (`fetch control key ... cannot assign requested address` in `journalctl -u tailscaled`) and Tailscale SSH is gone until the next reboot. Restarting `tailscaled` after NordVPN connects makes this worse, not better. An earlier `tailscale-after-nordvpn` unit did exactly that and caused drops about five minutes after each boot.

The fix is to turn NordVPN's firewall off: `nordvpn set firewall off`. NordVPN's routing still sends all traffic through the tunnel, and the allowlist still keeps the LAN, SSH and the Cloudflare tunnel off it. A restarted `tailscaled` logs straight back in (confirmed on the Debian box, 2026-10-15). The trade-off is what happens if the VPN drops. qBittorrent stops, because it is bound to `nordlynx`. SABnzbd, yt-dlp and Internet Archive downloads use the home connection until NordVPN reconnects. If you installed the old unit, remove it:

```bash
sudo systemctl disable --now tailscale-after-nordvpn.service
sudo rm /etc/systemd/system/tailscale-after-nordvpn.service
sudo systemctl daemon-reload
```

`tailscale status` should list the box without `offline`. If NordVPN uses OpenVPN rather than NordLynx, the qBittorrent interface is `nordtun` instead of `nordlynx`.

### What goes over the VPN

With this setup everything the box starts outbound goes through NordVPN except LAN traffic, inbound SSH, the tunnel and Tailscale's own connections: yt-dlp, Internet Archive downloads, NZBIndex and Newznab searches, qBittorrent's torrent searches, SABnzbd's connections to the Usenet provider, artwork fetches and MusicBrainz lookups from the agent. Playback and the Worker's calls to the agent keep using the tunnel, so their speed is unchanged. If SABnzbd runs in Docker its traffic is routed the same way; if downloads stall after connecting, check that the container can still resolve DNS (`docker exec <container> getent hosts nzbindex.com`).

## Internet Archive backend

Internet Archive candidates are discovered with field-restricted public audio searches, then verified against the item's current Metadata API file list before import. Tomify constructs the download URL from the validated item identifier and filename rather than trusting a browser-supplied URL. Downloads are HTTPS-only, redirects are limited to `archive.org` and its download hosts, and the default maximum file size is 1 GiB. Operators can lower or raise that bound with `TOMIFY_ARCHIVE_MAX_BYTES`.

The candidate review links to the Archive item so the user can inspect its description, uploader, licence and rights statement. Archive availability alone is not permission: import still requires the same explicit authorisation basis. Provenance records the item/file identifiers, final download URL, creator, collection, licence/rights fields, file format/source, byte count and supplied hashes. The downloaded bytes are preserved unchanged in `.tomify-source`; tagging and artwork are applied only to the stream-copy derivative.

## Newznab, NZBIndex and Usenet backend

The optional Usenet backend searches one or more Newznab-compatible indexers, NZBIndex, or both, and queues an explicitly selected result in either SABnzbd or NZBGet. Searches combine any mix of artist, release/album and track title (at least one) into a single query, always ordered artist, album, track. The older single-field modes (`artist`, `track`, `release`) are still accepted. Results are shown in a provider-neutral review list with their indexer, title, advertised size, age when available, and a link to the provider's detail page. Search results are not treated as evidence of permission.

While a search runs, the Recovery item shows which provider it is searching (*Searching NZB indexers…*) and its search buttons are disabled; when it finishes, the same place reports how many results were found or why the search failed.

Import scope follows the fields searched. Any search that includes the track title imports only the completed audio file that best matches the wanted track. A search that includes the album but not the track title imports every valid supported audio file from the completed release into its album directory, preserving each original and creating one stream-copy derivative and provenance sidecar per track. An artist-only search for a wanted track imports only the best matching wanted track. For wanted music with no track title (just an artist), an artist-only search imports the selected download as a release, the same as an album search. The release's own artist is written with one spelling on every track, even when the download's tags spell it several ways (`Earth Wind & Fire`, `Earth, Wind And Fire`…), so Navidrome lists one artist. Names are compared ignoring case, accents, punctuation, `&` versus `and` and a leading `The`; the spelling of a matching artist folder in `TOMIFY_MASTER_DIR` wins, otherwise the download's most common spelling. Guest and collaboration credits (`… with The Emotions`) are left as tagged. Every track of an album gets the same album artist, so Navidrome keeps the album whole: an album-artist tag in the download wins; without one, the release's artist when it appears on the album (so a guest track keeps its own artist but stays on the album), else an artist on more than half the tracks, else `Various Artists`. A download that holds several albums (a discography) is split by album: each album goes into its own `Artist/Album` folder, using the album tag, or for untagged files the folder they sit in (a `CD1` or `Disc 2` folder names the disc and its parent the album, and trailing notes such as `[FLAC]` are dropped).

Before **Confirm and import**, the confirm step runs a duplicate preflight (`GET /api/recovery/:id/preflight`, Worker feature `worker/features/preflight.ts`). The Worker asks the agent's read-only `POST /v1/preflight` what the target release directory already holds, and searches Navidrome (`search3`) for the album, or for the track when only one track is being imported, by the same artist. Anything found is shown as a warning such as *1 track already in recovery, Flood is already in your library (12 tracks)*. For a release download with tracks already in recovery, **Skip tracks I already have** is ticked by default and sent to acquire as `skipExisting`: the release import then leaves out any track whose MusicBrainz recording ID, or normalised title plus track number, already exists in the destination folder (`skippedExistingCount` in the result). An agent without `/v1/preflight` answers 404, which the Worker reports as unknown (`recovery: null`) without blocking the import; an older agent also ignores `skipExisting`.

When a track-level import came from a download that holds more audio (a whole album, say), the imported item offers **Import rest of download** beside its *Imported* badge. The agent re-reads the completed download, skips the files that job already imported, and imports the rest as a release without downloading again. The new tracks are added to the same Recovery item, so deleting it still removes every file it imported. The action needs an agent with the `/v1/jobs/import-remaining` endpoint; an older agent is reported as out of date.

For release imports, embedded title, artist, album artist, album, track/disc number, and date tags are preferred per track. Selected release metadata supplies artist, album, date, release ID, and release-group ID only when source tags are missing. Filename order is the final fallback for title and numbering. Tomify never applies the seed track's MusicBrainz recording ID or ISRC to the other tracks. Artwork is prepared once and shared across the album. When a download splits into several albums, the chosen artwork and the wanted item's release ID and date go only on the album you asked for (none, for artist-only wanted music); the other albums keep their own tags and get no `cover.jpg`. Two files that still end up with the same name in one folder (a repeated track, or two copies of an album) are both kept, the second as `Title (2)`. A release also never fails because a track's name is already taken in the recovery library: a track whose preserved original there is byte-for-byte the same file is skipped as already recovered (`alreadyPresentCount` in the result), and one whose name holds a different recording is imported as `Title (2)`. Only when every track is already there does the import fail, with *Every track in this download is already in the recovery library.* A single-track import still refuses to overwrite an existing copy. Existing artist/album directories are reused ignoring case and accents (so `Mötley Crüe` joins an existing `Motley Crue` folder) without renaming unrelated directories.

Source tags are read as UTF-8, and any bytes that are not valid UTF-8 (some FLAC rips store Latin-1 or Windows-1252 Vorbis comments) are decoded as Windows-1252 instead of being replaced with `�`. When a release's artist or album tag differs from what you asked for only by accents, or still contains `�`, the requested spelling is used so the import lands under the artist you already have in Navidrome; other differences keep the source tag.

### Repairing tags mangled before this fix

Agents older than the tag-encoding fix wrote `�` (U+FFFD) into recovered copies whose source tags were not UTF-8, which shows up in Navidrome as a second artist such as `M�tley Cr�e`. The untouched original of each recovered track is kept in the album's `.tomify-source` folder, so the real characters can be restored from it. On the box (FLAC imports; needs the `flac` package for `metaflac`):

```bash
sudo apt-get install -y flac
cat > /tmp/fix-mangled-tags.sh <<'EOF'
#!/bin/bash
# Restores tags containing U+FFFD in recovered FLACs from the Windows-1252 originals in .tomify-source.
bad=$'\xef\xbf\xbd'
find /srv/music-recovery -name '*.flac' -not -path '*/.tomify-source/*' -print0 | while IFS= read -r -d '' file; do
  metaflac --no-utf8-convert --export-tags-to=- "$file" | grep -q "$bad" || continue
  original="$(dirname "$file")/.tomify-source/$(basename "$file")"
  [ -f "$original" ] || { echo "No original for: $file"; continue; }
  metaflac --no-utf8-convert --export-tags-to=- "$file" | grep "$bad" | cut -d= -f1 | sort -u | while IFS= read -r tag; do
    sources="$tag"; [ "${tag^^}" = ALBUMARTIST ] && sources="ALBUMARTIST ALBUM_ARTIST ARTIST"
    value=""
    for source in $sources; do
      value=$(metaflac --no-utf8-convert --show-tag="$source" "$original" | head -n1 | cut -d= -f2- | iconv -f WINDOWS-1252 -t UTF-8)
      [ -n "$value" ] && break
    done
    [ -n "$value" ] || { echo "No $tag in original: $file"; continue; }
    metaflac --no-utf8-convert --remove-tag="$tag" --set-tag="$tag=$value" "$file" && echo "Fixed $tag=$value in: $file"
  done
done
EOF
sudo bash /tmp/fix-mangled-tags.sh
```

The folder the old agent created is still named with `�`, which `ls /srv/music-recovery` shows as `?`. Rename it with a `?` wildcard so later imports find it, for example `sudo mv /srv/music-recovery/M?tley\ Cr?e "/srv/music-recovery/Mötley Crüe"` (if that name already exists, move the album folder inside it instead).

If the restored name is spelled differently from an artist you already have (for example `Mötley Crüe` next to `Motley Crue`), Navidrome still lists two artists. Set the recovered album to the existing spelling, then run a full scan in Navidrome so the two artists merge:

```bash
sudo find "/srv/music-recovery/<Artist folder>/<Album folder>" -maxdepth 1 -name '*.flac' \
  -exec metaflac --no-utf8-convert --remove-tag=ARTIST --remove-tag=ALBUMARTIST --set-tag='ARTIST=Motley Crue' --set-tag='ALBUMARTIST=Motley Crue' {} +
```

### Merging an artist imported under several spellings

Agents older than the artist-spelling fix kept each track's own artist tag, so a discography whose tags spelled the band several ways shows up in Navidrome as several artists (`Earth Wind & Fire`, `Earth, Wind And Fire`, …). Older agents also used a track's own artist as its album artist when the album-artist tag was missing, so a guest track (`Deniece Williams` on an Earth, Wind & Fire compilation) split off as its own album. The script below fixes both: in every recovered album folder where the artist appears, it sets every track's album artist to one spelling, and every artist tag that is a spelling of the same name (compared the way the agent does). Guest track artists and albums by other artists or collaborations are left alone. It is safe to run more than once. It needs `metaflac` from the `flac` package:

```bash
cat > /tmp/merge-artist.py <<'EOF'
import re, subprocess, sys, unicodedata
from collections import defaultdict
from pathlib import Path
canonical, root = sys.argv[1], Path(sys.argv[2] if len(sys.argv) > 2 else '/srv/music-recovery')
def key(value):
    words = re.sub(r'[^a-z0-9 ]', ' ', unicodedata.normalize('NFKD', value).encode('ascii', 'ignore').decode().lower().replace('&', ' and ')).split()
    return ''.join(words[1:] if words[:1] == ['the'] else words)
def tags(path):
    lines = subprocess.run(['metaflac', '--no-utf8-convert', '--export-tags-to=-', str(path)], capture_output=True, text=True).stdout.splitlines()
    return [(name, value) for name, _, value in (line.partition('=') for line in lines)]
target = key(canonical)
albums = defaultdict(list)
for path in sorted(root.rglob('*.flac')):
    if '.tomify-source' not in path.parts: albums[path.parent].append((path, tags(path)))
for folder, tracks in albums.items():
    # Only albums where the artist appears; every track there takes it as album artist so the album stays whole.
    if not any(name.upper() in ('ARTIST', 'ALBUMARTIST', 'ALBUM_ARTIST') and key(value) == target for _, found in tracks for name, value in found): continue
    for path, found in tracks:
        album_artist = [value for name, value in found if name.upper() in ('ALBUMARTIST', 'ALBUM_ARTIST')]
        artist_names = sorted({name for name, value in found if name.upper() == 'ARTIST' and key(value) == target and value != canonical})
        if album_artist == [canonical] and not artist_names: continue
        args = ['metaflac', '--no-utf8-convert', '--remove-tag=ALBUMARTIST', '--remove-tag=ALBUM_ARTIST', '--remove-tag=album_artist', f'--set-tag=ALBUMARTIST={canonical}']
        args += [f'--remove-tag={name}' for name in artist_names] + [f'--set-tag={name}={canonical}' for name in artist_names]
        subprocess.run(args + [str(path)], check=True)
        print('Fixed', path)
EOF
sudo python3 /tmp/merge-artist.py 'Earth, Wind & Fire'
```

Then run a full scan in Navidrome. The album folders stay where they are (the Recovery item records those paths), which Navidrome does not mind: it groups artists by tag, not by folder.

This backend is for lawful recovery only. The operator must retrieve only content they are authorised to copy. Tomify does not bypass subscriptions, authentication, takedowns, encryption, or other access controls. Acquisition remains disabled until the existing source-specific authorisation confirmation is completed for the selected result.

Keep all indexer and downloader credentials on the recovery server. Newznab remains supported: configure `TOMIFY_NEWZNAB_INDEXERS_JSON` as a JSON array of `{ "id", "name", "url", "apiKey", "categories" }` objects in `/etc/tomify/recovery-agent.env`.

NZBIndex needs no account or API key for normal use. Tomify enables its documented search and NZB download endpoints by default and makes anonymous requests when `TOMIFY_NZBINDEX_API_KEY` is unset or blank. Although the current API page describes the `key` query parameter as required, both endpoints currently accept anonymous requests. If NZBIndex has separately issued you a key, you may add it to the protected server environment file; do not put it in Worker variables, D1, the browser, or a URL stored in Tomify:

```text
TOMIFY_NZBINDEX_API_KEY=
```

No base URL is required: Tomify uses the documented `https://api.nzbindex.com/api/search` and `/api/download/{collection-id}.nzb` endpoints, and links reviews to `https://www.nzbindex.com/collection/{collection-id}`. Searches request complete collections only, explicitly incomplete results are discarded, and a stale incomplete candidate cannot be submitted to a downloader. In release mode, non-initial numbered multipart entries such as `[092/284]` are also discarded because they represent one fragment rather than the complete release; initial collection entries such as `[001/109]` remain eligible. When a non-empty optional API key is configured, Tomify attaches it as the documented `key` query parameter only to server-to-server search and NZB download requests. Newznab and NZBIndex can be used together by configuring `TOMIFY_NEWZNAB_INDEXERS_JSON`; leave it as `[]` to use NZBIndex alone.

Configure exactly one downloader:

```text
TOMIFY_SABNZBD_URL=http://127.0.0.1:8080
TOMIFY_SABNZBD_API_KEY=replace-me
TOMIFY_SABNZBD_CLEANUP=false
TOMIFY_SABNZBD_DOWNLOAD_DIR=/downloads
TOMIFY_USENET_DOWNLOAD_DIR=/srv/usenet/completed
TOMIFY_USENET_CATEGORY=music
TOMIFY_USENET_MAX_BYTES=2147483648
TOMIFY_DOWNLOADER_LOST_MINUTES=15
TOMIFY_RECOVERY_STATE_DIR=/var/lib/tomify-recovery
```

`TOMIFY_USENET_DOWNLOAD_DIR` is the completed-download root visible to the Tomify host. Set `TOMIFY_SABNZBD_DOWNLOAD_DIR` only when SABnzbd reports a different root, such as `/downloads` inside a Docker container mapped to the host's `/srv/usenet/completed`. Tomify accepts a SAB completion path only when it is contained beneath that downloader-visible root, translates the relative suffix to the host root, then applies the existing realpath, containment, file-type, symlink, file-count, and size checks.

`TOMIFY_SABNZBD_CLEANUP=true` optionally removes SABnzbd's completed download folder after every selected track has imported successfully. It defaults to off. Cleanup resolves the real host path again and deletes only a directory strictly inside `TOMIFY_USENET_DOWNLOAD_DIR`; it refuses the root itself, files, and paths outside that root. Enabling it means **Import rest of download** is no longer available after the first import because the completed source has been removed.

For NZBGet, use `TOMIFY_NZBGET_URL`, `TOMIFY_NZBGET_USERNAME`, and `TOMIFY_NZBGET_PASSWORD` instead of the SABnzbd settings. `TOMIFY_SABNZBD_DOWNLOAD_DIR` does not apply to NZBGet. Indexer URLs must use HTTPS, except for loopback development services. Credentials and credential-bearing NZB download URLs are used only by the recovery agent; they are never returned to the Worker, browser, D1, or provenance.

If a job disappears from both the downloader queue and history, Tomify records the first missing time in that job's state file. It keeps waiting during `TOMIFY_DOWNLOADER_LOST_MINUTES` (15 by default), including across agent restarts, then fails the job with `downloader-lost` instead of leaving it queued forever. If the downloader reports the job again before the timeout, the missing timer is cleared.

Restart the service after editing the environment, then confirm that the agent is healthy. The unauthenticated endpoint intentionally returns only `{"ok":true,"version":null}` unless `TOMIFY_VERSION` or a package version is available; backend details plus `version` and contract `2` remain on authenticated `/v1/status` and in Settings:

```bash
sudo systemctl restart tomify-recovery
curl -s http://127.0.0.1:8788/health
echo
```

NZBIndex always counts as an available indexer, with or without its optional key. Usenet is available when exactly one downloader is configured and `TOMIFY_USENET_DOWNLOAD_DIR` is set; configured Newznab indexers are searched alongside NZBIndex.

Acquisition is asynchronous, and the agent finishes every job on its own (see [Background jobs](#background-jobs)). The UI reports queued, downloading, importing, completed, or failed job state and progress while polling through the Worker; the poll only reads the job, so closing the page does not stop a download or an import. Poll rounds never overlap: the next three-second delay begins only after every active request in the current round has settled. When the downloader completes, the agent persists `importing` before touching the recovery library, and its per-job lock prevents a timer tick and anything else from starting the import twice. The agent then resolves the downloader path and rejects anything outside `TOMIFY_USENET_DOWNLOAD_DIR`, symlinks, non-regular files, excessive file counts, and downloads over `TOMIFY_USENET_MAX_BYTES`. It verifies selected audio with FFprobe, preserves unchanged sources beneath `.tomify-source`, and creates Navidrome-facing derivatives through the same stream-copy and metadata pipeline as other Recovery sources. Existing recovery artifacts and canonical masters are never overwritten. When the downloader marks a job failed, its own reason (for example missing articles or a failed repair) is kept as the job error and shown on the Recovery item. A completed release job retains the backward-compatible primary `path`, `quality`, `derivative`, and `provenance` fields and also returns `importedCount`, `importedTracks`, plus release artist/album summaries. `album` is null when the release spanned several albums, and `albums` lists each album with its track count.

### Background jobs

The agent runs its own job runner (`recovery-agent/jobs.mjs`). On start-up it loads every job in `TOMIFY_RECOVERY_STATE_DIR` that is not `completed` or `failed`, including one interrupted mid-import, and then advances each one every `TOMIFY_JOB_POLL_SECONDS` (10 by default): it asks the downloader for progress, and once the download is complete it imports it. A newly queued job is picked up straight away. While no job is active the runner checks the state directory less and less often, up to every five minutes. A job that is still importing when the next tick comes is skipped rather than started again, so one long import never holds up the others.

`POST /v1/jobs/status` only reads the stored job. The Recovery page's poll goes through the Worker's `GET /api/recovery/:id/job`, which copies the agent's answer onto the Recovery item so the page shows progress, but it no longer drives the job. An item whose job finished while no browser was open shows as imported the next time the Recovery page is opened.

With a Worker that has this change, YouTube and Internet Archive imports are queued the same way: `POST /v1/acquire` answers `202` with a job, and the runner downloads and imports it.

### Crash-safe imports

Every import (Usenet and torrent releases, YouTube and Internet Archive) first prepares all its files in `TOMIFY_RECOVERY_STATE_DIR/import-staging/<job id>/`: the tagged derivatives, the provenance sidecars and any downloaded source and artwork. It then writes a manifest to `TOMIFY_RECOVERY_STATE_DIR/import-manifests/<job id>.json` before committing the first file. The manifest lists every planned destination with its source and expected sha256, and is rewritten (temporary file, then rename) as each file is committed. Staging lives in the state directory rather than `/tmp` because the agent's unit has `PrivateTmp=true`, which empties `/tmp` on every restart. A release therefore needs room for all its derivatives in the state directory at once, about the size of the download again.

If the agent stops part-way (a crash, a restart, a reboot), the runner settles the import on start-up, before it advances any job:

- A job left `importing` with a manifest is resumed. A destination that already holds the expected sha256 counts as committed, and the remaining files are committed from their sources. The job is then `completed` with the result it would have had, and a torrent's unpacked copy and torrent are removed as after a normal import.
- When a source it still needs is gone or changed (for example the completed download was deleted), every file the manifest says this import committed is removed and the job is marked `failed` with a message saying so. Queue the item again to retry.
- A destination whose sha256 no longer matches the manifest is never deleted or overwritten. The import is rolled back around it, the job fails with a message naming the file, and the path is kept on the job as `importConflicts`. A `cover.jpg` that appeared meanwhile is simply kept, as before.
- A job left `importing` with no manifest had not committed anything yet, so it is imported again from the start.

An import that fails while the agent is running is rolled back the same way, straight away. The manifest and staging directory are removed once the job is saved as completed or failed. An interrupted import whose job no longer exists (one started by an older Worker that waited for the answer) is rolled back on start-up.

This needs the agent redeployed with the new `recovery-agent/manifest.mjs` (the copy in [Updating the recovery agent](#updating-the-recovery-agent) includes it). Restarting the agent with an import in progress is then safe: the import finishes after the restart. `TOMIFY_RECOVERY_STATE_DIR` must stay on a disk that survives reboots (`/var/lib/tomify-recovery` in the example unit).

```text
TOMIFY_JOB_POLL_SECONDS=10
```

The job runner needs the agent to be redeployed (see [Updating the recovery agent](#updating-the-recovery-agent)). Either side can be updated first. An older Worker against this agent still polls the read-only status and still gets synchronous YouTube and Internet Archive imports, because it does not ask for a job. This Worker against an older agent still works too: the older agent ignores the request for a job and imports synchronously, and its status endpoint still advances jobs while the page is open, as before.

## Torrent links and qBittorrent

Each Recovery item has a **Torrent link** field beside the search buttons. Paste a magnet link or an `http(s)` link to a `.torrent` file and press **Add link**: the agent checks the link and Tomify adds it as the item's torrent candidate and selects it, which opens the usual MusicBrainz and artwork review. Import still needs the source-specific authorisation confirmation. The link is then queued in qBittorrent-nox on the media server, and the Recovery row shows live progress: percentage, download speed, connected seeds and peers (with the swarm totals in brackets), downloaded size and time left.

qBittorrent downloads up to `TOMIFY_TORRENT_MAX_ACTIVE` torrents at once (5 by default); any more wait as **Queued in qBittorrent**. The agent sets qBittorrent's queue limits to match the first time it adds or checks a torrent after starting: maximum active downloads and uploads to that number, and maximum active torrents to twice it, so finished torrents waiting to be imported do not hold up new downloads. Change the number in `/etc/tomify/recovery-agent.env` and restart the agent; changing the limits in qBittorrent's own settings is undone at the next agent start.

When qBittorrent finishes, the agent:

1. Resolves the torrent's content path and rejects anything outside `TOMIFY_TORRENT_DOWNLOAD_DIR`, symlinks, more than `TOMIFY_TORRENT_MAX_FILES` files and folders (10,000 by default) and downloads over `TOMIFY_TORRENT_MAX_BYTES` (4 GiB by default; larger torrents are failed and removed as soon as their size is known).
2. Unpacks any `.zip`, `.rar` or `.7z` archives (first volumes only, so multi-part sets are read once) into its own folder under `TOMIFY_RECOVERY_STATE_DIR`. Every archive is listed first and refused if an entry is absolute, climbs out with `..`, is a symbolic link, or would unpack beyond the size limit. Password-protected or damaged archives fail the job with a message naming the archive.
3. Splits whole-disc images into tracks. A `.flac` or `.wav` that has a `.cue` sheet beside it (one file per CD, common in discographies) is cut into one FLAC per track with ffmpeg, losslessly, using the sheet's track starts (`INDEX 01`). Each track is tagged with its title and artist, the album title without a "(CD1)" marker, track number and total, and disc number (`REM DISCNUMBER`, else "CD1"/"Disc 2" in the title or file name). Split tracks are written to the agent's own folder, never next to qBittorrent's copy. A sheet that names several files, has fewer than two tracks or has out-of-order starts is ignored, and an image that fails to split is imported whole as before.
4. Imports the audio through the same pipeline as Usenet: wanted music with a track title imports the best matching file, and wanted music without one (an album, or anything by an artist) imports the whole download as a release, with originals preserved in `.tomify-source`, stream-copy derivatives, artwork and `.tomify.json` sidecars marked `torrent-recovery-copy`.
5. Removes the torrent and its downloaded data from qBittorrent, and deletes the unpacked archive and split-track copies. A failed removal is recorded on the job without undoing the import. Because nothing is left behind, torrents do not offer **Import rest of download**; for a whole album, leave the track blank on the wanted item before pasting the link.

**Delete** works on a queued or downloading torrent item: the agent stops the torrent and removes it and its data from qBittorrent first, then Tomify deletes any imported files and the queue entry. If qBittorrent cannot be reached the item is kept so you can retry. Deletion is blocked while any backend is importing, and active Usenet downloads still have to finish before their item can be deleted.

Links are validated on the agent: magnet links need a BitTorrent info hash, and `.torrent` links must be `http(s)` on a public host, without embedded credentials. The full link (including trackers or a private-tracker passkey) is stored with the candidate so it can be queued later, but the Recovery page and provenance show it without trackers or query strings. Torrents are removed as soon as they are imported, so they do not keep seeding; respect any ratio rules of a private tracker you use.

When a torrent downloads but its import fails, the torrent and its data stay in qBittorrent. To retry, paste the same link again, select it and confirm the import: the agent finds that torrent (by its info hash, or for a `.torrent` file link by the earlier failed job for the same link), moves it over to the new job, and imports it straight away without downloading again. It only does this for a torrent Tomify added that no other job is still using; otherwise qBittorrent refuses the duplicate as before. Deleting the failed item instead removes the torrent and its data.

The same lawful-recovery rules as Usenet apply: only retrieve content you are authorised to copy.

## Torrent search

**Search torrents** sits next to **Search NZB** and uses the same Artist / Album / Track boxes. The agent asks qBittorrent-nox to run all its enabled search plugins in the Music category and, at the same time, searches every indexer in `TOMIFY_TORRENT_INDEXERS_JSON` (see [Prowlarr or Jackett](#prowlarr-or-jackett)). It waits up to 25 seconds and returns up to 12 results. Only results with at least one seed are kept (sources that cannot tell report no seed count, and those results are dropped too), sorted by seeds, and a torrent found by more than one source is listed once with its highest seed count. If one source fails the others' results are still shown. Each result shows the site, seeds, peers and size, links to the site's details page, and is imported exactly like a pasted link once selected. Links to private addresses or with embedded credentials are dropped. A new torrent search replaces earlier torrent results and pasted links on that item that have not been imported.

The search itself runs inside qBittorrent on the media server, so it leaves through NordVPN with the rest of the box's traffic. The agent first checks qBittorrent's connection status and refuses to search while qBittorrent reports it is offline, which is what happens when `nordlynx` (the interface it is bound to) is down. Search plugins are small Python scripts that fetch the search sites directly; they are not bound to `nordlynx` the way BitTorrent traffic is.

### Why plugin results can be dead

qBittorrent's plugins scrape each site's search page, and several of the sites behind them are abandoned mirrors or static dumps (Torrents-CSV, for example, is a periodic snapshot). Their seed counts can be months old, so a result with "40 seeds" may have none left and stalls on **Fetching torrent metadata** or **Waiting for peers**. An indexer manager such as Prowlarr or Jackett keeps its site definitions up to date, reports current seeders from the sites that track them, and covers far more trackers, so adding one is the more reliable source. The plugins can stay enabled alongside it, or be uninstalled.

### Prowlarr or Jackett

Tomify can search a Prowlarr or Jackett you run yourself; it does not ship a list of sites. Either runs on the box and sends its searches through NordVPN with the rest of the box's traffic.

1. Install Prowlarr (recommended; see the [Prowlarr install guide](https://wiki.servarr.com/prowlarr/installation/linux), which has a Debian script) or Jackett, and keep its web UI on `127.0.0.1` (Prowlarr: port 9696, Jackett: 9117).
2. Add the public or private torrent indexers you use, and make sure each one has the Audio (3000) category. Indexers behind Cloudflare need FlareSolverr configured in Prowlarr or Jackett.
3. Copy the API key (Prowlarr: **Settings → General → Security**; Jackett: top of the dashboard).
4. Add the indexer to `/etc/tomify/recovery-agent.env` as a JSON array in single quotes and restart the agent:

```bash
# Prowlarr searches all its indexers in one call:
TOMIFY_TORRENT_INDEXERS_JSON='[{"type":"prowlarr","name":"Prowlarr","url":"http://127.0.0.1:9696","apiKey":"PROWLARR_API_KEY"}]'
# Jackett, through its all-indexers Torznab feed:
TOMIFY_TORRENT_INDEXERS_JSON='[{"type":"torznab","name":"Jackett","url":"http://127.0.0.1:9117/api/v2.0/indexers/all/results/torznab","apiKey":"JACKETT_API_KEY"}]'
```

Each entry takes `type` (`prowlarr` for Prowlarr's own search API, or `torznab` for any Torznab feed, such as Jackett's or a single Prowlarr indexer's `http://127.0.0.1:9696/<id>/api`), `name`, `url` (HTTPS, or HTTP on loopback), `apiKey`, and optional `categories` (default `3000`; comma-separated). Several entries are searched at once. A bad entry stops the agent at startup with a message naming it.

Results show the tracker's name (for example *1337x*) as the source. Magnet links are handed straight to qBittorrent. For results that only have a download link from Prowlarr or Jackett, the agent fetches it itself (qBittorrent is bound to `nordlynx` and may not reach loopback) and gives qBittorrent the `.torrent` file or the magnet it redirects to. The API key in those links is replaced with a placeholder before the link is stored with the candidate, and put back only when the agent fetches it. A download link that has gone fails the job with *the result may have been removed*.

If a search reports *rejected the configured API key*, copy the key again; *No torrent search source is set up* means there are neither enabled plugins nor indexers.

### Installing search plugins

qBittorrent needs Python 3 to run search plugins, and qBittorrent-nox may start with none installed. On the box:

```bash
sudo apt install python3
QBT_PASSWORD=$(sudo grep -oP '^TOMIFY_QBITTORRENT_PASSWORD=\K.*' /etc/tomify/recovery-agent.env)
curl -s -c /tmp/qbt.cookie --data-urlencode username=tomify --data-urlencode "password=$QBT_PASSWORD" http://127.0.0.1:8081/api/v2/auth/login; echo   # Ok.
BASE=https://raw.githubusercontent.com/qbittorrent/search-plugins/master/nova3/engines
curl -s -b /tmp/qbt.cookie --data-urlencode "sources=$BASE/piratebay.py|$BASE/limetorrents.py|$BASE/solidtorrents.py|$BASE/torrentscsv.py" http://127.0.0.1:8081/api/v2/search/installPlugin
sleep 10
curl -s -b /tmp/qbt.cookie http://127.0.0.1:8081/api/v2/search/plugins; echo   # each plugin listed with "enabled":true
rm -f /tmp/qbt.cookie; unset QBT_PASSWORD
```

These are plugins from qBittorrent's official search-plugins repository; add or remove others the same way (`search/uninstallPlugin` with `names=`). No agent setting changes: once the updated agent is deployed, **Search torrents** is enabled whenever torrent links are. If a search reports *No torrent search source is set up*, rerun the commands above or configure [Prowlarr or Jackett](#prowlarr-or-jackett); *qBittorrent is offline* means NordVPN is not connected.

### Installing qBittorrent-nox on the Debian box

qBittorrent runs as its own `qbittorrent` account, its web UI listens only on `127.0.0.1:8081`, and its BitTorrent traffic is bound to NordVPN's `nordlynx` interface, so torrents stop rather than fall back to the home connection if the VPN drops. Nothing here changes the box's routing or firewall, but arm the usual fail-safe anyway, since a reboot is the way back from any surprise. With `nordvpnd` enabled at boot the box returns on the VPN, which is the known-good setup.

```bash
sudo systemd-run --on-active=10min --unit=qbittorrent-failsafe /bin/systemctl reboot
```

Check that port 8081 is free (SABnzbd commonly uses 8080). If something is listening, pick another port and use it everywhere below:

```bash
sudo ss -ltnp | grep -E ':8081\b' || echo "8081 is free"
```

Install qBittorrent-nox and 7-Zip, and create the service account and download folder:

```bash
sudo apt update
sudo apt install qbittorrent-nox 7zip
command -v 7z || command -v 7zz    # Debian 12 installs 7-Zip as 7zz; note the path for SEVEN_ZIP_PATH
sudo useradd --system --home-dir /var/lib/qbittorrent --create-home --shell /usr/sbin/nologin qbittorrent
sudo install -d -o qbittorrent -g qbittorrent -m 755 /srv/torrents
```

RAR archives need the non-free `7zip-rar` package (add `non-free` to the Debian sources first); zip and 7z work without it.

Write qBittorrent's settings before its first start, so the web UI never listens anywhere but loopback and has no default password. This generates a random password, stores only its PBKDF2 hash in qBittorrent's config, and prints the password once for the agent's environment file:

```bash
QBT_PASSWORD=$(openssl rand -hex 24)
QBT_HASH=$(python3 -c 'import base64,hashlib,os,sys; s=os.urandom(16); k=hashlib.pbkdf2_hmac("sha512", sys.argv[1].encode(), s, 100000, 64); print("@ByteArray(%s:%s)" % (base64.b64encode(s).decode(), base64.b64encode(k).decode()))' "$QBT_PASSWORD")
sudo install -d -o qbittorrent -g qbittorrent -m 700 /var/lib/qbittorrent/qBittorrent /var/lib/qbittorrent/qBittorrent/config
sudo tee /var/lib/qbittorrent/qBittorrent/config/qBittorrent.conf >/dev/null <<EOF
[BitTorrent]
Session\Interface=nordlynx
Session\InterfaceName=nordlynx
Session\DefaultSavePath=/srv/torrents

[LegalNotice]
Accepted=true

[Preferences]
WebUI\Address=127.0.0.1
WebUI\Port=8081
WebUI\LocalHostAuth=true
WebUI\Username=tomify
WebUI\Password_PBKDF2="$QBT_HASH"
WebUI\CSRFProtection=true
WebUI\HostHeaderValidation=true
EOF
sudo chown qbittorrent:qbittorrent /var/lib/qbittorrent/qBittorrent/config/qBittorrent.conf
sudo chmod 600 /var/lib/qbittorrent/qBittorrent/config/qBittorrent.conf
echo "qBittorrent password: $QBT_PASSWORD"
```

If NordVPN uses OpenVPN rather than NordLynx, use `nordtun` instead of `nordlynx`. Copy the example unit from the Windows checkout (PowerShell):

```powershell
scp recovery-agent\qbittorrent-nox.service.example tom@tomify:/tmp/
```

Then install and start it on the box:

```bash
sudo cp /tmp/qbittorrent-nox.service.example /etc/systemd/system/qbittorrent-nox.service
sudo systemctl daemon-reload
sudo systemctl enable --now qbittorrent-nox
systemctl status qbittorrent-nox --no-pager
```

Check that the web UI is only on loopback, the password works and the session is bound to the VPN:

```bash
sudo ss -ltnp | grep qbittorrent                      # 127.0.0.1:8081 only, plus the BitTorrent port
curl -s -c /tmp/qbt.cookie --data-urlencode username=tomify --data-urlencode "password=$QBT_PASSWORD" http://127.0.0.1:8081/api/v2/auth/login; echo   # Ok.
curl -s -b /tmp/qbt.cookie http://127.0.0.1:8081/api/v2/app/preferences | grep -o '"current_network_interface":"[^"]*"'   # "nordlynx"
rm -f /tmp/qbt.cookie
```

Add the qBittorrent settings to `/etc/tomify/recovery-agent.env` (use `/usr/bin/7zz` for `SEVEN_ZIP_PATH` if that is what `command -v` printed):

```bash
sudo tee -a /etc/tomify/recovery-agent.env >/dev/null <<EOF
TOMIFY_QBITTORRENT_URL=http://127.0.0.1:8081
TOMIFY_QBITTORRENT_USERNAME=tomify
TOMIFY_QBITTORRENT_PASSWORD=$QBT_PASSWORD
TOMIFY_TORRENT_DOWNLOAD_DIR=/srv/torrents
TOMIFY_TORRENT_CATEGORY=tomify
TOMIFY_TORRENT_MAX_BYTES=4294967296
SEVEN_ZIP_PATH=/usr/bin/7z
EOF
unset QBT_PASSWORD QBT_HASH
```

Then deploy the updated agent (see [Updating the recovery agent](#updating-the-recovery-agent); it includes the new `torrent.mjs`), restart it, confirm `/health` returns `{"ok":true,...}`, and check that Recovery offers torrents:

```bash
sudo systemctl restart tomify-recovery
curl -s http://127.0.0.1:8788/health; echo
```

Open Recovery on the site, paste a link into an item and check the progress line. If everything works, cancel the fail-safe:

```bash
sudo systemctl stop qbittorrent-failsafe.timer
```

Reboot once (Settings → Restart media server) and check `systemctl status qbittorrent-nox` and the binding check above again: qBittorrent starts after `nordvpnd` and picks up `nordlynx` once NordVPN connects. If qBittorrent runs in Docker instead, set `TOMIFY_QBITTORRENT_DOWNLOAD_DIR` to its in-container download root (for example `/downloads`) and `TOMIFY_TORRENT_DOWNLOAD_DIR` to the matching host folder.

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

The public response does not reveal whether YouTube authentication is configured. To perform an authenticated extraction diagnostic through the protected API without returning video metadata or secrets:

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

- `POST /v1/search` with `{ backend, track, searchFields? }`, where `searchFields` is any non-empty subset of `artist`, `album` and `track` (legacy `searchMode` is still accepted), returning `{ candidates }`. For `backend: "torrent"` the body either carries `link`, and the one candidate returned is that validated link, or no link, in which case qBittorrent's enabled search plugins and the configured Prowlarr/Torznab indexers are searched with the chosen fields and up to 12 results with at least one seed come back, best-seeded first (`provenance.seeds`, `peers`, `size`, `providerId: "qbittorrent-search"`, and `searchSource`: the indexer id, or `qbittorrent-plugins`). The torrent entry in `/v1/status` has `search: true` when the agent supports this.
- `POST /v1/acquire` with `{ backend, candidate, track, artwork, authorisation, background? }`, returning `{ path, quality, artwork, provenance }`. With `background: true`, YouTube and Internet Archive acquisitions return `202` and `{ job }` instead, and the job's final result carries the same fields.
- For asynchronous Usenet and torrent acquisition (always) and YouTube and Internet Archive acquisition (with `background: true`), `POST /v1/acquire` returns an opaque job that the agent's job runner advances, and `POST /v1/jobs/status` with `{ jobId }` reports queued/downloading/importing/completed/failed state, progress, and the final import result. Status is read-only: it never asks the downloader or starts an import. Torrent jobs also report `details` (`downloadSpeed`, `uploadSpeed`, `seeds`, `seedsInSwarm`, `peers`, `peersInSwarm`, `eta`, `size`, `downloaded`).
- `POST /v1/preflight` with `{ artist, album, title, mode }`, returning `{ directory, mode, existing }`: the release directory an acquisition would import into (matched ignoring case and Unicode normalisation, as imports do; `null` when there is none yet) and its audio files with `title`, `trackNumber`, `discNumber`, `recordingId` and quality `tier`, read from `.tomify.json` sidecars, or from the file's tags when there is no sidecar. It is read-only and never creates a directory. `POST /v1/acquire` accepts `skipExisting: true` for Usenet and torrent release imports.
- `POST /v1/inventory/scan`, `/v1/inventory/status`, `/v1/inventory/summary` and `/v1/inventory/report`, starting and observing the read-only incremental master/recovery inventory and reporting health solely from its stored result. The contract remains `2`; Workers treat a 404 from an older agent as inventory unavailable.
- `POST /v1/jobs/cancel` with `{ jobId }`, stopping a torrent job and removing the torrent and its data from qBittorrent. It waits for any import in progress and returns the `importedPaths` that import created, so they can be deleted too. Idempotent once the job is gone.
- `POST /v1/jobs/import-remaining` with `{ jobId }`, importing the audio files a completed single-track Usenet job left in its download as a release, without downloading again. Files already imported by that job are skipped, and a job that was already imported as a release is refused.
- `POST /v1/delete` with `{ importedPaths }`, removing only each recovery derivative, its sidecar and its matching `.tomify-source` original.
- `POST /v1/tomifin/login`, `/v1/tomifin/session`, `/v1/tomifin/logout`, `/v1/tomifin/status`, `/v1/tomifin/vpn`, `/v1/tomifin/search`, `/v1/tomifin/download`, `/v1/tomifin/downloads`, `/v1/tomifin/pause`, `/v1/tomifin/resume` and `/v1/tomifin/cancel` for Tomifin Downloader (films and TV into the Family or Private Jellyfin library through the same qBittorrent). Every Tomifin route except login takes the Jellyfin `session` token in its body and checks it with Jellyfin (`TOMIFY_JELLYFIN_URL`); see [TOMIFIN.md](TOMIFIN.md). The contract remains `2`; the Worker treats a 404 from an older agent as needing an update.
- `POST /v1/status`, returning backend capability state, plus whether remote reboot and VPN control are enabled, without secret paths or values.
- `POST /v1/system/vpn/status`, returning NordVPN's state, location and whether its firewall and kill switch are off, or `{ control: "disabled" }` unless `TOMIFY_RECOVERY_ALLOW_VPN_CONTROL=true`.
- `POST /v1/system/vpn` with `{ action: "connect" | "disconnect" }`, refused unless VPN control is enabled and NordVPN's firewall and kill switch are off; connect always uses `TOMIFY_VPN_CONNECT_TARGET`.
- `POST /v1/system/reboot` with `{ confirm: "reboot" }`, returning 202 and rebooting the server shortly afterwards when `TOMIFY_RECOVERY_ALLOW_REBOOT=true`; refused otherwise.

All `/v1/*` endpoints, including deletion, use the same `TOMIFY_RECOVERY_TOKEN` bearer authentication. The Worker calls deletion before removing an imported item from D1. If the agent rejects a path or any filesystem operation fails, the Worker returns an actionable error and leaves the D1 item and candidates intact so the operation can be inspected and retried.

That boundary is intentionally source-neutral. A later CD-rip, purchased-download or recovered-file backend can implement the same result shape without changing the Recovery page or D1 model.

YouTube provenance records the video ID and URL, channel/uploader, title, acquisition timestamp, selected format ID, all available audio-format summaries, measured source quality, derivative details, and whether authenticated access was actually used. Cookies themselves are never provenance.

Internet Archive provenance records the item identifier and details URL, exact filename and final download URL, creator, item title, collection, licence/rights statements, format, original/derivative source flag, byte count, supplied MD5/SHA-1 values, acquisition time, measured audio quality and derivative details.

Torrent provenance records the info hash, link type (magnet or `.torrent` URL), the link without trackers or query string, whether each file came out of an archive, the completed file count, measured source quality and derivative details. It never records the tracker list or a passkey.

Usenet provenance records the provider type and name, opaque result or collection identifier, posted title and date when supplied, selected search mode, details URL, advertised size/age, downloader type, completed file count, measured source quality, and derivative details. It never records indexer API keys, downloader credentials, or credential-bearing download URLs.

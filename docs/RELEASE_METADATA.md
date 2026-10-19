# Tomify release metadata

Tomify keeps release classification separate from Navidrome so the UI can organise a discography without renaming albums.

## Release types

Tomify stores one of:

- album
- single
- ep
- compilation
- other

The UI groups **Single** and **EP** together as **Singles & EPs**.

Classification priority is:

1. A manual Tomify cloud override.
2. A MusicBrainz classification saved in Tomify D1.
3. OpenSubsonic/Navidrome release metadata such as `releaseTypes` or `isCompilation`.
4. A narrow bootstrap hint for titles ending in `(Single)`, `(EP)`, or `(Compilation)`.
5. Album as the display default while no stronger metadata is known.

Manual overrides always win and are never replaced by automatic enrichment.

## Automatic MusicBrainz enrichment

When Tomify has no cloud metadata for a release, it can enrich that release from MusicBrainz.

Matching works in this order:

1. If Navidrome supplies a MusicBrainz album ID, Tomify first tries it as a MusicBrainz **release** ID and then as a **release-group** ID.
2. Otherwise Tomify searches MusicBrainz release groups using the release title and artist.
3. Search fallback only accepts a strong match: exact normalised title and artist plus a MusicBrainz score of at least 80.

Tomify maps MusicBrainz release-group metadata as follows:

- secondary type **Compilation** -> `compilation`
- primary type **Single** -> `single`
- primary type **EP** -> `ep`
- primary type **Album** -> `album`
- anything else -> `other`

The MusicBrainz first-release date is also saved when available.

Automatic results are persisted in Cloudflare D1, so once one Tomify client identifies a release, every Tomify client receives the same result.

The Albums page enriches a small batch of previously unknown releases in the background. Artist pages enrich that artist's unknown releases in the background, and opening an individual album triggers enrichment for that release immediately.

MusicBrainz requires applications to identify themselves and stay at or below one API request per second. Tomify identifies itself with a descriptive User-Agent and deliberately spaces background enrichment requests by approximately 1.1 seconds.

## Manual correction

When the D1 metadata store is connected, album pages expose **Edit metadata**. A manual type/date correction is saved with source `manual` and takes precedence over MusicBrainz.

This exists for ambiguous editions, unusual release groups, or incorrect external metadata; it is not intended to be the normal classification workflow.

## Release dates

Tomify prefers a cloud date override, then OpenSubsonic `releaseDate`, then `originalReleaseDate`, then the album year. Artist discographies and the Albums page can therefore sort releases newest-first even when titles are unrelated.

## Persistence

Release metadata is **cloud-only**. Tomify does not persist release classifications in browser localStorage.

The Cloudflare Worker exposes authenticated release-metadata endpoints backed by the D1 binding `TOMIFY_DB`. The API verifies the current Navidrome token before reading, writing, or enriching metadata.

The D1 table tracks:

- Navidrome album ID
- resolved release type
- release date
- metadata source (`manual` or `musicbrainz`)
- matched MusicBrainz release-group ID
- MusicBrainz match score
- update timestamp/user

Existing pre-enrichment rows are migrated in place and treated as manual overrides.

## D1 binding

Tomify currently uses:

```toml
[[d1_databases]]
binding = "TOMIFY_DB"
database_name = "tomify-metadata"
database_id = "5147af2c-ce21-4e41-9ad7-09c3b36e7145"
```

The Worker creates and migrates the `release_metadata` table automatically.

## Album completeness

Album pages compare the local tracks with a canonical MusicBrainz tracklist and show, for example, **Incomplete · 1 of 19 tracks** with the missing tracks listed.

The local side is every version of the album that Tomify groups on the page, so master copies and Recovery copies count together. A track present more than once is reported as a duplicate copy rather than counted twice, and local tracks that are not on the chosen edition are listed as extras.

### Choosing the tracklist

The Worker resolves one MusicBrainz release per Navidrome album:

1. A release the user chose from the **Edition** selector (`source: manual`) always wins, including on refresh.
2. Otherwise, a MusicBrainz release ID from the album's own file tags (`source: tagged`).
3. Otherwise, a release from the album's release group (from the release-type enrichment above, or a strict title and artist search), chosen by `chooseReleaseEdition` (`source: auto`). Official releases with the most common track count are preferred, so a partial album such as one surviving track is compared with the standard edition rather than with whichever release has the fewest tracks. A library that already holds at least 80% of the standard count is matched to the edition closest to its own size, which picks up deluxe editions.

An automatic or tagged edition must fit the local album: with four or more local tracks it needs at least half as many tracks (`editionFitsLocal`). When it does not, which usually means the album shares its title with a single (Audioslave's *Out of Exile* and its one-track CD-R promo), the Worker skips the tagged release, searches release groups again with the local track count, and uses that group if one of its editions fits. The release-group search itself also weighs the primary type against the track count (`releaseGroupTypeFit`), so five or more tracks prefer an Album group and one to three prefer a Single; release-type enrichment sends the album's song count for the same reason. A cached automatic tracklist that does not fit is resolved again once on the next load, so no refresh is needed. A manually chosen edition is never replaced.

If the compared edition still leaves more local tracks unmatched than matched, the panel shows **Edition does not match** instead of **Complete** and suggests choosing another edition or refreshing.

The tracklist and the list of editions are cached in the D1 table `release_tracklists` (migration `0005_release_tracklists.sql`). Each album therefore costs two or three MusicBrainz requests once, through the same 1.1 second request spacing as enrichment. The refresh button fetches it again.

### Matching local tracks

`assessAlbumCompleteness` in `src/lib/album-completeness.ts` matches each local track to at most one tracklist entry, in this order:

1. MusicBrainz recording ID.
2. Disc and track number, when the titles are similar or the durations agree.
3. Title, ignoring version suffixes such as "- 2013 Remaster", when durations are within ten seconds.

### Adding missing tracks to Recovery

**Add missing to Recovery** sends only the track keys. The Worker builds each Recovery item from the cached tracklist, not from browser-supplied metadata. It fills in artist, title, album, duration, track and disc numbers, the MusicBrainz recording ID and ISRC, and provenance with `origin: album-completeness`. Tracks already in Recovery, matched by recording ID or by normalised artist and title, are linked rather than duplicated.

Recovery's MusicBrainz review searches by that recording ID first, then by ISRC, before falling back to a text search.

When two or more tracks are missing, **Recover N missing as one album** creates a single release item instead: the album's artist and title with no track title, and provenance holding the album ID, release ID and the missing track keys. Searching it on Usenet or a torrent indexer looks for the whole release, and the import is mapped to the album's cached tracklist (`recoveryReleaseTracklist` finds it by the album ID), so with **Skip tracks I already have** only the missing tracks are added. Until that item is recovered, the completeness panel shows it against every missing track; afterwards each imported track has its own Recovery item, and any track the release lacked shows as missing again.

### Incomplete albums

Library health lists every checked album whose last check found fewer local tracks than its tracklist, most missing first, with how many of the missing tracks are in Recovery (`POST /api/album-completeness/overview`). The counts are from the last check of each album, so the album page has the live answer. Albums nobody has checked are not listed, because each check asks MusicBrainz.

Completeness only reads the library and creates Recovery queue items. It never writes or moves audio files.

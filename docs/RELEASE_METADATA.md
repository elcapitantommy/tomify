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

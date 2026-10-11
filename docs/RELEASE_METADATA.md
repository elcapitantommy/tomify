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

1. A Tomify override.
2. OpenSubsonic/Navidrome release metadata such as `releaseTypes` or `isCompilation`.
3. A narrow bootstrap hint for titles ending in `(Single)`, `(EP)`, or `(Compilation)`.
4. Album as the default.

Title matching is therefore only a bootstrap fallback. Once a release is explicitly classified in Tomify, the explicit flag wins.

## Release dates

Tomify prefers a Tomify date override, then OpenSubsonic `releaseDate`, then `originalReleaseDate`, then the album year. Artist discographies and the Albums page can therefore sort releases newest-first even when titles are unrelated.

## Persistence

The browser always stores overrides locally so classification works immediately.

The Cloudflare Worker also supports a D1 binding named `TOMIFY_DB`. When that binding exists, Tomify automatically creates a `release_metadata` table and syncs overrides across devices.

The metadata API verifies the user's existing Navidrome token before reading or writing D1.

To enable cloud sync, create a D1 database in Cloudflare and add its database ID to the Worker configuration as the `TOMIFY_DB` binding.

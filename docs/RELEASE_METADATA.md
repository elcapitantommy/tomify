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

1. A Tomify cloud override.
2. OpenSubsonic/Navidrome release metadata such as `releaseTypes` or `isCompilation`.
3. A narrow bootstrap hint for titles ending in `(Single)`, `(EP)`, or `(Compilation)`.
4. Album as the default.

Title matching is only a bootstrap fallback. Once a release is explicitly classified in Tomify, the cloud override wins.

## Release dates

Tomify prefers a cloud date override, then OpenSubsonic `releaseDate`, then `originalReleaseDate`, then the album year. Artist discographies and the Albums page can therefore sort releases newest-first even when titles are unrelated.

## Persistence

Release metadata is **cloud-only**. Tomify does not persist release classifications in browser localStorage.

The Cloudflare Worker exposes authenticated release-metadata endpoints backed by a D1 binding named `TOMIFY_DB`. The API verifies the current Navidrome token before reading or writing metadata.

If the D1 binding is unavailable, Tomify falls back to Navidrome metadata/title inference for display but does not offer or retain browser-only overrides.

The Worker creates the `release_metadata` table on first use.

## Enabling D1

Create a Cloudflare D1 database (for example `tomify-metadata`) and bind it to the Tomify Worker as:

```
TOMIFY_DB
```

Then add the database ID to `wrangler.toml`:

```toml
[[d1_databases]]
binding = "TOMIFY_DB"
database_name = "tomify-metadata"
database_id = "<cloudflare-d1-database-id>"
```

After deployment, Tomify will load release overrides from D1 on sign-in. A proper cloud-backed release editor can then write through the authenticated Worker API without any device-local metadata state.

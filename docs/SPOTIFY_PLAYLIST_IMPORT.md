# Spotify playlist import

Tomify treats Spotify strictly as a catalogue and playlist-metadata provider. It never requests, captures, decrypts, proxies, or downloads Spotify audio. Imported entries play only when they match a track in the user's Navidrome library. Missing entries use the existing Recovery workflow and its separately authorised acquisition sources.

## Current Spotify access model

Spotify's current playlist-items endpoint requires user OAuth and only returns items for playlists owned by the connected user or playlists where that user is a collaborator. A public URL alone is no longer sufficient for arbitrary playlist-item access. Tomify therefore uses the OAuth 2.0 Authorization Code flow with `playlist-read-private` and `playlist-read-collaborative`, rather than scraping Spotify pages or accepting a Spotify password.

Configure these Worker secrets/variables:

```text
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
SPOTIFY_TOKEN_ENCRYPTION_KEY=<long random secret>
SPOTIFY_REDIRECT_URI=https://app.tomify.tomdixon.uk/api/catalogue-auth/spotify/callback
SPOTIFY_MARKET=GB
```

The redirect URI must be registered exactly in the Spotify developer dashboard. The client secret and encryption key must be Worker secrets, never `wrangler.toml`, Git, frontend variables, or browser storage. Access and refresh tokens are AES-GCM encrypted before D1 persistence. OAuth state is one-time, expires after ten minutes, and is bound to the signed-in Navidrome username.

## Import and matching

The Worker retrieves playlist metadata and every item through Spotify's Web API, following only `https://api.spotify.com` pagination URLs. It retries short rate limits, refreshes expired access tokens, and reports inaccessible playlists without failing open.

The browser compares each available Spotify track with Navidrome search results. Matching favours identifiers and exact recording characteristics in this order:

1. MusicBrainz recording identifiers when both catalogues expose them.
2. ISRC.
3. Normalised artist and title.
4. Album, artist, and title.
5. Duration tolerance.

Live, remix, acoustic, radio-edit, karaoke, cover, instrumental, sped-up, and slowed variants must agree on both sides. Scores of 92 or above are linked automatically. Scores from 72 to 91, or competing high scores within four points, require review. Lower scores become missing entries. The review UI lets the user choose a suggested local track or explicitly treat the entry as missing.

Episodes, Spotify local files, deleted items, and unsupported item types remain ordered unavailable entries and do not abort the playlist. Duplicate occurrences are assigned occurrence-aware identities so refresh and ordering do not collapse them.

## Persistence and Recovery

Migration `0004_catalogue_playlists.sql` adds provider-neutral playlist, ordered-item, OAuth-state, and encrypted-token tables. Imported playlists are Tomify playlist overlays because Navidrome playlists cannot represent a pending, non-audio entry. Available entries retain their Navidrome track JSON and play normally; missing and review entries stay in position.

“Import + add missing to Recovery” creates or reuses ordinary `recovery_items`. Reuse first checks the Spotify track ID, then normalised artist/title. Spotify wanted metadata and provenance are stored in `source_json`, including track/album/artist IDs, ISRC, playlist ID and position, source URL, release date, explicit flag, and artwork references. MusicBrainz remains the canonical metadata authority. Spotify artwork is only an input candidate and retains the existing Apple-first provider ranking and server-side usage gate.

Opening an imported playlist rechecks pending entries against Navidrome. Newly indexed recovery tracks become playable links while the original playlist position remains unchanged. The Recovery marker links directly to the shared Recovery item.

## Refresh

Imported Spotify playlists also refresh on their own. A daily Worker cron (`30 4 * * *` in `wrangler.toml`) checks each playlist's `snapshot_id`, refetches only the ones that changed, and saves the new entries as missing while keeping existing local links and Recovery references. The cron has no Navidrome login, so it cannot match: the next time the owner opens the playlist, the browser searches the library for the new entries as usual. If the playlist was imported with Recovery turned on and the owner is an admin, opening it then queues the entries that are still missing for Recovery.

You can still refresh by hand. Analysing the same Spotify URL reports additions, removals, and ordering changes and offers:

- update the existing Tomify playlist;
- create a separate copy; or
- leave the existing playlist untouched.

Update retains still-valid local links and Recovery references by occurrence identity. It creates Recovery items only for newly missing tracks when requested. Removing a playlist entry never deletes recovered audio.

Spotify playlist and album image URLs are stored as attributed provider references and displayed without modification. Spotify documents playlist image URLs as temporary, so refreshing the playlist also refreshes its image reference.

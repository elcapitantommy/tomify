# Tomifin Downloader

Tomifin Downloader is its own web app at its own address, **`https://tomifin.tomdixon.uk/`** (`TOMIFIN_HOSTNAME`), separate from Tomify's. It searches for films and TV with the torrent sources and Usenet search providers (NZBIndex and any Newznab indexers) Recovery already uses, and queues a chosen torrent in the media server's existing qBittorrent, or a chosen NZB in its existing SABnzbd, for the **Family** (`/media/family`) or **Private** (`/media/private`) Jellyfin library. A magnet, `.torrent` or `.nzb` link (or file) can also be added directly. While it downloads, its data sits in a hidden folder of its own inside that library; when it finishes, qBittorrent moves it into the library and Tomifin takes the torrent out of qBittorrent, keeping the files. It does not change Tomify's own pages, player or Recovery, and it is not reachable from Tomify's address (the old `/tomifin/` path there redirects to the new address).

- [Using it](#using-it)
- [How it fits together](#how-it-fits-together)
- [Usenet downloads](#usenet-downloads)
- [Add link](#add-link)
- [Family and Private destinations](#family-and-private-destinations)
- [Setting it up on the media server](#setting-it-up-on-the-media-server)
- [Family import](#family-import)
- [Security](#security)
- [Limitations](#limitations)

## Using it

1. Open `https://tomifin.tomdixon.uk/` and sign in with your Jellyfin account. Only Jellyfin administrators can use it; anyone else is refused. The sign-in lasts 30 days in that browser, or until you press **Sign out**, change your password or end the session in Jellyfin (Dashboard → Devices).
2. Search for a title. **Films & TV** searches both; **Films** and **TV** narrow it. Torrents and, when Usenet is set up, NZBs come back in one list, each labelled **Torrent · Magnet**, **Torrent · File** or **Usenet · NZB**. Torrents show seeders and leechers; NZBs show their indexer, age and grabs instead (they have no seeders). **Type** narrows the list to torrents or Usenet; the minimum-seeders filter applies to torrents only. If one side's search fails, the other's results still show, with a warning.
3. Press **FAMILY** or **PRIVATE**. Nothing is selected until you choose, the choice is not remembered between visits, and the page shows where downloads will go.
4. Press **Queue to Family** (or **Private**) on a result. Tomifin says it is queued only once qBittorrent (for a torrent) or SABnzbd (for an NZB) has accepted it; otherwise it shows the downloader's or the server's reason. Or paste a link into **Add link** (see [Add link](#add-link)).
5. The bar above the search shows the **VPN** qBittorrent downloads through: connected (with NordVPN's city and country when the agent's VPN control is on), connecting, down (qBittorrent has no connection, so downloads and searches are paused) or unknown. It is checked every 30 seconds, from qBittorrent's own connection status and, when `TOMIFY_RECOVERY_ALLOW_VPN_CONTROL=true`, `nordvpn status`. Tomifin only shows it; connecting and disconnecting stay in Tomify's settings.
6. **Downloads** lists everything queued from Tomifin, from both downloaders (each marked qBittorrent or SABnzbd), with its library, progress, downloaded and total size, speed, time left and status (queued, downloading, stalled, paused, completed or failed). It refreshes every 3 seconds while something is downloading and every 15 seconds otherwise, and has a **Refresh** button.

**Pause** and **Resume** stop and restart the download in its own downloader (qBittorrent or SABnzbd). **Cancel** takes an unfinished torrent out of qBittorrent and off the list, after a confirmation, and **Remove** takes a finished one off the list:

- a **finished** download is taken out of qBittorrent automatically as soon as its files are in the library, so it does not keep seeding, and qBittorrent's copy of the `.torrent` file and its resume data go with it. The files stay in the library and the download stays on the list as **Completed** until you remove it;
- an **unfinished** download has its partial data deleted only while that data is still in the download's own staging folder (`<library>/.tomifin-incomplete/<job id>/`), which nothing else writes to. Anything in the library itself is never deleted. The confirmation says which will happen.

For a Usenet download, cancelling an unfinished one removes it from SABnzbd's queue, and SABnzbd deletes only that job's own unfinished folder; removing a finished one removes Tomifin's record and SABnzbd's history entry, keeping SABnzbd's files and the library copy. A download SABnzbd is still unpacking cannot be cancelled until it has finished.

A torrent whose real size only becomes known once its details arrive (a magnet, usually) is stopped as soon as it turns out to be larger than the download limit (`TOMIFY_TOMIFIN_MAX_BYTES`, 200 GiB by default). It shows as failed, cannot be resumed or retried, and can be cancelled.

**Retry** appears on a failed download its downloader can try again, and nothing is deleted or added twice:

- a **torrent** qBittorrent reports as failed (`error` or `missingFiles`, for example after the library was briefly unmounted or the disk filled up) is checked on disk again (`torrents/recheck`) and started, in the same folders. It is offered only while every folder qBittorrent reports for it (save path, download path and content path) is inside that library, and never for a torrent over the download limit or one that is no longer in qBittorrent (search for it again instead);
- a **Usenet** download SABnzbd marked as failed for missing articles or a failed repair or unpack is retried in SABnzbd (`mode=retry`), which puts the same job back in its queue and reuses what it already downloaded. Tomifin follows SABnzbd's new id, keeps the job named `tomifin-<id>` (renaming it in SABnzbd if needed), and takes away its own failure note in the review folder. A password-protected download, one SABnzbd no longer has, and one that failed while being published (held for review) cannot be retried.

## How it fits together

```text
 https://tomifin.tomdixon.uk/ (tomifin/index.html, src/tomifin/)
     │  tomifin_session cookie (HttpOnly) + x-tomifin header
     ▼
 Worker  worker/routes/tomifin-site.ts  (TOMIFIN_HOSTNAME: serves only Tomifin on that address)
         worker/routes/tomifin.ts       (/api/tomifin/*: session cookie, input validation)
     │  RECOVERY_AGENT_URL + RECOVERY_AGENT_TOKEN (the existing Cloudflare Tunnel)
     ▼
 Recovery agent  recovery-agent/jellyfin.mjs  (checks the session with Jellyfin on the box)
                recovery-agent/tomifin.mjs   (/v1/tomifin/*)
     │  the existing qBittorrent client in recovery-agent/torrent.mjs
     ▼
 qBittorrent-nox (over NordVPN)  ──►  /media/family or /media/private  ──►  Jellyfin
     │
     │  recovery-agent/tomifin-usenet.mjs + the existing SABnzbd client in usenet.mjs
     ▼
 SABnzbd (its completed folder, outside both libraries)
     │  checked, then published by the agent: Family through family-import.mjs, Private by media-publish.mjs
     ▼
 /media/family (Movies/, TV/) or /media/private  ──►  Jellyfin
```

Nothing new runs: no extra service, port, tunnel or credential. The address is a second Custom Domain on the existing Worker, so the recovery agent token and every other setting are shared rather than copied. Sign-in goes through the agent to Jellyfin on the box (`TOMIFY_JELLYFIN_URL`), so Jellyfin does not need to be reachable from the internet and no Jellyfin API key is needed. The page is a second Vite entry point in the same Workers Static Assets, the API is one more Worker route, and the work happens in the recovery agent that already talks to qBittorrent.

On Tomifin's address the Worker (`tomifin-site.ts`) serves only:

- the Tomifin page, for every path (so direct links and refreshes work), with `Cache-Control: no-cache`, `X-Frame-Options: DENY`, `noindex` and `no-referrer`;
- `/api/tomifin/*`;
- its hashed `/assets/` and icons.
- `/sw.js`, answered with a small worker that removes itself. If Tomify's app was ever served on this address (for example when the custom domain went live before the Worker that knows about it was deployed), the browser would otherwise keep Tomify's service worker there and go on showing Tomify's cached sign-in page. The browser re-fetches `/sw.js` when that page loads, gets this worker, which deletes the cached files, unregisters and reloads the tab onto Tomifin. The Tomifin page itself also unregisters any service worker left on its address.

Every other Tomify API, the Navidrome proxy, Tomify's push worker and manifest answer `404` there. On Tomify's address `/tomifin*` redirects to Tomifin's and `/api/tomifin/*` answers `404`. For the Worker to see these paths before Static Assets, `run_worker_first` in `wrangler.toml` is now every path except `/assets/*`; Tomify's other requests are handed to Static Assets unchanged. Without `TOMIFIN_HOSTNAME` (for example `pnpm dev`) Tomifin is at `/tomifin/` as a development fallback.

| Worker route | Agent route | What it does |
| --- | --- | --- |
| `POST /api/tomifin/session` `{ username, password }` | `/v1/tomifin/login` | Signs in with Jellyfin and sets the session cookie |
| `GET /api/tomifin/session` | `/v1/tomifin/session` | Who is signed in |
| `DELETE /api/tomifin/session` | `/v1/tomifin/logout` | Signs out and ends the Jellyfin session |
| `GET /api/tomifin/vpn` | `/v1/tomifin/vpn` | VPN status: `connected`, `connecting`, `down` or `unknown`, plus NordVPN's country, city and server (no IP addresses) |
| `GET /api/tomifin/status` | `/v1/tomifin/status` | Whether Tomifin is set up, and which destinations are available |
| `GET /api/tomifin/search?q=…&kind=video\|movies\|tv` | `/v1/tomifin/search` | Searches the torrent sources, NZBIndex and any Newznab indexers |
| `POST /api/tomifin/link` `{ link }` or `{ file: { name, data } }` | `/v1/tomifin/link` | Checks one added magnet, `.torrent` or `.nzb` and returns it as a result to queue (new) |
| `POST /api/tomifin/download` `{ resultId, destination }` | `/v1/tomifin/download` | Queues one result in qBittorrent or SABnzbd (the agent decides which) |
| `GET /api/tomifin/downloads` | `/v1/tomifin/downloads` | Tomifin's downloads with live qBittorrent and SABnzbd figures |
| `POST /api/tomifin/downloads/<id>/pause` (`resume`, `retry`, `cancel`) | `/v1/tomifin/pause` (`resume`, `retry`, `cancel`) | Controls one download |

### Signing in

Tomifin uses Jellyfin accounts, and only Jellyfin administrators (`Policy.IsAdministrator`, not disabled) may use it.

1. The page posts the username and password to `POST /api/tomifin/session`. The Worker passes them to the agent, which calls Jellyfin's `/Users/AuthenticateByName` on the box. The password is not stored or logged anywhere.
2. If the account is not an administrator, the agent closes the session Jellyfin just opened (`/Sessions/Logout`) and the page says Tomifin is for administrators (`403`). A wrong password gets `401`.
3. Otherwise the Worker keeps Jellyfin's access token in a cookie, `tomifin_session` (`HttpOnly; Secure; SameSite=Strict; Path=/api/tomifin`, 30 days). Page scripts cannot read it.
4. On every request the agent checks the token with Jellyfin's `/Users/Me` (cached for 30 seconds) and that the user is still an administrator. If Jellyfin no longer accepts it, the Worker clears the cookie and the page shows the sign-in form again.
5. Every request that changes something (sign-in, sign-out, add link, queue, pause, resume, retry, cancel) must carry the `x-tomifin: 1` header, which another site cannot add, so a cross-site form cannot act with your cookie.

Without `TOMIFY_JELLYFIN_URL` on the agent, sign-in answers that Jellyfin sign-in is not set up.

### How a search result reaches qBittorrent

1. The agent runs the same search Recovery's **Search torrents** runs (`createQbittorrentClient().search()`): qBittorrent's enabled search plugins and every Prowlarr or Jackett indexer in `TOMIFY_TORRENT_INDEXERS_JSON`, at once, through qBittorrent on the box. Tomifin asks for plugin category `all`, `movies` or `tv`, and Torznab categories 2000 (Movies) and/or 5000 (TV) instead of Recovery's Music/3000. No other provider is added.
2. The results go through the same filter as Recovery (`seededTorrentResults()` in `torrent.mjs`): at least one seed, links that are safe to give qBittorrent, duplicates merged, best-seeded first. Tomifin also drops results qBittorrent cannot use directly, so only magnet links, `.torrent` file links and configured-indexer download links are offered; a plugin result that points at a web page is left out. Up to 50 are shown.
3. The agent keeps each result's full link for an hour and gives the browser only an id plus what to display (title, source, size, seeders, leechers, magnet or file, quality hints read from the name, and the site's details page). The browser never receives a link, tracker or passkey.
4. **Queue** sends only `{ resultId, destination }`. The Worker accepts a 64-character hex id and `family` or `private`, nothing else. The agent looks the id up in its own results (an unknown or expired id is refused: search again), parses the link again, refuses a torrent qBittorrent already has (so a Recovery torrent is never taken over), and adds it with the existing client: tag `tomifin-<job id>`, category `tomifin-family` or `tomifin-private`, save path from the destination's settings, a subfolder for multi-file torrents, and a download path (qBittorrent's **Keep incomplete torrents in**, per torrent) of `<library>/.tomifin-incomplete/<job id>`. A Prowlarr or Jackett link is fetched by the agent first, as for Recovery.
5. The job record is written under `TOMIFY_RECOVERY_STATE_DIR/tomifin/` **before** qBittorrent is asked, so a torrent can never be downloading without Tomifin knowing. If the record cannot be written, nothing is added. Only a definite refusal (qBittorrent answered with an error or `Fails.`, or the torrent was never sent) removes the record again. If qBittorrent's answer is lost (a timeout or dropped connection), it may have taken the torrent without showing it yet, so the record is kept: the page says qBittorrent did not confirm it, the download shows as **Waiting for qBittorrent to confirm**, and the agent confirms it when the torrent appears or drops the record after 15 minutes if it never does. A second press of **Queue**, or a retry of the same result or info hash while one is being queued or once it is in the downloads, is refused as a duplicate.
6. The downloads list reads each destination's category from qBittorrent once per refresh and matches torrents by their tag, so it shows Tomifin's own downloads and nothing else. Tomifin jobs live in their own folder, so Recovery's job runner never imports, moves or deletes them.
7. Every 10 seconds, and on each refresh of the list, the agent also: gives a new record to any torrent in Tomifin's categories that carries a `tomifin-<id>` tag but has no record (it is listed again, and its files are never deleted on cancel); stops torrents over the download limit; and takes finished torrents out of qBittorrent once their files have been moved into the library (never while they are still in the staging folder or being moved).

## Usenet downloads

Usenet uses what Recovery already has: NZBIndex (anonymous by default, with `TOMIFY_NZBINDEX_API_KEY` only if NZBIndex gave you a key), any Newznab indexers in `TOMIFY_NEWZNAB_INDEXERS_JSON` (optional), and the SABnzbd in `TOMIFY_SABNZBD_URL` / `TOMIFY_SABNZBD_API_KEY`, with its completed folder `TOMIFY_USENET_DOWNLOAD_DIR` (and `TOMIFY_SABNZBD_DOWNLOAD_DIR` when SABnzbd sees it at another path). No new downloader, indexer setting, port or credential is added. NZBGet is not supported for Tomifin.

Downloading and searching are separate: SABnzbd and its completed folder are all an added NZB link or upload needs, while search also needs a provider. NZBIndex always counts as one, so with Recovery's usual settings both work; with Newznab alone, NZBIndex and Newznab are searched together.

1. **Search.** NZBIndex and every Newznab indexer are searched at once, alongside the torrent search. Newznab indexers are asked for categories 2000 (Movies) and/or 5000 (TV); NZBIndex has no categories, so it is a free-text search of complete collections (incomplete ones and numbered fragments such as `[07/45]` are left out), and its results can include posts that are not films or TV. Results keep their provider, Newznab GUID or NZBIndex collection id in the agent; the browser gets an opaque id, the title, the provider's name, size, age, grabs (Newznab only), quality hints and, for Newznab, the indexer's details page (cleaned like torrent details links). NZBIndex results get no details link, because its address contains the collection id. The same entry twice, or the same release name (ignoring case, punctuation and separators, in any script) with sizes within 1 %, is shown once, preferring the Newznab entry. A provider that fails or times out is named in a short warning and the others' results are still shown. Results last an hour.
2. **Queue.** The agent builds the provider's download link itself (Newznab's `t=get` with its API key, or NZBIndex's `/api/download/<collection id>.nzb`, with its key only if one is set), fetches the NZB through the same checked fetcher as [Add link](#add-link), and checks it: well-formed XML in UTF-8 (with or without a BOM), ASCII, ISO-8859-1/Windows-1252, ISO-8859-15 or UTF-16 with a BOM, with no entities, CDATA or processing instructions, and no DOCTYPE except an external `<!DOCTYPE nzb …>` (such as newzBin's or NZBIndex's, with an http(s) or relative DTD address and no internal subset, so it declares nothing; the DTD is never loaded), not compressed, not password-protected (`<meta type="password">`), within 32 MiB and the download limit. It refuses a download already on the list (same result, GUID or the same set of article message-ids, so a repost is caught too), checks SABnzbd has Tomifin's categories, **writes the job record**, then uploads the NZB with `mode=addfile` as job `tomifin-<job id>` in category `tomifin-family` or `tomifin-private`. SABnzbd's answer decides: a refusal removes the record; a lost answer (timeout, dropped connection, a 5xx) keeps it as **Waiting for SABnzbd to confirm** and the agent looks for the job by name, never uploading it again. It is dropped after 15 minutes if SABnzbd never shows it.
3. **Staging.** SABnzbd downloads, repairs and unpacks in its own incomplete and completed folders, which must be outside both libraries (the agent refuses a `TOMIFY_USENET_DOWNLOAD_DIR` inside either). Nothing is in a library until it is published.
4. **Publish.** Once SABnzbd's history says **Completed** with no failure message (so unpacking and post-processing succeeded), the agent checks the job's folder: in the job's own category, named `tomifin-<job id>`, strictly inside `TOMIFY_USENET_DOWNLOAD_DIR` after resolving links, holding only regular files and folders (no symlinks, devices, FIFOs or nested mount points), no leftover archives (`.rar`, `.r00`, `.zip`, `.7z`, `.001`, …), within the file-count and size limits, and unchanged for 5 seconds. Then:
   - **Family**: the Family importer (`importDirectory` in `family-import.mjs`) publishes films to `Movies/Title (Year)/` and TV to `TV/<Series>/Season NN/` exactly as for torrents, with the same name rules, `ffprobe` checks and review. It runs inside the agent, with its record in `TOMIFY_RECOVERY_STATE_DIR/tomifin/family-import/`.
   - **Private**: the videos and subtitles (samples skipped) are published as one folder named after the release, `<private>/<release name>/…`, keeping their own names. Each file is built in the hidden `<private>/.tomifin-publishing/` folder and the finished folder is renamed into place in one step. An existing folder of that name is never replaced: if it holds the same files it counts as already imported, otherwise the download is held for review.
   - Files are hardlinked when SABnzbd's folder is on the same filesystem and the agent may link them; otherwise (or with `TOMIFY_TOMIFIN_USENET_PUBLISH=copy`) each is copied to a hidden temporary file, `fsync`ed, compared by SHA-256 with the original and only then given its final name, without ever replacing an existing file.
   - A problem that may pass (a library or storage pool briefly unavailable, a disk error, SABnzbd's folder not there yet, a file still changing) never fails the download: it shows **Waiting to publish to …** with the reason and is tried again after 30 seconds, then at doubling gaps up to every 30 minutes, for as long as it takes. Only a definite problem with the download itself fails it or holds it for review.
5. **Review.** A download SABnzbd marks failed (`download-failed`, `unpack-failed`, `password-protected`), or one that fails a check above (`unsafe-path`, `unsafe-symlink`, `special-file`, `nested-mount`, `archives-remain`, `name-collision`, `conflict`, `ambiguous-series`, …), is not published. It shows as failed with the reason, and a `reason.json` with a machine-readable `code` is written to `/media/family/.review/usenet-<job id>/` or `<private>/.tomifin-review/<job id>/`. Both folders are hidden and carry `.ignore`.
6. **Cleanup.** SABnzbd's output is never deleted by default. With `TOMIFY_TOMIFIN_USENET_CLEANUP=true`, the agent asks SABnzbd to delete a job's history entry and files only after it was verified as published or already imported.

Pause and resume act on SABnzbd's queue slot for that job only (`nzo_id`, or the `tomifin-<id>` name). A SABnzbd job named `tomifin-<uuid>` in one of Tomifin's categories that has no record (because the record was lost) is listed again, and its files are never deleted on cancel. A job that disappears from SABnzbd is marked failed after 15 minutes.

Usenet stays off, without affecting torrents, when SABnzbd, its API key or its completed folder is missing, when the downloader is NZBGet, or when Tomifin's categories clash with each other or with Recovery's `TOMIFY_USENET_CATEGORY`. The agent logs `Tomifin Usenet downloads are off: …` at start, the page says why under the search, and `/api/tomifin/status` reports it in `downloaders.usenet`. When SABnzbd is set up but no search provider is (only possible if NZBIndex is ever removed from Recovery), the agent logs `Tomifin Usenet search is off: …`, `downloaders.usenet.search` says so, and added NZB links and files still download.

## Add link

**Add link** takes exactly one of: a magnet link (pasted as text), an `http(s)` link to a `.torrent` or `.nzb` file, or an uploaded `.torrent` or `.nzb` file (10 MiB at most). **Check** shows what it is (**Torrent · Magnet link**, **Torrent · .torrent file** or **Usenet · NZB**) with its name and size; **Add to Family/Private** queues it. It then becomes an ordinary Tomifin job: the same record, staging, limits, status, importer, pause, resume and cancel as a search result, in qBittorrent for a magnet or `.torrent` and in SABnzbd for an NZB.

The agent decides the type from the content, never from the file name, extension or content type:

- **Magnets** must have exactly one BitTorrent info hash: v1 (`xt=urn:btih:` with 40 hex or 32 base32 characters), v2 (`xt=urn:btmh:1220…` with 64 hex), or one of each for a hybrid torrent. Malformed ones, ones naming several torrents, and ones already on the list or in qBittorrent are refused. The name comes from `dn`; trackers are never shown or logged.
- **`.torrent` files** are decoded with a strict bencode parser (10 MiB, nesting and item limits, no trailing data, no duplicate keys). The info hash is worked out from the `info` dictionary (SHA-1 for v1, SHA-256 for v2), file names must be safe, and the size counts against the download limit. Trackers and passkeys are not read, kept, shown or logged; qBittorrent receives the checked file itself.
- **NZBs** are checked as in [Usenet downloads](#usenet-downloads), and refused when Usenet is not set up.

A link is fetched by the agent, with no cookies or credentials, only when it is `http` or `https`, has no user name or password in it, and its host resolves only to public addresses; loopback, private, link-local, carrier-grade NAT and IPv4-in-IPv6 forms are refused, unless the host and port are exactly those of a configured torrent or Newznab indexer. The connection goes to the address that was checked, so DNS cannot change in between. At most three redirects are followed, each checked the same way (a redirect to a magnet is accepted as a magnet). Responses are limited to 32 MiB and 30 seconds, must not be compressed, and a `401`, `403`, sign-in challenge or HTML page is reported as needing a sign-in: download the file and upload it instead. Tomifin is not a general proxy: the fetched content is only ever parsed, never returned. The submitted link, trackers, passkeys and NZB contents are never sent back to the browser or logged.

## Family and Private destinations

The two folders are set only in the agent's environment and chosen by name:

| Destination | Agent's path | qBittorrent's path | qBittorrent category |
| --- | --- | --- | --- |
| Family | `TOMIFY_TOMIFIN_FAMILY_DIR` (`/media/family`) | `TOMIFY_TOMIFIN_FAMILY_QBITTORRENT_DIR`, default the same | `tomifin-family` |
| Private | `TOMIFY_TOMIFIN_PRIVATE_DIR` (`/media/private`) | `TOMIFY_TOMIFIN_PRIVATE_QBITTORRENT_DIR`, default the same | `tomifin-private` |

qBittorrent is installed natively on the box as `qbittorrent-nox.service` (see [Installing qBittorrent-nox](RECOVERY.md#installing-qbittorrent-nox-on-the-debian-box)), so it sees the libraries at their host paths and the `_QBITTORRENT_DIR` settings stay blank. If qBittorrent runs in Docker instead, set them to the paths inside its container (for example `/data/family`), and the agent maps qBittorrent's reported paths back to the host paths. Jellyfin is not configured anywhere in this repository; whichever way it mounts the libraries, its Family library must be the folder set as Family and its Private library the folder set as Private. Tomifin does not create, move or rename library folders.

Tomifin stays off, and logs `Tomifin Downloader is off: …` when the agent starts, unless both folders are set, are absolute, are not the filesystem root, are separate from each other (neither inside the other, on the agent's side or qBittorrent's), and are separate from every folder Recovery owns (`TOMIFY_MASTER_DIR`, `TOMIFY_RECOVERY_DIR`, the torrent and Usenet download folders and the state folder). It also needs qBittorrent to be configured for Recovery.

## Setting it up on the media server

1. **Check the library folders.** Confirm the two folders Jellyfin's Family and Private libraries read, and their owners and permissions:

   ```bash
   ls -ld /media/family /media/private
   ```

2. **Let qBittorrent write to them.** `qbittorrent-nox.service` runs with `ProtectSystem=strict`, so add the folders with a drop-in (the example unit is not changed, so existing installs are unaffected):

   ```bash
   sudo systemctl edit qbittorrent-nox
   ```

   ```ini
   [Service]
   ReadWritePaths=/media/family /media/private
   ```

   The `qbittorrent` account also needs write access to both folders, and Jellyfin needs read access. Keep Private closed to everyone else. For example, if Jellyfin runs as the `jellyfin` group and the folders belong to it:

   ```bash
   sudo usermod -aG jellyfin qbittorrent
   sudo chmod 2775 /media/family     # group-writable; new files keep the jellyfin group
   sudo chmod 2770 /media/private    # no access at all for other accounts
   sudo systemctl restart qbittorrent-nox
   ```

   qBittorrent's unit has `UMask=0022`, so downloaded files are readable by anyone who can reach them; Private stays private because nobody outside the group can enter `/media/private`. Only change permissions after checking what Jellyfin expects. For torrents the agent (running as `tom`) only reads the folders, to check a download is starting from nothing; it needs write access only when Usenet is on, since it then publishes Usenet downloads itself (step 6). If it cannot read Private, cancelling a Private download keeps its partial files.

3. **Check qBittorrent's version.** Tomifin's per-download staging folder needs qBittorrent 4.4 or later (`qbittorrent-nox --version`). An older qBittorrent ignores it and saves straight into the library; Tomifin still works, but cancelling then always keeps the partial files. qBittorrent creates `.tomifin-incomplete` inside each library itself, so it needs no extra permissions beyond step 2. Jellyfin normally skips hidden folders (names starting with a dot), so it does not pick up half-downloaded videos. If you want extra certainty, also turn on **Append .!qB extension to incomplete files** in qBittorrent's settings (Downloads). Empty job folders can be left in `.tomifin-incomplete` after downloads finish or are cancelled; they are safe to delete.

4. **Configure the agent.** Add to `/etc/tomify/recovery-agent.env`:

   ```bash
   TOMIFY_TOMIFIN_FAMILY_DIR=/media/family
   TOMIFY_TOMIFIN_PRIVATE_DIR=/media/private
   # Only if qBittorrent sees them at other paths (Docker):
   # TOMIFY_TOMIFIN_FAMILY_QBITTORRENT_DIR=/data/family
   # TOMIFY_TOMIFIN_PRIVATE_QBITTORRENT_DIR=/data/private
   # Largest torrent Tomifin will queue (default 200 GiB):
   # TOMIFY_TOMIFIN_MAX_BYTES=214748364800
   # Jellyfin on the box, for signing in (loopback HTTP or HTTPS):
   TOMIFY_JELLYFIN_URL=http://127.0.0.1:8096
   ```

   Use the address the agent can reach Jellyfin at; `8096` is Jellyfin's default port. If Jellyfin runs in Docker on the box and publishes its port on the box's LAN address only (`docker ps` shows, say, `192.168.1.81:8096->8096/tcp`), use that address: `TOMIFY_JELLYFIN_URL=http://192.168.1.81:8096`. Plain HTTP is accepted only to an address of the box itself (loopback or one of its own interfaces), so the password never crosses the network unencrypted; Jellyfin on another machine needs its HTTPS address.

5. **Add the address.** In the Cloudflare dashboard: Workers & Pages → **tomify** → Settings → Domains & Routes → Add → **Custom domain** → `tomifin.tomdixon.uk`. Cloudflare creates the DNS record and certificate. Do this before or straight after merging, because once deployed, Tomify's `/tomifin/` path redirects there. To use a different name, change `TOMIFIN_HOSTNAME` in `wrangler.toml` (a dashboard variable would be replaced on the next deploy). If you want a second gate in front of it, Cloudflare Access can protect just that hostname; Tomifin still needs its own Jellyfin administrator sign-in.

6. **Usenet (optional).** Usenet needs Recovery's SABnzbd and `TOMIFY_USENET_DOWNLOAD_DIR` to be set up already ([RECOVERY.md](RECOVERY.md)). NZBIndex needs no setup; Newznab indexers are optional. Then:
   - In SABnzbd → Config → Categories, add `tomifin-family` and `tomifin-private` (or the names in `TOMIFY_TOMIFIN_SABNZBD_FAMILY_CATEGORY` / `_PRIVATE_CATEGORY`). Give each a folder **inside SABnzbd's completed folder** (for example `tomifin-family` and `tomifin-private`), never a library folder, and leave **Processing** at `+Delete` (repair, unpack, delete) so archives are unpacked. SABnzbd's incomplete folder must also be outside both libraries. Tomifin refuses to queue an NZB until both categories exist.
   - Give the agent write access to both libraries, which it now publishes into. Its unit is written by the root activation helper (`scripts/tomify-agent-activate.sh`), so add a drop-in rather than editing it, using the paths set as `TOMIFY_TOMIFIN_FAMILY_DIR` and `TOMIFY_TOMIFIN_PRIVATE_DIR`:

     ```bash
     sudo systemctl edit tomify-recovery
     ```

     ```ini
     [Service]
     ReadWritePaths=-/media/family -/media/private
     ```

     It also needs Unix write permission for `tom` on both (for `/media/family`, `tom` already owns it; check `/media/family/.review` and `.publishing`, which belong to `qbittorrent:media-family` with mode `2775`, so `tom` must be in `media-family`).
   - Set `TOMIFIN_IMPORT_MOVIES_SUBDIR=Movies` (and, if not `TV`, `TOMIFIN_IMPORT_TV_SUBDIR`) in `/etc/tomify/recovery-agent.env`, so Usenet films land next to the torrent ones.
   - In Jellyfin, add a **Shows** library for `/media/family/TV` (Dashboard → Libraries → Add Media Library), since TV is published there.
   - Optional: `TOMIFY_TOMIFIN_USENET_PUBLISH=copy` to always copy rather than hardlink, `TOMIFY_TOMIFIN_USENET_CLEANUP=true` to remove SABnzbd's copy after a verified publication.

7. **Deploy the agent, then the site.** Deploy the agent with `scripts/deploy-agent.ps1` (or `.sh`) as usual ([Updating the recovery agent](DEPLOYMENT.md#updating-the-recovery-agent)), check `journalctl -u tomify-recovery -n 20` has no `Tomifin Downloader is off` or `sign-in is off` line, then merge so Cloudflare deploys the site. The site works before the agent is updated: Tomifin then says the media server needs the latest agent, and Recovery is unaffected (the agent contract stays `2`).

8. **Jellyfin.** Tomifin calls Jellyfin only to sign in; it does not change libraries or start scans. New files appear when Jellyfin next scans: turn on **Real time monitoring** on both libraries (Dashboard → Libraries → library → Manage library), or rely on the scheduled **Scan media library** task.

## Family import

With `TOMIFY_TOMIFIN_FAMILY_IMPORT_SUBDIR=.downloads`, Family downloads no longer land in the library directly. qBittorrent keeps them, untouched and seeding, in the hidden staging folder `/media/family/.downloads`. When one finishes, an importer publishes a clean copy for Jellyfin as hardlinks, so no extra disk space is used:

```text
/media/family/.downloads/Toy.Story.2.1999.1080p.BrRip.x264-YIFY/…          qBittorrent's files (seeding, never changed)
/media/family/Movies/Toy Story 2 (1999)/Toy Story 2 (1999).mp4             hardlink to the film
/media/family/Movies/Toy Story 2 (1999)/Toy Story 2 (1999).en.srt          hardlink to the English subtitles
```

Private is not affected: it keeps saving straight into its library and finished Private torrents still leave qBittorrent.

### TV episodes and season packs

A torrent whose videos carry episode numbers (`S01E01`, `s1e1`, `S01E01E02`, `S01E01-E03`, any case) is published as TV instead of a film:

```text
/media/family/TV/MobLand/Season 01/MobLand - S01E01.mkv
/media/family/TV/MobLand/Season 01/MobLand - S01E02 - The Crown.mkv        episode title, when the file names one clearly
/media/family/TV/MobLand/Season 01/MobLand - S01E02 - The Crown.en.srt
/media/family/TV/MobLand/Season 01/MobLand - S01E03-E04.mkv                a double episode
```

Specials (`S00E01`) go to `Season 00`.

The folder is `TOMIFIN_IMPORT_TV_SUBDIR` (default `TV`) inside the library; it must differ from the films folder. Single episodes, season packs, packs with several episodes per file and packs spanning several seasons are all handled, with these rules:

- The series name comes from the episode file names (dots and underscores become spaces, release tags dropped, a trailing year becomes `(Year)`). Every episode must agree on it, and it must agree with the torrent's own name or folder when they name one; otherwise it is held for review (`ambiguous-series`). Nothing is guessed from search results or the internet.
- Every video must be an episode (`mixed-content` otherwise; samples are skipped). A season folder or a `Season N`/`S01` torrent name must match the episodes inside it (`season-mismatch`). A multi-season pack is accepted only when each episode names its season.
- The same episode twice (two qualities, a repack beside the original) is held for review (`duplicate-episode`) unless the files are byte-for-byte identical, in which case one is published.
- Each episode must be readable by `ffprobe` with a video stream and at least 2 minutes (`too-short`).
- Episode subtitles (`.srt`) are matched by their own episode number, or by sharing the episode file's name, and get the same `.en`, `.forced` or `.sdh` suffix rules as films.
- Episodes are added one file at a time into an existing series and season folder (which must be a real folder inside the TV folder, not a link). Each file is built in `.publishing` and linked into place without ever replacing anything: a file already there with the same content counts as already imported, a different one sends the whole torrent to review before anything is published.


### How it runs

1. qBittorrent's **Run external program on torrent finished** calls `tomifin-family-import-hook.sh "%I" "%L"`. The hook only writes the info hash into `/media/family/.downloads/.tomifin-import-queue/`, and only for category `tomifin-family` and a 40- or 64-character hex hash; it never fails the torrent.
2. `tomifin-family-import.path` notices the queue entry and starts `tomifin-family-import.service`, which runs `family-import.mjs --queue`. `tomifin-family-import-scan.timer` runs a catch-up `--scan` every hour for anything a hook missed or that was not ready.
3. The importer (`recovery-agent/family-import.mjs`) asks qBittorrent, through the agent's existing client and settings, whether the torrent is complete: category `tomifin-family`, progress 100 %, nothing left, a seeding state, and every wanted file at 100 %. It does nothing for a torrent that is not.
4. It checks every file: the save folder and each file must `realpath` to themselves strictly inside `/media/family/.downloads` (no links out, no `..`), be regular, non-empty files of the size qBittorrent expects, not `.!qB` or other partial files, and unchanged over 5 seconds.
5. It ignores samples, trailers, artwork, `.txt`, `.nfo`, `.url` and every other non-video, non-`.srt` file. The main film is the largest video, and it must be the only large one (a second video of 40 % or more of its size, such as CD1/CD2 or two cuts, is ambiguous). `ffprobe` must read it, find a video stream and report at least 20 minutes.
6. It reads `Title (Year)` from the torrent name and the film's file name, dropping dots, resolution, source, codec, audio, HDR and release-group tags. If neither gives a clear year with a title before it and only tags after, or if the two disagree, it does not guess. A download whose videos carry episode numbers is TV instead (see [TV episodes and season packs](#tv-episodes-and-season-packs)).
7. Subtitles (`.srt`) are named after the film. A language suffix (`.en`, `.fr`, …, plus `.forced` or `.sdh`) is added only when exactly one language is named by the subtitle's own file or folder name; otherwise it is plain `Title (Year).srt`. Where two would get the same name, the larger is kept and the other is logged as skipped.
8. It checks the library is on the same filesystem as staging, hardlinks every file into a hidden, Jellyfin-ignored folder `/media/family/.publishing/<hash>-<random>/Title (Year)/`, checks each link shares the source's inode, and then renames that folder into `/media/family/Movies/Title (Year)` in one step (`TOMIFIN_IMPORT_MOVIES_SUBDIR=Movies` in the unit; without it, films go to `/media/family/Title (Year)`). Jellyfin never sees a half-built film, and a rename onto a folder that appeared meanwhile fails instead of replacing it.
9. It records the outcome in `/var/lib/tomifin-import/<hash>.json` (paths, inodes and sizes). Running again for the same torrent, from a repeated hook, the queue or the scan, changes nothing. A destination that already holds the same film (same inode, or the same SHA-256) counts as already imported, which is how a film published by hand is recognised.

Anything doubtful goes to `/media/family/.review/<hash>/` instead: hardlinks of the torrent's video and subtitle files plus `reason.json` saying why. That covers ambiguous names, several large videos, unreadable or too-short video, unsafe paths, empty files, and a destination that already exists with different contents, which is never overwritten. Nothing is ever moved, renamed or deleted in staging, and no existing library file is ever replaced. Review folders are left for you; delete one once it is dealt with, and remove the torrent's `/var/lib/tomifin-import/<hash>.json` to let the importer try it again.

Each run logs one JSON line per torrent to the journal (`journalctl -u tomifin-family-import -u tomifin-family-import-scan`): hash, torrent name, detected title and year, the result (`published`, `already-imported`, `review`, `not-ready`, `skipped`, `unchanged`, `failed`), the published paths or the reason, then one closing `done` line with the mode and the number of torrents looked at, so a run that found nothing still shows. A queued torrent that is not ready yet (qBittorrent may still be moving it out of its temporary folder) is retried six times, 10 seconds apart, before the hourly scan takes over; a queue that cannot be read or emptied fails the run instead of being skipped. Nothing else is logged, and never a credential.

### Permissions

The importer runs as `qbittorrent` with group `media-family`. That is because the kernel only lets a file's owner, or someone allowed to write to it, hardlink it (`fs.protected_hardlinks`), and qBittorrent owns the downloads. Its unit is otherwise locked down: it can write only under `/media/family` and its own state folder, sees an empty `/home`, and can reach only qBittorrent on this machine. Its system calls are limited to systemd's `@system-service` set; a call outside it fails with `EPERM` rather than killing the importer (Node 20 tries `io_uring`, which that set leaves out, and `UV_USE_IO_URING=0` turns that off). qBittorrent's own unit and hardening are not changed. The hook runs inside qBittorrent's existing sandbox and only creates a file in staging.

Jellyfin skips `.downloads`, `.review` and `.publishing`: each has a `.ignore` file, and their names start with a dot.

### Installing it

The unit files in `recovery-agent/family-import/` match the media server as it is set up:

- qBittorrent is `qbittorrent-nox.service`, user `qbittorrent` in group `media-family`, with a `family-library.conf` drop-in giving it `ReadWritePaths=/media/family` and `UMask=0002`. Neither is changed.
- The Family library is `/home/tom/jellyfin-server/media/family` (`tom:media-family`, mode `2775`), bind-mounted system-wide at `/media/family` by `/etc/fstab`. Clean films live in its `Movies` folder. Jellyfin's container mounts the whole library read-only at `/media/family`, which is why staging, review and publishing are hidden and carry `.ignore`.
- The agent's code is the deployed release at `/opt/tomify/current/recovery-agent`, run with `/usr/bin/node`. `ffprobe` comes from the `ffmpeg` package. `fs.protected_hardlinks` is `1`.
- The importer reads qBittorrent's address and login from the agent's `/etc/tomify/recovery-agent.env` (read by systemd, not by the importer's user). The agent's other secrets are removed with `UnsetEnvironment=` before it starts.

`recovery-agent/family-import/install-family-import.sh` does steps 2 to 5 (`sudo bash /opt/tomify/current/recovery-agent/family-import/install-family-import.sh install`) and, after step 7, steps 6 and 8 (`… enable`). The steps by hand:

1. `sudo apt install ffmpeg` if `ffprobe` is missing.
2. Create the folders, owned by qBittorrent and the Family group:
   ```bash
   sudo -u qbittorrent mkdir -p /media/family/.downloads/.tomifin-import-queue /media/family/.review /media/family/.publishing
   sudo -u qbittorrent touch /media/family/.downloads/.ignore /media/family/.review/.ignore /media/family/.publishing/.ignore
   ```
3. Install the hook: `sudo install -D -m 0755 recovery-agent/family-import/tomifin-family-import-hook.sh /usr/local/lib/tomifin/tomifin-family-import-hook.sh`.
4. Install the units (without `.example`) into `/etc/systemd/system/`, then `sudo systemctl daemon-reload`.
5. **Dry run first:** `sudo systemd-run --wait --pipe -p User=qbittorrent -p SupplementaryGroups=media-family -p EnvironmentFile=/etc/tomify/recovery-agent.env -p Environment=TOMIFIN_IMPORT_MOVIES_SUBDIR=Movies -p Environment=TOMIFIN_IMPORT_TV_SUBDIR=TV -p StateDirectory=tomifin-import /usr/bin/node /opt/tomify/current/recovery-agent/family-import.mjs --scan --dry-run`. Check every line it prints; nothing is written.
6. Add `TOMIFY_TOMIFIN_FAMILY_IMPORT_SUBDIR=.downloads` to `/etc/tomify/recovery-agent.env` and redeploy the agent, so new Family downloads go to staging.
7. In qBittorrent → Options → Downloads, turn on **Run external program on torrent finished** with `/usr/local/lib/tomifin/tomifin-family-import-hook.sh "%I" "%L"`.
8. `sudo systemctl enable --now tomifin-family-import.path tomifin-family-import-scan.timer`.

## Security

- **Access:** every `/api/tomifin/*` route except sign-in requires a Jellyfin administrator's session, checked with Jellyfin by the agent (see [Signing in](#signing-in)). Removing someone's administrator role or disabling them in Jellyfin locks them out within 30 seconds. Pause, resume, retry and cancel act only on a torrent carrying that job's own `tomifin-` tag, so Recovery's torrents and anything added to qBittorrent by hand are never touched.
- **Paths:** the browser sends `family` or `private`, never a path. Paths come only from the agent's environment, are checked to be separate at start-up, and a content path qBittorrent reports is accepted only strictly inside the destination folder. Cancelling deletes data only from inside that job's own staging folder. Job ids are UUIDs; other ids are refused before any file is touched.
- **SSRF and links:** search results are queued by id only, and an added link is fetched only under the rules in [Add link](#add-link) (public addresses or an exact configured indexer host, checked on every redirect, size and time limits, content-based detection). Only links produced by the agent's own search or checked by Add link are queued; search links pass the same checks as Recovery (magnet info hash, public host, no embedded credentials; only a configured indexer may be on a private address). Search input is trimmed and limited to 200 characters. A result's details-page link (`safeDetailsUrl()` in `torrent.mjs`) is shown only if it is a public http(s) page with no user name or password; its fragment and any query parameter that could carry a credential (names like `apikey`, `passkey`, `token`, `sid`, or a value that looks like a generated key) are removed, and a link with a key-like path segment is dropped altogether. Recovery's results use the same cleaning.
- **Credentials:** the Jellyfin password is passed straight to Jellyfin and never stored; the session token lives only in the HttpOnly cookie and the agent's 30-second memory cache. qBittorrent's password, SABnzbd's API key, indexer API keys and NZB download links, tracker passkeys and `RECOVERY_AGENT_TOKEN` stay on the box and in the Worker. Job records keep no links, NZB contents or keys. Responses carry no links, paths beyond the two library names, or tokens.
- **Family and Private stay apart:** each has its own qBittorrent category, SABnzbd category, staging and review folders; a SABnzbd job is published only from its own category's history entry, into the library its record names.
- **Logs:** the agent logs the number of search results and the title and library of each queued or removed search download (an added link's job is logged by id only); the Worker logs who signed in and the library of each queued download. Neither logs links, search terms or credentials.
- **Separate address:** Tomifin's origin is separate from Tomify's, so browser storage, cookies and service workers are not shared, and Tomify's APIs are not exposed on Tomifin's address (see [How it fits together](#how-it-fits-together)). Tomify's service worker never serves or precaches Tomifin's page.

## Limitations

- Results are only as good as the configured qBittorrent search plugins and indexers. Plugin results that point at a web page rather than a torrent are not offered.
- Search results are kept in the agent's memory for an hour; after an agent restart, search again before queuing.
- Finished downloads are not seeded: they leave qBittorrent once their files are in the library. Some private trackers require seeding; use Recovery or qBittorrent directly for those. Unfinished ones count towards qBittorrent's active-torrent limits, which the agent sets from `TOMIFY_TORRENT_MAX_ACTIVE` for Recovery.
- Tomifin downloads keep the torrent's own file and folder names. Jellyfin usually recognises scene-style names; rename in Jellyfin or on disk if one is not matched.
- Tomifin does not check whether the library already holds files with the same names as a download. If it does, qBittorrent's move of the finished download decides what happens to them, so avoid queuing something you already have.
- There are no push notifications for Tomifin downloads.
- Usenet: only SABnzbd, with NZBIndex and Newznab indexers for search. Password-protected NZBs and downloads are refused or held for review; Tomifin never supplies passwords. NZBs are uploaded by the agent (SABnzbd never fetches indexer links itself). Private Usenet downloads keep the release's own file names; only Family downloads are renamed.
- TV: only `SxxExx` numbering is recognised. Absolute numbering (anime), dated episodes (`2024.01.31`) and `1x02` are not read as episodes, so such downloads are held for review rather than guessed, and a series must be named consistently by its files. Private TV keeps its own names.
- Add link: links that need cookies, a sign-in or a captcha cannot be fetched; download the file and upload it. A magnet's size is only known once qBittorrent has its metadata.

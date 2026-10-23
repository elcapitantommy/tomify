# Tomifin Downloader

Tomifin Downloader is its own web app at its own address, **`https://tomifin.tomdixon.uk/`** (`TOMIFIN_HOSTNAME`), separate from Tomify's. It searches for films and TV with the torrent sources Recovery already uses, and queues a chosen torrent in the media server's existing qBittorrent, saved straight into the **Family** (`/media/family`) or **Private** (`/media/private`) Jellyfin library. It does not change Tomify's own pages, player or Recovery, and it is not reachable from Tomify's address (the old `/tomifin/` path there redirects to the new address).

- [Using it](#using-it)
- [How it fits together](#how-it-fits-together)
- [Family and Private destinations](#family-and-private-destinations)
- [Setting it up on the media server](#setting-it-up-on-the-media-server)
- [Security](#security)
- [Limitations](#limitations)

## Using it

1. Open `https://tomifin.tomdixon.uk/` and sign in with your Navidrome account, the same one you use for Tomify. Being a different address, it keeps its own sign-in, saved in that browser. Only Navidrome administrators can use it, as with Recovery.
2. Search for a title. **Films & TV** searches both; **Films** and **TV** narrow it.
3. Press **FAMILY** or **PRIVATE**. Nothing is selected until you choose, the choice is not remembered between visits, and the page shows where downloads will go.
4. Press **Queue to Family** (or **Private**) on a result. Tomifin says it is queued only once qBittorrent has accepted the torrent; otherwise it shows qBittorrent's or the server's reason.
5. **Downloads** lists everything queued from Tomifin with its library, progress, downloaded and total size, speed, time left and status (queued, downloading, stalled, paused, completed or failed). It refreshes every 3 seconds while something is downloading and every 15 seconds otherwise, and has a **Refresh** button.

**Pause** and **Resume** stop and restart the torrent in qBittorrent. **Cancel** (or **Remove** once finished) takes the torrent out of qBittorrent and off the list, after a confirmation:

- a **finished** download keeps its files in the library; only seeding stops;
- an **unfinished** download has its partial data deleted only if the agent checked, before any data arrived, that nothing with that name was already in the library. Otherwise (it found existing files, it could not check in time, or it could not read the folder) the torrent is removed and every file is left in place. The confirmation says which will happen.

## How it fits together

```text
 https://tomifin.tomdixon.uk/ (tomifin/index.html, src/tomifin/)
     │  x-tomify-* Navidrome login headers
     ▼
 Worker  worker/routes/tomifin-site.ts  (TOMIFIN_HOSTNAME: serves only Tomifin on that address)
         worker/routes/tomifin.ts       (/api/tomifin/*: administrator check, input validation)
     │  RECOVERY_AGENT_URL + RECOVERY_AGENT_TOKEN (the existing Cloudflare Tunnel)
     ▼
 Recovery agent  recovery-agent/tomifin.mjs   (/v1/tomifin/*)
     │  the existing qBittorrent client in recovery-agent/torrent.mjs
     ▼
 qBittorrent-nox (over NordVPN)  ──►  /media/family or /media/private  ──►  Jellyfin
```

Nothing new runs: no extra service, port, tunnel or credential. The address is a second Custom Domain on the existing Worker, so the recovery agent token, Navidrome origin and every other setting are shared rather than copied. The page is a second Vite entry point in the same Workers Static Assets, the API is one more Worker route, and the work happens in the recovery agent that already talks to qBittorrent.

On Tomifin's address the Worker (`tomifin-site.ts`) serves only:

- the Tomifin page, for every path (so direct links and refreshes work), with `Cache-Control: no-cache`, `X-Frame-Options: DENY`, `noindex` and `no-referrer`;
- `/api/tomifin/*`;
- `/navidrome/rest/ping.view` and `getUser.view` through the existing Navidrome proxy, which signing in needs (login check and administrator role);
- its hashed `/assets/` and icons.

Every other Tomify API, the rest of the Navidrome proxy (streams included), Tomify's service worker and manifest answer `404` there. On Tomify's address `/tomifin*` redirects to Tomifin's and `/api/tomifin/*` answers `404`. For the Worker to see these paths before Static Assets, `run_worker_first` in `wrangler.toml` is now every path except `/assets/*`; Tomify's other requests are handed to Static Assets unchanged. Without `TOMIFIN_HOSTNAME` (for example `pnpm dev`) Tomifin is at `/tomifin/` as a development fallback.

| Worker route | Agent route | What it does |
| --- | --- | --- |
| `GET /api/tomifin/status` | `/v1/tomifin/status` | Whether Tomifin is set up, and which destinations are available |
| `GET /api/tomifin/search?q=…&kind=video\|movies\|tv` | `/v1/tomifin/search` | Searches the torrent sources |
| `POST /api/tomifin/download` `{ resultId, destination }` | `/v1/tomifin/download` | Queues one search result in qBittorrent |
| `GET /api/tomifin/downloads` | `/v1/tomifin/downloads` | Tomifin's downloads with live qBittorrent figures |
| `POST /api/tomifin/downloads/<id>/pause` (`resume`, `cancel`) | `/v1/tomifin/pause` (`resume`, `cancel`) | Controls one download |

All routes need a signed-in Navidrome administrator (`authenticate()` and `isNavidromeAdmin()`, as for Recovery); others get `401` or `403`.

### How a search result reaches qBittorrent

1. The agent runs the same search Recovery's **Search torrents** runs (`createQbittorrentClient().search()`): qBittorrent's enabled search plugins and every Prowlarr or Jackett indexer in `TOMIFY_TORRENT_INDEXERS_JSON`, at once, through qBittorrent on the box. Tomifin asks for plugin category `all`, `movies` or `tv`, and Torznab categories 2000 (Movies) and/or 5000 (TV) instead of Recovery's Music/3000. No other provider is added.
2. The results go through the same filter as Recovery (`seededTorrentResults()` in `torrent.mjs`): at least one seed, links that are safe to give qBittorrent, duplicates merged, best-seeded first. Tomifin also drops results qBittorrent cannot use directly, so only magnet links, `.torrent` file links and configured-indexer download links are offered; a plugin result that points at a web page is left out. Up to 50 are shown.
3. The agent keeps each result's full link for an hour and gives the browser only an id plus what to display (title, source, size, seeders, leechers, magnet or file, quality hints read from the name, and the site's details page). The browser never receives a link, tracker or passkey.
4. **Queue** sends only `{ resultId, destination }`. The Worker accepts a 64-character hex id and `family` or `private`, nothing else. The agent looks the id up in its own results (an unknown or expired id is refused: search again), parses the link again, refuses a torrent qBittorrent already has (so a Recovery torrent is never taken over), and adds it with the existing client: tag `tomifin-<job id>`, category `tomifin-family` or `tomifin-private`, save path from the destination's settings, and a subfolder for multi-file torrents. A Prowlarr or Jackett link is fetched by the agent first, as for Recovery. The job is saved under `TOMIFY_RECOVERY_STATE_DIR/tomifin/` only after qBittorrent accepts it.
5. The downloads list reads each destination's category from qBittorrent once per refresh and matches torrents by their tag, so it shows Tomifin's own downloads and nothing else. Tomifin jobs live in their own folder, so Recovery's job runner never imports, moves or deletes them.

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

   qBittorrent's unit has `UMask=0022`, so downloaded files are readable by anyone who can reach them; Private stays private because nobody outside the group can enter `/media/private`. Only change permissions after checking what Jellyfin expects. The agent (running as `tom`) only reads the folders, to check a download is starting from nothing; it needs no write access and no `ReadWritePaths` change. If it cannot read Private, cancelling a Private download keeps its partial files.

3. **Keep partial files out of Jellyfin (recommended).** In qBittorrent's settings (Downloads), turn on **Append .!qB extension to incomplete files**, so Jellyfin does not pick up half-downloaded videos. It also applies to Recovery's downloads, which is harmless.

4. **Configure the agent.** Add to `/etc/tomify/recovery-agent.env`:

   ```bash
   TOMIFY_TOMIFIN_FAMILY_DIR=/media/family
   TOMIFY_TOMIFIN_PRIVATE_DIR=/media/private
   # Only if qBittorrent sees them at other paths (Docker):
   # TOMIFY_TOMIFIN_FAMILY_QBITTORRENT_DIR=/data/family
   # TOMIFY_TOMIFIN_PRIVATE_QBITTORRENT_DIR=/data/private
   # Largest torrent Tomifin will queue (default 200 GiB):
   # TOMIFY_TOMIFIN_MAX_BYTES=214748364800
   ```

5. **Add the address.** In the Cloudflare dashboard: Workers & Pages → **tomify** → Settings → Domains & Routes → Add → **Custom domain** → `tomifin.tomdixon.uk`. Cloudflare creates the DNS record and certificate. Do this before or straight after merging, because once deployed, Tomify's `/tomifin/` path redirects there. To use a different name, change `TOMIFIN_HOSTNAME` in `wrangler.toml` (a dashboard variable would be replaced on the next deploy). If you want a second gate in front of it, Cloudflare Access can protect just that hostname; Tomifin still needs its own Navidrome administrator sign-in.

6. **Deploy the agent, then the site.** Deploy the agent with `scripts/deploy-agent.ps1` (or `.sh`) as usual ([Updating the recovery agent](DEPLOYMENT.md#updating-the-recovery-agent)), check `journalctl -u tomify-recovery -n 20` has no `Tomifin Downloader is off` line, then merge so Cloudflare deploys the site. The site works before the agent is updated: Tomifin then says the media server needs the latest agent, and Recovery is unaffected (the agent contract stays `2`).

7. **Jellyfin.** Tomifin does not call Jellyfin, and this repository has no Jellyfin integration or API key to reuse. New files appear when Jellyfin next scans: turn on **Real time monitoring** on both libraries (Dashboard → Libraries → library → Manage library), or rely on the scheduled **Scan media library** task.

## Security

- **Access:** every `/api/tomifin/*` route requires a Navidrome administrator, checked by the Worker on each request. Pause, resume and cancel act only on a torrent carrying that job's own `tomifin-` tag, so Recovery's torrents and anything added to qBittorrent by hand are never touched.
- **Paths:** the browser sends `family` or `private`, never a path. Paths come only from the agent's environment, are checked to be separate at start-up, and a content path qBittorrent reports is accepted only strictly inside the destination folder. Job ids are UUIDs; other ids are refused before any file is touched.
- **SSRF and links:** the browser cannot supply a link. Only links produced by the agent's own search are queued, and they pass the same checks as Recovery (magnet info hash, public host, no embedded credentials; only a configured indexer may be on a private address). Search input is trimmed and limited to 200 characters.
- **Credentials:** qBittorrent's password, indexer API keys, tracker passkeys and `RECOVERY_AGENT_TOKEN` stay on the box and in the Worker. Responses carry no links, paths beyond the two library names, or tokens.
- **Logs:** the agent logs the number of search results and the title and library of each queued or removed download; the Worker logs the Navidrome user and library. Neither logs links, search terms or credentials.
- **Separate address:** Tomifin's origin is separate from Tomify's, so browser storage, sign-in and service workers are not shared, and Tomify's APIs are not exposed on Tomifin's address (see [How it fits together](#how-it-fits-together)). Tomify's service worker never serves or precaches Tomifin's page.

## Limitations

- Results are only as good as the configured qBittorrent search plugins and indexers. Plugin results that point at a web page rather than a torrent are not offered.
- Search results are kept in the agent's memory for an hour; after an agent restart, search again before queuing.
- Finished downloads keep seeding until removed from Tomifin or qBittorrent. They count towards qBittorrent's active-torrent limits, which the agent sets from `TOMIFY_TORRENT_MAX_ACTIVE` for Recovery.
- Tomifin downloads keep the torrent's own file and folder names. Jellyfin usually recognises scene-style names; rename in Jellyfin or on disk if one is not matched.
- Tomifin cannot tell whether a torrent's files already existed once data has started arriving, so a download cancelled before the agent checked it keeps its partial files (the confirmation says so).
- There are no push notifications for Tomifin downloads.

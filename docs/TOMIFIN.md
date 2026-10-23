# Tomifin Downloader

Tomifin Downloader is its own web app at its own address, **`https://tomifin.tomdixon.uk/`** (`TOMIFIN_HOSTNAME`), separate from Tomify's. It searches for films and TV with the torrent sources Recovery already uses, and queues a chosen torrent in the media server's existing qBittorrent for the **Family** (`/media/family`) or **Private** (`/media/private`) Jellyfin library. While it downloads, its data sits in a hidden folder of its own inside that library; when it finishes, qBittorrent moves it into the library and Tomifin takes the torrent out of qBittorrent, keeping the files. It does not change Tomify's own pages, player or Recovery, and it is not reachable from Tomify's address (the old `/tomifin/` path there redirects to the new address).

- [Using it](#using-it)
- [How it fits together](#how-it-fits-together)
- [Family and Private destinations](#family-and-private-destinations)
- [Setting it up on the media server](#setting-it-up-on-the-media-server)
- [Security](#security)
- [Limitations](#limitations)

## Using it

1. Open `https://tomifin.tomdixon.uk/` and sign in with your Jellyfin account. Only Jellyfin administrators can use it; anyone else is refused. The sign-in lasts 30 days in that browser, or until you press **Sign out**, change your password or end the session in Jellyfin (Dashboard → Devices).
2. Search for a title. **Films & TV** searches both; **Films** and **TV** narrow it.
3. Press **FAMILY** or **PRIVATE**. Nothing is selected until you choose, the choice is not remembered between visits, and the page shows where downloads will go.
4. Press **Queue to Family** (or **Private**) on a result. Tomifin says it is queued only once qBittorrent has accepted the torrent; otherwise it shows qBittorrent's or the server's reason.
5. **Downloads** lists everything queued from Tomifin with its library, progress, downloaded and total size, speed, time left and status (queued, downloading, stalled, paused, completed or failed). It refreshes every 3 seconds while something is downloading and every 15 seconds otherwise, and has a **Refresh** button.

**Pause** and **Resume** stop and restart the torrent in qBittorrent. **Cancel** takes an unfinished torrent out of qBittorrent and off the list, after a confirmation, and **Remove** takes a finished one off the list:

- a **finished** download is taken out of qBittorrent automatically as soon as its files are in the library, so it does not keep seeding, and qBittorrent's copy of the `.torrent` file and its resume data go with it. The files stay in the library and the download stays on the list as **Completed** until you remove it;
- an **unfinished** download has its partial data deleted only while that data is still in the download's own staging folder (`<library>/.tomifin-incomplete/<job id>/`), which nothing else writes to. Anything in the library itself is never deleted. The confirmation says which will happen.

A torrent whose real size only becomes known once its details arrive (a magnet, usually) is stopped as soon as it turns out to be larger than the download limit (`TOMIFY_TOMIFIN_MAX_BYTES`, 200 GiB by default). It shows as failed, cannot be resumed, and can be cancelled.

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
| `GET /api/tomifin/status` | `/v1/tomifin/status` | Whether Tomifin is set up, and which destinations are available |
| `GET /api/tomifin/search?q=…&kind=video\|movies\|tv` | `/v1/tomifin/search` | Searches the torrent sources |
| `POST /api/tomifin/download` `{ resultId, destination }` | `/v1/tomifin/download` | Queues one search result in qBittorrent |
| `GET /api/tomifin/downloads` | `/v1/tomifin/downloads` | Tomifin's downloads with live qBittorrent figures |
| `POST /api/tomifin/downloads/<id>/pause` (`resume`, `cancel`) | `/v1/tomifin/pause` (`resume`, `cancel`) | Controls one download |

### Signing in

Tomifin uses Jellyfin accounts, and only Jellyfin administrators (`Policy.IsAdministrator`, not disabled) may use it.

1. The page posts the username and password to `POST /api/tomifin/session`. The Worker passes them to the agent, which calls Jellyfin's `/Users/AuthenticateByName` on the box. The password is not stored or logged anywhere.
2. If the account is not an administrator, the agent closes the session Jellyfin just opened (`/Sessions/Logout`) and the page says Tomifin is for administrators (`403`). A wrong password gets `401`.
3. Otherwise the Worker keeps Jellyfin's access token in a cookie, `tomifin_session` (`HttpOnly; Secure; SameSite=Strict; Path=/api/tomifin`, 30 days). Page scripts cannot read it.
4. On every request the agent checks the token with Jellyfin's `/Users/Me` (cached for 30 seconds) and that the user is still an administrator. If Jellyfin no longer accepts it, the Worker clears the cookie and the page shows the sign-in form again.
5. Every request that changes something (sign-in, sign-out, queue, pause, resume, cancel) must carry the `x-tomifin: 1` header, which another site cannot add, so a cross-site form cannot act with your cookie.

Without `TOMIFY_JELLYFIN_URL` on the agent, sign-in answers that Jellyfin sign-in is not set up.

### How a search result reaches qBittorrent

1. The agent runs the same search Recovery's **Search torrents** runs (`createQbittorrentClient().search()`): qBittorrent's enabled search plugins and every Prowlarr or Jackett indexer in `TOMIFY_TORRENT_INDEXERS_JSON`, at once, through qBittorrent on the box. Tomifin asks for plugin category `all`, `movies` or `tv`, and Torznab categories 2000 (Movies) and/or 5000 (TV) instead of Recovery's Music/3000. No other provider is added.
2. The results go through the same filter as Recovery (`seededTorrentResults()` in `torrent.mjs`): at least one seed, links that are safe to give qBittorrent, duplicates merged, best-seeded first. Tomifin also drops results qBittorrent cannot use directly, so only magnet links, `.torrent` file links and configured-indexer download links are offered; a plugin result that points at a web page is left out. Up to 50 are shown.
3. The agent keeps each result's full link for an hour and gives the browser only an id plus what to display (title, source, size, seeders, leechers, magnet or file, quality hints read from the name, and the site's details page). The browser never receives a link, tracker or passkey.
4. **Queue** sends only `{ resultId, destination }`. The Worker accepts a 64-character hex id and `family` or `private`, nothing else. The agent looks the id up in its own results (an unknown or expired id is refused: search again), parses the link again, refuses a torrent qBittorrent already has (so a Recovery torrent is never taken over), and adds it with the existing client: tag `tomifin-<job id>`, category `tomifin-family` or `tomifin-private`, save path from the destination's settings, a subfolder for multi-file torrents, and a download path (qBittorrent's **Keep incomplete torrents in**, per torrent) of `<library>/.tomifin-incomplete/<job id>`. A Prowlarr or Jackett link is fetched by the agent first, as for Recovery.
5. The job record is written under `TOMIFY_RECOVERY_STATE_DIR/tomifin/` **before** qBittorrent is asked, so a torrent can never be downloading without Tomifin knowing. If the record cannot be written, nothing is added. Only a definite refusal (qBittorrent answered with an error or `Fails.`, or the torrent was never sent) removes the record again. If qBittorrent's answer is lost (a timeout or dropped connection), it may have taken the torrent without showing it yet, so the record is kept: the page says qBittorrent did not confirm it, the download shows as **Waiting for qBittorrent to confirm**, and the agent confirms it when the torrent appears or drops the record after 15 minutes if it never does. A second press of **Queue**, or a retry of the same result or info hash while one is being queued or once it is in the downloads, is refused as a duplicate.
6. The downloads list reads each destination's category from qBittorrent once per refresh and matches torrents by their tag, so it shows Tomifin's own downloads and nothing else. Tomifin jobs live in their own folder, so Recovery's job runner never imports, moves or deletes them.
7. Every 10 seconds, and on each refresh of the list, the agent also: gives a new record to any torrent in Tomifin's categories that carries a `tomifin-<id>` tag but has no record (it is listed again, and its files are never deleted on cancel); stops torrents over the download limit; and takes finished torrents out of qBittorrent once their files have been moved into the library (never while they are still in the staging folder or being moved).

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

6. **Deploy the agent, then the site.** Deploy the agent with `scripts/deploy-agent.ps1` (or `.sh`) as usual ([Updating the recovery agent](DEPLOYMENT.md#updating-the-recovery-agent)), check `journalctl -u tomify-recovery -n 20` has no `Tomifin Downloader is off` or `sign-in is off` line, then merge so Cloudflare deploys the site. The site works before the agent is updated: Tomifin then says the media server needs the latest agent, and Recovery is unaffected (the agent contract stays `2`).

7. **Jellyfin.** Tomifin calls Jellyfin only to sign in; it does not change libraries or start scans. New files appear when Jellyfin next scans: turn on **Real time monitoring** on both libraries (Dashboard → Libraries → library → Manage library), or rely on the scheduled **Scan media library** task.

## Family import

With `TOMIFY_TOMIFIN_FAMILY_IMPORT_SUBDIR=.downloads`, Family downloads no longer land in the library directly. qBittorrent keeps them, untouched and seeding, in the hidden staging folder `/media/family/.downloads`. When one finishes, an importer publishes a clean copy for Jellyfin as hardlinks, so no extra disk space is used:

```text
/media/family/.downloads/Toy.Story.2.1999.1080p.BrRip.x264-YIFY/…          qBittorrent's files (seeding, never changed)
/media/family/Toy Story 2 (1999)/Toy Story 2 (1999).mp4                    hardlink to the film
/media/family/Toy Story 2 (1999)/Toy Story 2 (1999).en.srt                 hardlink to the English subtitles
```

Private is not affected: it keeps saving straight into its library and finished Private torrents still leave qBittorrent.

### How it runs

1. qBittorrent's **Run external program on torrent finished** calls `tomifin-family-import-hook.sh "%I" "%L"`. The hook only writes the info hash into `/media/family/.downloads/.tomifin-import-queue/`, and only for category `tomifin-family` and a 40- or 64-character hex hash; it never fails the torrent.
2. `tomifin-family-import.path` notices the queue entry and starts `tomifin-family-import.service`, which runs `family-import.mjs --queue`. `tomifin-family-import-scan.timer` runs a catch-up `--scan` every hour for anything a hook missed or that was not ready.
3. The importer (`recovery-agent/family-import.mjs`) asks qBittorrent, through the agent's existing client and settings, whether the torrent is complete: category `tomifin-family`, progress 100 %, nothing left, a seeding state, and every wanted file at 100 %. It does nothing for a torrent that is not.
4. It checks every file: the save folder and each file must `realpath` to themselves strictly inside `/media/family/.downloads` (no links out, no `..`), be regular, non-empty files of the size qBittorrent expects, not `.!qB` or other partial files, and unchanged over 5 seconds.
5. It ignores samples, trailers, artwork, `.txt`, `.nfo`, `.url` and every other non-video, non-`.srt` file. The main film is the largest video, and it must be the only large one (a second video of 40 % or more of its size, such as CD1/CD2 or two cuts, is ambiguous). `ffprobe` must read it, find a video stream and report at least 20 minutes.
6. It reads `Title (Year)` from the torrent name and the film's file name, dropping dots, resolution, source, codec, audio, HDR and release-group tags. If neither gives a clear year with a title before it and only tags after, if the two disagree, or if it looks like a TV episode, it does not guess.
7. Subtitles (`.srt`) are named after the film. A language suffix (`.en`, `.fr`, …, plus `.forced` or `.sdh`) is added only when exactly one language is named by the subtitle's own file or folder name; otherwise it is plain `Title (Year).srt`. Where two would get the same name, the larger is kept and the other is logged as skipped.
8. It checks the library is on the same filesystem as staging, hardlinks every file into a hidden, Jellyfin-ignored folder `/media/family/.publishing/<hash>-<random>/Title (Year)/`, checks each link shares the source's inode, and then renames that folder into `/media/family/Title (Year)` in one step. Jellyfin never sees a half-built film, and a rename onto a folder that appeared meanwhile fails instead of replacing it.
9. It records the outcome in `/var/lib/tomifin-import/<hash>.json` (paths, inodes and sizes). Running again for the same torrent, from a repeated hook, the queue or the scan, changes nothing. A destination that already holds the same film (same inode, or the same SHA-256) counts as already imported, which is how a film published by hand is recognised.

Anything doubtful goes to `/media/family/.review/<hash>/` instead: hardlinks of the torrent's video and subtitle files plus `reason.json` saying why. That covers ambiguous names, several large videos, unreadable or too-short video, unsafe paths, empty files, and a destination that already exists with different contents, which is never overwritten. Nothing is ever moved, renamed or deleted in staging, and no existing library file is ever replaced. Review folders are left for you; delete one once it is dealt with, and remove the torrent's `/var/lib/tomifin-import/<hash>.json` to let the importer try it again.

Each run logs one JSON line per torrent to the journal (`journalctl -u tomifin-family-import -u tomifin-family-import-scan`): hash, torrent name, detected title and year, the result (`published`, `already-imported`, `review`, `not-ready`, `skipped`, `unchanged`, `failed`), the published paths or the reason. Nothing else is logged, and never a credential.

### Permissions

The importer runs as `qbittorrent` with group `media-family`. That is because the kernel only lets a file's owner, or someone allowed to write to it, hardlink it (`fs.protected_hardlinks`), and qBittorrent owns the downloads. Its unit is otherwise locked down: it can write only under `/media/family` and its own state folder, sees an empty `/home`, and can reach only qBittorrent on this machine. qBittorrent's own unit and hardening are not changed. The hook runs inside qBittorrent's existing sandbox and only creates a file in staging.

Jellyfin skips `.downloads`, `.review` and `.publishing`: each has a `.ignore` file, and their names start with a dot.

### Installing it

The unit files in `recovery-agent/family-import/` are templates: check each `ADJUST` line against the box before installing (where the agent's code lives, the path to `node`, and whether `/media/family` is a system-wide mount or only bind-mounted inside qBittorrent's unit).

1. `sudo apt install ffmpeg` if `ffprobe` is missing.
2. Create the folders, owned by qBittorrent and the Family group:
   ```bash
   sudo -u qbittorrent mkdir -p /media/family/.downloads/.tomifin-import-queue /media/family/.review /media/family/.publishing
   sudo -u qbittorrent touch /media/family/.downloads/.ignore /media/family/.review/.ignore /media/family/.publishing/.ignore
   ```
3. Install the hook: `sudo install -D -m 0755 recovery-agent/family-import/tomifin-family-import-hook.sh /usr/local/lib/tomifin/tomifin-family-import-hook.sh`.
4. Install the units (without `.example`) into `/etc/systemd/system/`, then `sudo systemctl daemon-reload`.
5. **Dry run first:** `sudo systemd-run --wait --pipe -p User=qbittorrent -p SupplementaryGroups=media-family -p EnvironmentFile=/etc/tomify/recovery-agent.env /usr/bin/node /opt/tomify/recovery-agent/family-import.mjs --scan --dry-run`. Check every line it prints; nothing is written.
6. Add `TOMIFY_TOMIFIN_FAMILY_IMPORT_SUBDIR=.downloads` to `/etc/tomify/recovery-agent.env` and redeploy the agent, so new Family downloads go to staging.
7. In qBittorrent → Options → Downloads, turn on **Run external program on torrent finished** with `/usr/local/lib/tomifin/tomifin-family-import-hook.sh "%I" "%L"`.
8. `sudo systemctl enable --now tomifin-family-import.path tomifin-family-import-scan.timer`.

## Security

- **Access:** every `/api/tomifin/*` route except sign-in requires a Jellyfin administrator's session, checked with Jellyfin by the agent (see [Signing in](#signing-in)). Removing someone's administrator role or disabling them in Jellyfin locks them out within 30 seconds. Pause, resume and cancel act only on a torrent carrying that job's own `tomifin-` tag, so Recovery's torrents and anything added to qBittorrent by hand are never touched.
- **Paths:** the browser sends `family` or `private`, never a path. Paths come only from the agent's environment, are checked to be separate at start-up, and a content path qBittorrent reports is accepted only strictly inside the destination folder. Cancelling deletes data only from inside that job's own staging folder. Job ids are UUIDs; other ids are refused before any file is touched.
- **SSRF and links:** the browser cannot supply a link. Only links produced by the agent's own search are queued, and they pass the same checks as Recovery (magnet info hash, public host, no embedded credentials; only a configured indexer may be on a private address). Search input is trimmed and limited to 200 characters. A result's details-page link (`safeDetailsUrl()` in `torrent.mjs`) is shown only if it is a public http(s) page with no user name or password; its fragment and any query parameter that could carry a credential (names like `apikey`, `passkey`, `token`, `sid`, or a value that looks like a generated key) are removed, and a link with a key-like path segment is dropped altogether. Recovery's results use the same cleaning.
- **Credentials:** the Jellyfin password is passed straight to Jellyfin and never stored; the session token lives only in the HttpOnly cookie and the agent's 30-second memory cache. qBittorrent's password, indexer API keys, tracker passkeys and `RECOVERY_AGENT_TOKEN` stay on the box and in the Worker. Responses carry no links, paths beyond the two library names, or tokens.
- **Logs:** the agent logs the number of search results and the title and library of each queued or removed download; the Worker logs who signed in and the library of each queued download. Neither logs links, search terms or credentials.
- **Separate address:** Tomifin's origin is separate from Tomify's, so browser storage, cookies and service workers are not shared, and Tomify's APIs are not exposed on Tomifin's address (see [How it fits together](#how-it-fits-together)). Tomify's service worker never serves or precaches Tomifin's page.

## Limitations

- Results are only as good as the configured qBittorrent search plugins and indexers. Plugin results that point at a web page rather than a torrent are not offered.
- Search results are kept in the agent's memory for an hour; after an agent restart, search again before queuing.
- Finished downloads are not seeded: they leave qBittorrent once their files are in the library. Some private trackers require seeding; use Recovery or qBittorrent directly for those. Unfinished ones count towards qBittorrent's active-torrent limits, which the agent sets from `TOMIFY_TORRENT_MAX_ACTIVE` for Recovery.
- Tomifin downloads keep the torrent's own file and folder names. Jellyfin usually recognises scene-style names; rename in Jellyfin or on disk if one is not matched.
- Tomifin does not check whether the library already holds files with the same names as a download. If it does, qBittorrent's move of the finished download decides what happens to them, so avoid queuing something you already have.
- There are no push notifications for Tomifin downloads.

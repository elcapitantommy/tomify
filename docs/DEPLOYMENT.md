# Deploying Tomify

Tomify has two deployable parts: the **site** (the PWA and the Cloudflare Worker, with its D1 database) and the **recovery agent** on the Debian media server. They deploy separately. When a release changes both, deploy the agent first, because the Worker refuses Recovery requests to an agent whose contract is older than its own (`recovery-agent-outdated`).

- [The site](#the-site)
- [D1 migrations](#d1-migrations)
- [Updating the recovery agent](#updating-the-recovery-agent)
- [Short-lived media tokens and LAN-direct streaming](#short-lived-media-tokens-and-lan-direct-streaming)
- [Box dependencies](#box-dependencies)
- [Secrets and bindings](#secrets-and-bindings)
- [Backups and uptime checks](#backups-and-uptime-checks)

## The site

Cloudflare's Git integration builds and deploys the site on every push to `main`. The build command remains `pnpm build`, and the deploy command remains `npx pnpm run deploy`; no dashboard change is needed. Wrangler uploads `dist/client/` through Workers Static Assets and bundles `dist/server/index.js` separately. Every request except the hashed `/assets/*` runs through the Worker first (so it can serve Tomifin Downloader's separate address, [TOMIFIN.md](TOMIFIN.md)); requests that are not an API or Tomifin are handed to the static asset service with SPA fallback. The deploy command applies any new migration in `drizzle/` to the remote D1 database (`wrangler d1 migrations apply tomify-metadata --remote`) and only then runs `wrangler deploy`, so a failed migration leaves the previous Worker running. The migrations are the only source of the schema: the Worker never creates tables or columns, and a request that needs a table no migration has created yet gets a 503 `schema-out-of-date` instead. To change the schema, add the next numbered file to `drizzle/` and never edit one that has been applied. Note `pnpm deploy` without `run` is a different, built-in pnpm command.

Deploying by hand from a checkout (for example through a Remote Control session) is the same pair of commands: `pnpm run build`, then `npx pnpm run deploy`. The deploy script does not build, so after a change under `src/` run the build first or the old frontend is uploaded again. Check what is live with `GET https://app.tomify.tomdixon.uk/api/version`, which returns the deployed short SHA and contract.

The Worker also has two cron triggers (`[triggers]` in `wrangler.toml`), which `wrangler deploy` registers. Daily at 04:30 UTC it refreshes imported Spotify playlists (needs `SPOTIFY_TOKEN_ENCRYPTION_KEY`, and skips them without it), checks the library's artists for new releases and sends the new-release notification. Every five minutes it checks active Recovery downloads for anyone with Recovery notifications on; with no such subscription it only runs one D1 query. Run them locally with `wrangler dev --test-scheduled` and `curl 'http://localhost:8787/__scheduled?cron=30+4+*+*+*'` (or `cron=*/5+*+*+*+*`).

## D1 migrations

The D1 schema comes only from the numbered files in `drizzle/` (`migrations_dir` in `wrangler.toml`). The Worker no longer runs `CREATE TABLE` or `ALTER TABLE` on requests; when a query names a table or column that no migration has created, it answers 503 with `{"error": "schema-out-of-date"}` and the missing name.

### The one-time switch to migrations (done 2026-10-16, kept for reference)

Production D1 was built by the Worker's old request-time DDL, and 0001-0011 were never applied with wrangler, so it has no `d1_migrations` table. Applying 0002, 0003, 0004 or 0011 to it would fail (`duplicate column`). Before merging the change that removes the runtime DDL:

1. **Back up.** `scripts/d1-baseline.sh --remote` runs `scripts/backup.sh` first and stops if it fails, so run it where the nightly backup is set up: on the media server as `tom`, after `set -a; . /etc/tomify/backup.env; set +a` if you use an API token. You can also run `scripts/backup.sh` by hand beforehand.
2. **Baseline.** From a checkout of the branch on the media server (in the same shell, so wrangler has the same credentials):

   ```bash
   scripts/d1-baseline.sh --remote --dry-run   # backup dry run, then the SQL it would run and what stays pending
   scripts/d1-baseline.sh --remote             # backup, then records 0001-0011 as applied
   wrangler d1 migrations list tomify-metadata --remote   # shows only 0012_schema_catch_up.sql
   ```

   The script creates `d1_migrations` exactly as wrangler does and inserts one row per file name, `0001_recovery.sql` to `0011_recovery_playback.sql`. It refuses a database with no Tomify tables (apply the migrations normally instead) and a `recovery_items` table missing a column 0002-0011 would have added. Running it again changes nothing. `WRANGLER` and `TOMIFY_D1_DATABASE` work as for `backup.sh`. `--local` does the same against wrangler's local copy, without a backup. The old Worker keeps working after the baseline, because nothing in the schema changes.
3. **Change the deploy command.** In the Cloudflare dashboard, under the tomify Worker's Settings → Build → Deploy command, replace `npx wrangler deploy` with `npx pnpm run deploy`. Until the merge, any other push to `main` fails at deploy (the script does not exist there yet) and the current Worker keeps running, so merge straight after this step. If the build later fails with an authorisation error from `d1 migrations apply`, give the build's API token the D1 Edit permission.
4. **Merge.** The build runs `pnpm run deploy`: `wrangler d1 migrations apply tomify-metadata --remote` applies `0012_schema_catch_up.sql`, then `wrangler deploy` publishes the Worker.

`0012_schema_catch_up.sql` creates `release_metadata` (which existed only as runtime DDL), repeats every other table in its current shape in case its route had never been used, and adds indexes for the Recovery list, uploaded covers, shared playlists and expired Spotify sign-in states. Every statement is `IF NOT EXISTS`, so it does nothing to objects the old Worker created.

If something goes wrong: a failed `migrations apply` stops the deploy and leaves the old Worker running; fix the migration and push again. A 503 `schema-out-of-date` after the merge means the baseline or step 3 was skipped: run `scripts/d1-baseline.sh --remote`, then `wrangler d1 migrations apply tomify-metadata --remote`. To undo everything, restore the backup as in [Restoring from a backup](#restoring-from-a-backup).

### Changing the schema later

Add the next numbered file (`0013_<name>.sql`) and merge; the deploy applies it before the new Worker goes live. Never edit a file that has been applied. Test it locally with `npx wrangler d1 migrations apply tomify-metadata --local`; `scripts/d1-migrations.node-test.mjs` checks in CI that every SQL statement in the Worker matches the migrated schema.

## Updating the recovery agent

The agent is not deployed with the site. Deploying the Worker updates the Recovery page and API only, so every merged change under `recovery-agent/` or `shared/` must also be deployed to the media server. The server deliberately has no Git checkout.

From an up-to-date, validated Windows checkout, run:

```powershell
.\scripts\deploy-agent.ps1
```

On Linux or macOS, use `./scripts/deploy-agent.sh`. Set `TOMIFY_AGENT_HOST` or pass `-HostName user@host` in PowerShell / `--host user@host` in the shell script when the destination is not `tom@tomify`.

Before the first deploy with this version of the scripts, run the one-time setup below. The deploy command refuses uncommitted changes under `recovery-agent/` or `shared/`, packages both directories with `package.json` and copies one archive to `/tmp`. The installer runs as `tom`, not root: it creates the immutable release `/opt/tomify/releases/<short-sha>` and atomically switches `/opt/tomify/current`. It then calls the root helper `/usr/local/sbin/tomify-agent-activate`, which updates only `TOMIFY_VERSION` in `/etc/tomify/recovery-agent.env`, writes the systemd unit from its own built-in template and restarts the service. The installer waits up to 30 seconds for `/health` to report that SHA. If the new agent does not become healthy it restores the earlier symlink and version automatically. Only the newest five releases are retained.

The Worker embeds its own short SHA at build time and exposes it with contract `2` at `GET /api/version`; authenticated agent status exposes the deployed agent version and the same contract. Settings shows both values and warns only when the contracts differ; a different version alone is expected after a site-only deploy and needs no agent redeploy.

Before search, acquisition, or **Import rest of download**, the Worker checks the agent contract and caches the result for about one minute. An agent with no contract or a contract below `2` is rejected with HTTP 409 `recovery-agent-outdated` and a link back to these update instructions. This prevents a newer site from sending a request an older agent may misinterpret, such as the former *Artist and title are required.* failure. Deploy the agent before the site whenever a release changes both.

### One-time setup for password-free deploys

Run this once from the Windows checkout. It asks for the sudo password one last time:

```powershell
.\scripts\deploy-agent.ps1 -Setup
```

The shell equivalent is `./scripts/deploy-agent.sh --setup`. Setup does four things:
- It installs `scripts/tomify-agent-activate.sh` as `/usr/local/sbin/tomify-agent-activate` (root-owned, 0755).
- It adds `/etc/sudoers.d/tomify-deploy` so `tom` can run that one helper without a password.
- It makes `/etc/tomify` and `/etc/systemd/system` root-only.
- It hands `/opt/tomify` and its releases to `tom`.

The helper takes only `--version <git sha>` or `--clear-version`. It never runs anything from a release archive and always writes a unit that runs the agent as `tom` with the usual sandbox, so the rule grants no other root access. The agent already runs as `tom`, so owning the release files adds nothing.

Re-run `-Setup` after a change to `scripts/tomify-agent-activate.sh` or `recovery-agent/tomify-recovery.service.example`; a test keeps those two units identical. To undo it, run `sudo rm /etc/sudoers.d/tomify-deploy /usr/local/sbin/tomify-agent-activate`.

To roll back deliberately:

```powershell
.\scripts\deploy-agent.ps1 -Rollback
```

The matching shell command is `./scripts/deploy-agent.sh --rollback`. It uses the installer from your checkout (an older release's copy may predate the root helper), swaps the current and previous releases, updates `TOMIFY_VERSION`, restarts the service and verifies the older version before accepting the rollback.

### One-time migration from `/opt/tomify/recovery-agent`

Pull a commit containing these deployment scripts, make sure the existing `/etc/tomify/recovery-agent.env` is intact, then run `.\scripts\deploy-agent.ps1` once. The installer copies the old mutable runtime into `/opt/tomify/releases/legacy` as the first rollback target, creates `/opt/tomify/current`, and replaces the main service unit so it starts `/opt/tomify/current/recovery-agent/index.mjs`. Existing systemd drop-ins and the original `/opt/tomify/recovery-agent` directory remain untouched. Verify on Debian:

```bash
readlink -f /opt/tomify/current
curl -s http://127.0.0.1:8788/health; echo
systemctl status tomify-recovery --no-pager
```

The health response's `version` must match the final directory name printed by `readlink`. Once a normal deploy and a rollback have both been tested, the unused legacy `/opt/tomify/recovery-agent` and `/opt/tomify/shared` directories may be archived or removed separately; the installer does not delete them.

The live environment remains `/etc/tomify/recovery-agent.env`. Runtime state and cache directories are `/var/lib/tomify-recovery` and `/var/cache/tomify-recovery`. The systemd sandbox sets `HOME=/var/lib/tomify-recovery`, keeps home directories hidden, and grants write access only to the state/cache directories, `/srv/music-recovery`, `/srv/usenet/completed`, and `/srv/torrents`; `/opt/tomify/secrets` remains read-only. Polkit-based VPN control and reboot remain available. If any recovery or download root uses a different host path, add that exact path with a `ReadWritePaths=` line in a systemd drop-in, then run `sudo systemctl daemon-reload` and restart the service.

### Manual fallback

Before the one-time migration, the legacy layout can still be updated by hand. This has no automatic health rollback and does not set `TOMIFY_VERSION`, so prefer the deploy command:

```powershell
ssh tom@tomify "mkdir -p /tmp/tomify-shared"
scp recovery-agent\*.mjs tom@tomify:/tmp/
scp shared\*.mjs tom@tomify:/tmp/tomify-shared/
ssh -t tom@tomify "sudo cp /tmp/*.mjs /opt/tomify/recovery-agent/ && sudo mkdir -p /opt/tomify/shared && sudo cp /tmp/tomify-shared/*.mjs /opt/tomify/shared/ && sudo systemctl restart tomify-recovery"
```

The agent imports `../shared/quality.mjs`, so the two legacy directories must remain siblings. After migration, use the release installer or its rollback command rather than modifying a release in place.

## Short-lived media tokens and LAN-direct streaming

Both are off until configured, and turn on in two stages. How they work is in [Media sessions and LAN-direct streaming](ARCHITECTURE.md#media-sessions-and-lan-direct-streaming).

**Stage 1: short-lived media tokens (Worker only).** Stream and HLS URLs then carry a 4-hour token instead of the Navidrome login. This needs no change on the box.

1. Generate one random key and keep it somewhere safe; the box needs the same value in stage 2: `openssl rand -base64 48`.
2. In the Cloudflare dashboard, tomify Worker → Settings → Variables and Secrets, add the **secret** `TOMIFY_MEDIA_KEY` with that value and deploy.
3. Check: reload the app, play a track, and in the browser's network panel the `stream.view` or `master.m3u8` request has `mt=` and no `t=` or `s=`.

**Stage 2: LAN-direct streaming.** At home, players stream straight from the box instead of through Cloudflare. The app is served over HTTPS, so the box must answer on an HTTPS name with a certificate browsers trust; a plain `http://192.168.…` address would be blocked as mixed content. The names below are examples; use the same ones in every step.

1. **A fixed LAN address.** Give the box a DHCP reservation on the router (for example `192.168.1.20`).
2. **A DNS name.** In Cloudflare DNS for `tomdixon.uk`, add an `A` record `lan.tomify` → `192.168.1.20` with proxy status **DNS only** (grey cloud). It is public, but the address only answers at home; elsewhere the player's 1.5-second probe fails and it uses the Worker. Some routers block public names that answer with private addresses (DNS rebinding protection, for example in dnsmasq, Pi-hole or OpenWrt): allow `lan.tomify.tomdixon.uk` there, or add the same name as a local DNS entry on the router. Check from a laptop or phone at home: `nslookup lan.tomify.tomdixon.uk` returns `192.168.1.20`.
3. **A certificate**, from Let's Encrypt with the DNS challenge, so no port is opened to the internet:
   1. Create a Cloudflare API token (My Profile → API Tokens → Create Token → *Edit zone DNS* template, Zone Resources: *Specific zone* `tomdixon.uk`).
   2. On the box:

      ```bash
      sudo apt install certbot python3-certbot-dns-cloudflare
      sudo sh -c 'umask 077; echo "dns_cloudflare_api_token = <token>" > /etc/letsencrypt/cloudflare.ini'
      sudo certbot certonly --dns-cloudflare --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \
        --dns-cloudflare-propagation-seconds 30 -d lan.tomify.tomdixon.uk
      ```

   3. The agent runs as `tom` and cannot read `/etc/letsencrypt/live`, so a deploy hook copies the files into `/opt/tomify/secrets/lan` on every renewal. Create `/etc/letsencrypt/renewal-hooks/deploy/tomify-lan.sh`:

      ```sh
      #!/bin/sh
      set -e
      install -d -o root -g tom -m 750 /opt/tomify/secrets/lan
      install -o root -g tom -m 640 /etc/letsencrypt/live/lan.tomify.tomdixon.uk/fullchain.pem /opt/tomify/secrets/lan/fullchain.pem
      install -o root -g tom -m 640 /etc/letsencrypt/live/lan.tomify.tomdixon.uk/privkey.pem /opt/tomify/secrets/lan/privkey.pem
      ```

      then `sudo chmod 755 /etc/letsencrypt/renewal-hooks/deploy/tomify-lan.sh`, run it once by hand with `sudo`, and check renewal with `sudo certbot renew --dry-run` (Debian's `certbot.timer` renews automatically). The agent re-reads the files twice a day, so a renewal needs no restart.
4. **The agent's settings.** Add to `/etc/tomify/recovery-agent.env`:

   ```bash
   TOMIFY_LAN_PORT=8789
   TOMIFY_LAN_TLS_CERT=/opt/tomify/secrets/lan/fullchain.pem
   TOMIFY_LAN_TLS_KEY=/opt/tomify/secrets/lan/privkey.pem
   TOMIFY_MEDIA_KEY=<the same value as the Worker secret>
   ```

   Optional: `TOMIFY_LAN_HOST` (default `0.0.0.0`, every interface) and `TOMIFY_LAN_ALLOWED_ORIGINS` (default `https://app.tomify.tomdixon.uk`, comma-separated). Streams are read from Navidrome on the box at `TOMIFY_NAVIDROME_URL` (default `http://127.0.0.1:4533`), as adaptive streaming already does. The unit needs no change: `/opt/tomify/secrets` is already readable, and port 8789 needs no privileges.
5. **Deploy and restart.** Deploy this release of the agent (`.\scripts\deploy-agent.ps1`), or `sudo systemctl restart tomify-recovery` after changing only the env file. `journalctl -u tomify-recovery -n 20` shows `Tomify LAN streaming listening on https://0.0.0.0:8789`; a line starting `LAN-direct streaming is off:` names the missing setting or unreadable file.
6. **Let the LAN in, and only the LAN.** Do not forward port 8789 on the router. With NordVPN connected on the box, allow the port the way SSH is allowed ([Allowlist the LAN, SSH and the tunnel](RECOVERY.md#allowlist-the-lan-ssh-and-the-tunnel)): `nordvpn allowlist add port 8789 protocol TCP`, with `lan-discovery` on. If the box runs `ufw`, also `sudo ufw allow from 192.168.1.0/24 to any port 8789 proto tcp`.
7. **Check from a laptop at home:** `curl -i -H 'Origin: https://app.tomify.tomdixon.uk' https://lan.tomify.tomdixon.uk:8789/lan/ping` returns `200` with `access-control-allow-origin: https://app.tomify.tomdixon.uk`, and no certificate warning.
8. **Tell the Worker.** Set `TOMIFY_LAN_ORIGIN` = `https://lan.tomify.tomdixon.uk:8789` under `[vars]` in `wrangler.toml` and deploy. A plain variable added only in the dashboard is removed by the next `wrangler deploy` from the repo, because `[vars]` replaces them. Reload the app at home and play a track: its requests go to `lan.tomify.tomdixon.uk:8789`. Chrome and Edge ask once whether the site may access devices on the local network; allow it. If it is refused, or the box does not answer, playback goes through the Worker as before.

To turn LAN streaming off, remove `TOMIFY_LAN_ORIGIN` from `wrangler.toml` and deploy; players stop using the box at their next token refresh or reload. Deleting `TOMIFY_MEDIA_KEY` goes back to login URLs; a player that is open fails one stream, asks again and carries on with the login. To change the key, change it on the Worker and the box together; open players pick up a new token after their next failed stream.

## Box dependencies

The agent runs on Debian with Node.js 20. Paths are set in `/etc/tomify/recovery-agent.env` (see `recovery-agent/recovery-agent.env.example`); leaving an optional one blank turns that feature off.

| Tool | Install | Used for | Setting |
| --- | --- | --- | --- |
| Node.js 20 | Debian package | The agent itself | (systemd unit) |
| ffmpeg, ffprobe | `sudo apt install ffmpeg` | Probing, HLS, tag rewrites | `FFMPEG_PATH`, `FFPROBE_PATH` |
| yt-dlp | Upstream release in `/usr/local/bin` | YouTube acquisition | `YT_DLP_PATH` |
| rsgain | `sudo apt install rsgain` (Debian 13) or the upstream `.deb` | ReplayGain tags ([ReplayGain tagging](RECOVERY.md#replaygain-tagging)) | `RSGAIN_PATH` |
| bpm-tools | `sudo apt install bpm-tools` | BPM tags for the DJ ([BPM, genre and mood tags](RECOVERY.md#bpm-genre-and-mood-tags)) | `BPM_PATH` |
| qBittorrent-nox, 7-Zip | `sudo apt install qbittorrent-nox 7zip` | Torrent links ([Torrent links and qBittorrent](RECOVERY.md#torrent-links-and-qbittorrent)) | `TOMIFY_QBITTORRENT_URL`, `SEVEN_ZIP_PATH` |
| polkitd | `sudo apt install polkitd` | Restart and VPN control from Settings ([Restarting the media server](RECOVERY.md#restarting-the-media-server-from-tomify)) | `TOMIFY_RECOVERY_ALLOW_REBOOT`, `TOMIFY_RECOVERY_ALLOW_VPN_CONTROL` |
| npm, wrangler 4.86.0 | `sudo apt install npm`, then `sudo npm install -g wrangler@4.86.0` | Nightly D1 backup | `WRANGLER` |

Wrangler 4.87 and later need Node.js 22, so the box stays on 4.86.0 while it runs Node.js 20. The full first-time agent setup (environment file, recovery folders, Cloudflare Tunnel) is in [Media-server setup](RECOVERY.md#media-server-setup).

## Secrets and bindings

`wrangler.toml` holds the D1 (`TOMIFY_DB`), Workers AI (`AI`) and static assets (`ASSETS`) bindings and the non-secret `NAVIDROME_ORIGIN`. Every other Worker variable and every secret, including `RECOVERY_AGENT_URL` and `RECOVERY_AGENT_TOKEN`, is set in the Cloudflare dashboard and never committed. [The architecture configuration table](ARCHITECTURE.md#configuration) lists each one with what it is for and what happens when it is missing.

On the box, `/etc/tomify/recovery-agent.env` holds the agent's settings and its `TOMIFY_RECOVERY_TOKEN` (at least 32 characters, matching the Worker's `RECOVERY_AGENT_TOKEN`) and, for LAN-direct streaming, `TOMIFY_MEDIA_KEY` (matching the Worker's secret of the same name), and `/etc/tomify/backup.env` holds the Cloudflare API token used by the backup. Both are owner-only.

## Backups and uptime checks

D1 holds the only copy of playlists, imported Spotify playlists and recovery state, and `/var/lib/tomify-recovery` holds the agent's job state. `scripts/backup.sh` backs both up on the Debian box:

- `wrangler d1 export tomify-metadata --remote` to `tomify-d1-<UTC time>.sql`;
- a tar.gz of the agent state directory to `tomify-agent-state-<UTC time>.tar.gz`.

Both go to `BACKUP_DIR` (default `/var/backups/tomify`, created with owner-only permissions), and only the newest 14 of each are kept (`BACKUP_KEEP`). A file is only renamed into place once it is complete, so a failed run never counts towards the 14. `TOMIFY_RECOVERY_STATE_DIR`, `TOMIFY_D1_DATABASE` and `WRANGLER` (for example `npx --yes wrangler@4`) override the other defaults. The script prints file names only, never tokens or the Cloudflare account.

### Setting up the nightly backup

1. Install wrangler on the box. Debian's Node.js comes without npm, so `sudo apt install npm` first. Wrangler 4.87 and later need Node.js 22, and the box runs Node.js 20 (which the agent also uses), so pin the last release that supports it: `sudo npm install -g wrangler@4.86.0`. The box has no Git checkout and needs none; wrangler finds the database by name.
2. Authenticate wrangler as `tom`. On a headless box an API token is simplest: create one in the Cloudflare dashboard with the **Account → D1 → Edit** permission, then create `/etc/tomify/backup.env` with `CLOUDFLARE_API_TOKEN=...` and `CLOUDFLARE_ACCOUNT_ID=...`, owned by `tom` with mode `600`. Running `wrangler login` as `tom` also works.
3. Create the backup folder: `sudo install -d -o tom -g tom -m 700 /var/backups/tomify`. A different disk from the agent state, or a regular copy off the box, protects against losing the NVMe; set `BACKUP_DIR` in `backup.env` to change it.
4. Copy the script and units over from the Windows checkout, as for the agent:

   ```powershell
   scp scripts\backup.sh scripts\tomify-backup.service.example scripts\tomify-backup.timer.example tom@tomify:/tmp/
   ssh -t tom@tomify "sudo install -m 755 /tmp/backup.sh /opt/tomify/backup.sh && sudo cp /tmp/tomify-backup.service.example /etc/systemd/system/tomify-backup.service && sudo cp /tmp/tomify-backup.timer.example /etc/systemd/system/tomify-backup.timer && sudo systemctl daemon-reload"
   ```

5. Check it, then enable the timer (nightly at about 03:30, caught up after the box was off):

   ```sh
   set -a; . /etc/tomify/backup.env; set +a; /opt/tomify/backup.sh --dry-run
   sudo systemctl start tomify-backup.service && journalctl -u tomify-backup -n 20
   sudo systemctl enable --now tomify-backup.timer
   ```

`--dry-run` checks that wrangler is logged in and prints the commands and the old backups it would delete, without changing anything. `systemctl list-timers tomify-backup.timer` shows the last and next run; a failed run shows in `systemctl status tomify-backup`.

### Restoring from a backup

D1 first: for a mistake in the last few days, D1 Time Travel is quicker than an export (`wrangler d1 time-travel restore tomify-metadata --timestamp=<RFC 3339 time>`). To restore an export, load it into a new, empty database so nothing is half-overwritten, then switch the Worker to it:

```sh
wrangler d1 create tomify-metadata-restored
wrangler d1 execute tomify-metadata-restored --remote --file /var/backups/tomify/tomify-d1-<time>.sql
```

Check the data (for example `wrangler d1 execute tomify-metadata-restored --remote --command "SELECT COUNT(*) FROM recovery_items"`), then put the new `database_name` and `database_id` in `wrangler.toml` and redeploy.

Agent state:

```sh
sudo systemctl stop tomify-recovery
sudo mv /var/lib/tomify-recovery /var/lib/tomify-recovery.before-restore
sudo tar -xzf /var/backups/tomify/tomify-agent-state-<time>.tar.gz -C /var/lib
sudo chown -R tom:tom /var/lib/tomify-recovery
sudo systemctl start tomify-recovery
```

Delete `/var/lib/tomify-recovery.before-restore` once the Recovery page looks right.

### External uptime check

Point any external HTTP monitor (a free tier of a hosted monitor, or a cron job on another machine running `curl -fsS`) at two URLs, every few minutes:

- the Tomify site's URL, expecting HTTP 200;
- `RECOVERY_AGENT_URL` followed by `/health`, expecting HTTP 200 with `"ok":true`. This is the agent through its Cloudflare Tunnel, so it also fails when the box, the agent or the `tomify-recovery-cloudflared` container is down. `/health` needs no token and returns only the list of available backends.

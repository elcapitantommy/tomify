# TomTube

TomTube is Tomify's own YouTube player: ad-free videos and background audio on an iPhone, served entirely from the Tomify server. It is a home-screen web app at `https://app.tomify.tomdixon.uk/tomtube/`, with a small service on the media server that does the YouTube side.

- [Status: what is verified and what is not](#status)
- [How it works](#how-it-works)
- [Recommendations](#recommendations)
- [Design decisions](#design-decisions)
- [Upstream dependencies and limitations](#upstream-dependencies-and-limitations)
- [Setting up the media server](#setting-up-the-media-server)
- [Setting up the Worker](#setting-up-the-worker)
- [Installing TomTube on an iPhone](#installing-tomtube-on-an-iphone)
- [Manual playback test checklist](#manual-playback-test-checklist)
- [Diagnostics and troubleshooting](#diagnostics-and-troubleshooting)
- [Service API](#service-api)
- [Security](#security)

## Status

This is a proof of concept. The automated checks below run in CI; **none of the acceptance tests have been run on an iPhone yet**, and YouTube itself could not be reached from the environment the code was written in, so real extraction has not been exercised either.

| Area | Verified by | Not yet verified |
| --- | --- | --- |
| URL validation, format choice, error mapping | Unit tests (`tomtube-service/*.node-test.mjs`) | |
| Byte ranges, 206/416, HEAD, MIME types, expired-URL renewal, dropped-connection resume, stream limits | Service tests against a fake YouTube server | Real googlevideo.com behaviour |
| HLS playlists over YouTube-style fragmented MP4 | Unit tests, plus **ffmpeg playing, probing and seeking** the master and audio playlists end to end through the service | **Safari / AVPlayer** playing them |
| Audio cache: bounded size, age, partial files removed, served from disk | Unit and service tests | |
| Worker: sign-in required, fixed path list, allowed users, re-signed playlists | Route tests against the built Worker | |
| Player: video/audio switch keeps position, video element released, Media Session handlers and metadata, retries and HLS→file fallback, queue progression inside `ended`, continuous queue mapping | Unit tests with fake media elements (jsdom) | **iOS WebKit behaviour**, which only a device shows |
| yt-dlp invocation | Runs the real yt-dlp 2026.10.26 binary; its failures are classified correctly | Successful extraction (YouTube was unreachable) |
| Recommendations: cookie parsing and encrypted storage, signal weights, suggestions after expiry, RSS parsing, rate limits, Worker paths and owner-only cookie changes | Unit and service tests with a fake yt-dlp and fake RSS | Real `:ythistory`, `:ytsubs`, `:ytrec` output and how long YouTube keeps the cookies valid |
| Test A — ad-free video on iPhone | | Needs device test |
| Test B — locked-screen audio | | Needs device test |
| Test C — queue progression while locked | | Needs device test (experimental) |

Run the [manual checklist](#manual-playback-test-checklist) on the phone before treating any of A, B or C as passing.

## How it works

```text
 iPhone: TomTube home-screen app (/tomtube/)
   │ HTTPS: JSON with the Tomify sign-in; media URLs carry a 4-hour media token (mt=)
   ▼
 Cloudflare Worker  worker/routes/tomtube.ts
   │ checks the Navidrome sign-in (and TOMTUBE_ALLOWED_USERS), passes only TomTube's own paths,
   │ re-signs playlists with a fresh token
   │ HTTPS + bearer token, through the Cloudflare Tunnel (TOMTUBE_SERVICE_URL)
   ▼
 Media server: tomtube.service (Node, 127.0.0.1:8790), separate from the recovery agent
   ├── yt-dlp (+ Deno for YouTube's player challenges, optional PO token provider)
   │     resolves a video id to its formats; results cached in memory until the URLs expire
   ├── HLS playlists built from each file's segment index (no ffmpeg, no transcoding)
   ├── range-request proxy to *.googlevideo.com only, 10 MB upstream chunks, resumes and renews
   └── bounded audio cache on disk (/var/cache/tomtube/audio)
```

**Playback formats.** iPhones play H.264 video and AAC audio natively. YouTube offers both as separate "adaptive" fragmented MP4 files (H.264 up to 1080p; AAC at 128 kbps), each starting with a segment index. TomTube reads that index (the first few kilobytes) and describes each file to Safari as an HLS playlist of byte ranges (`EXT-X-MAP`, `EXT-X-BYTERANGE`). Settings → **Video quality** is **1080p (fixed)** by default: the playlist then lists only the largest stream up to 1080p, so Safari can't step down to a lower quality (on a slow connection it buffers instead). **Automatic** lists every stream, starts near 720p and follows the connection. Safari buffers and seeks by itself, fetching exact byte ranges that the service streams from YouTube. A 360p single-file MP4 (YouTube's format 18) is the fallback, and audio is also available as one `.m4a` file. VP9, AV1, Opus and WebM are never offered, because iOS Safari cannot play them in HLS. Nothing is transcoded, and ffmpeg is not used at all.

**Video playback (Test A).** The app plays `/api/tomtube/videos/<id>/master.m3u8` in a `<video>` element. Because TomTube fetches the media streams itself, none of YouTube's player, ad requests or ad breaks are involved.

**Audio mode (Test B).** Tapping **Audio only** notes the position, pauses and empties the `<video>` element (it does not keep running in the background), loads the video's audio into a separate `<audio>` element and starts it at the same position. On iPhone and iPad the audio is the single `audio.m4a` file by default, because device testing showed iOS pausing HLS audio (`audio.m3u8`) when the phone locks while the M4A file kept playing; elsewhere it is HLS. Settings → **Audio stream** can choose either everywhere. When the service is asked for an audio playlist it also downloads that video's audio (a few MB) to its disk cache, so a locked phone keeps playing even if YouTube's address expires or YouTube is slow. The Media Session API supplies the lock-screen title, channel, artwork, play/pause, next/previous and seeking, which headphones, Bluetooth and CarPlay-style controls use too. Interruptions (calls, Siri) pause, and the lock-screen play button resumes. A stalled or failed stream is reloaded from where it stopped (1, 3, 6, 10, 15 seconds), and an HLS stream that fails twice falls back to the single `.m4a` file.

**Locking during a video on iPhone and iPad (paired playback).** With **Keep listening when the phone locks** on (the default), the sound of a video always comes from the `<audio>` element, from the moment playback starts. The `<video>` element plays a muted, video-only stream (`video.m3u8`, the same quality variants without the audio track) and follows the audio. Device testing showed that iOS will not start a new audio element while the page is going to the background, so nothing has to start when the phone locks:

| | Picture (`<video>`, muted) | Sound (`<audio>`, M4A by default) |
|---|---|---|
| Watching a video | playing, kept in step | playing |
| Phone locked | paused by TomTube (and by iOS) | keeps playing |
| Phone unlocked | moved to the sound's position and restarted | keeps playing |
| **Audio only** | stopped and emptied | keeps playing, never reloaded |

- **Drift.** The picture is moved to the sound's position when the two are 0.3 s or more apart, at most every 2 seconds, and straight away after loading, buffering or unlocking.
- **Seeking.** TomTube's seek bar, the lock screen and headphones move the sound and the picture together. Scrubbing in the full-screen video player moves the sound to match.
- **Buffering.** If the sound buffers, the picture waits for it. If the picture buffers, the sound keeps going and the picture catches up, so there is never a moment where only the picture is playing.
- **Pause and play.** Pausing anywhere (the app, the lock screen, headphones, the full-screen player) pauses both. A pause of the picture alone counts as yours only if TomTube is still visible a second later, because iOS pauses the video for the lock screen a moment before the page reports being hidden.
- **Next video.** The queue moves on in the `<audio>` element exactly as in audio mode, so it works while locked too; the picture is attached when you come back.
- **Picture unavailable.** If `video.m3u8` fails twice the picture falls back to the 360p single file (muted), and if that fails too the sound carries on alone with the thumbnail.
- The tap that starts a video starts both elements, which is what iOS requires before a page may control them.

Paired playback is used only on iPhone and iPad with the setting on. Elsewhere, or with the setting off, the video plays with its own sound as before, and on other platforms TomTube switches to the audio element when the page is hidden.

**Queue progression (Test C, experimental).** Two mechanisms are implemented:

1. **Standard.** When a video ends, the next one's URL is built locally and set and played on the same `<audio>` element synchronously inside the `ended` event, with no network request or `await` in between. The server has already downloaded the next video's audio while the phone was awake. iOS allows a page that is playing audio to change source like this; whether it still does once the page has been locked for a while is exactly what Test C checks.
2. **Continuous queue** (Settings, off by default). In audio mode TomTube plays the current video and the next 19 queued ones as **one** HLS stream from the server (`/api/tomtube/queue.m3u8`), each video a discontinuity with its own initialisation section. Nothing has to start between tracks, so iOS has nothing to refuse. The app follows which video is playing from the stream position and updates the lock screen. If the standard way fails on a locked phone, try this one.

If neither works reliably on iOS, that is a WebKit limitation of web apps, and the answer is a small native client (below).

**A future native client.** The service's API is plain HTTP with HLS and byte ranges, which is what AVPlayer wants. A native iOS app could use the same Worker paths (or the same service through its own token) with `AVPlayer` and `AVAudioSession` in `.playback` mode and `MPNowPlayingInfoCenter`, which removes every web-app limitation above. The same applies to an LG webOS client or TOMMICH: they need only the JSON API and the HLS URLs.

## Recommendations

TomTube builds its own recommendation model on the box (`tomtube-service/training.mjs`) and shows it on the home screen as shelves above **Recently watched**. It learns all the time from what you watch in TomTube. Optionally, a `cookies.txt` from your YouTube account lets it also learn from your YouTube history, subscriptions and recommendations. There is no fixed training period: while the cookies work, YouTube-powered discovery is added on top; when they expire, the model just carries on with what it has; renewing them adds to it again without resetting anything.

**Signals.** What YouTube recommends is never treated as something you like.

| What happened | Weight in the model |
| --- | --- |
| You finished a video (or watched 80%+) | Strong positive (+3 for its channel) |
| You watch a channel again and again | Strong positive (+1 per extra video finished or mostly watched, up to +4) |
| You subscribe to the channel (from `:ytsubs`) | Positive (+2) |
| You watched most of a video (50%+) | Positive (+1.5) |
| It is in your YouTube watch history | Positive (+1) |
| You watched a little of it | Slight positive (+0.3) |
| You moved on within 10 seconds of it starting | Weak negative (−0.5) |
| **Not interested** (⋮ menu on a suggestion) | Strong negative (−4 for its channel; that video is never shown again) |
| YouTube recommended it (`:ytrec`) | Discovery only: shown while fresh, and a channel recommended in two or more syncs is suggested to try. Never counted as liked |

Signals fade with a 90-day half-life (Not interested: 180 days). Any channel whose score is negative is left out of every shelf.

**Shelves**, in order: *Recommended for you* (YouTube's own recommendations from the last sync, while under two days old, minus what you've seen); *New from channels you watch* (latest uploads, from each channel's public RSS feed, of up to 8 channels you like most); *Channels you might like* (channels YouTube kept recommending that you haven't watched); *More like what you finish* (YouTube searches for up to three topics that recur in titles you finished or mostly watched). Results are cached for an hour; **Refresh** recomputes them.

**First set-up (admin only).** Put your Navidrome username in `TOMTUBE_TRAINING_USERS` in `wrangler.toml` and deploy. The feed reading hasn't been tried against real YouTube yet, so try it first with cookies from a **disposable** YouTube account, check Settings shows *valid* and the shelves fill, then remove them and add your own.

**Checking the import against your account.** Every sync keeps a report of what each feed returned (the last five are kept, in that owner's own profile). Only owners (`TOMTUBE_TRAINING_USERS`) can see it, and only their own. Open TomTube → Settings → Recommendations → **Show import report**, or on the box `curl -s -H "Authorization: Bearer $T" http://127.0.0.1:8790/v1/training/imports`. For each feed it shows how many entries came back, how many became usable videos, how many had no channel ID (and how many of those were looked up), missing channel names, titles and durations, entries dropped and what kind they were, the structure and field names yt-dlp returned, yt-dlp's warnings, sign-in failures, and three sample videos. Settings also shows the first problem of the last import under **Sync now**. What to look for on the first real run:

- `:ythistory` and `:ytsubs` with **0 videos** or **failed (… signed out)**: the cookies didn't sign in. Export them again from a private window.
- **unexpected structure (no entries list)**: yt-dlp's output for that feed changed. Update yt-dlp, then send me the report.
- **N of M videos have no channel ID**: yt-dlp's flat feed entries didn't include the channel. TomTube reads it from the entry's channel URL when present, and otherwise looks up 10 videos per sync the ordinary signed-out way (never with your cookies). If many are still missing after a few syncs, history and subscriptions count for less; send me the report.
- **entries were not usable videos**: shelves, Shorts or playlists in the feed, which are skipped. A few are normal.

**Adding or renewing cookies.** TomTube → Settings → Recommendations → *Add YouTube cookies* (or *Renew*):

1. On a computer, open a private (incognito) window and sign in to youtube.com with your account.
2. Export the cookies for youtube.com as `cookies.txt` (Netscape format), for example with the “Get cookies.txt LOCALLY” extension. A JSON export of the cookies works too.
3. Close the private window (so the browser doesn't rotate the cookies), then upload the file or paste its text in Settings.

TomTube checks them straight away and Settings shows **valid**, **expired** or the last error, when they were last synced, when the next sync is, and when the sign-in expires at the latest. YouTube may end the session sooner (for example after a password change); Settings then says the cookies expired and the suggestions continue from the model. *Sync now* reads the feeds again (at most once every 15 minutes), *Remove cookies* deletes them from the box, and *Clear training data* forgets what was learned (the cookies stay).

**How the cookies are kept apart.**

- They are used **only** to read three account feeds (`:ythistory`, `:ytsubs`, `:ytrec`) with yt-dlp, every `TOMTUBE_TRAINING_SYNC_HOURS` (default 6, minimum 2) with a few seconds between feeds. Playback, search and topic searches never use them; those stay unauthenticated (or use the separate throwaway `TOMTUBE_YOUTUBE_COOKIES`).
- Only youtube.com cookies are kept (Google account cookies are dropped). They are encrypted with AES-256-GCM (key from `TOMTUBE_TRAINING_KEY`, or derived from `TOMTUBE_TOKEN`) in `/var/lib/tomtube/secrets/` (folder mode 700, file mode 600, owned by the service user). For each yt-dlp run they are decrypted into a private temporary file that is deleted afterwards. As YouTube rotates them, yt-dlp's updated copy is encrypted and saved, which keeps them working longer.
- They are never logged and never sent back to the phone: the API reports only their state and dates. Error messages are scrubbed of cookie values.
- Changing them goes through the signed-in Worker and is allowed only for the Navidrome usernames in `TOMTUBE_TRAINING_USERS` in `wrangler.toml` (kept there so a deploy can't drop it). It fails closed: while it is empty nobody can add, renew, remove or sync cookies, and Settings says so. The service checks this too (`x-tomtube-owner`), and stops syncing an account's cookies once it is no longer an owner.

**One profile per account.** Each Tomify account has its own model: what it watched, skipped and marked Not interested, and (owners only) the YouTube history, subscriptions and recommendations imported with its cookies. One listener's viewing never changes another's suggestions. The Worker tells the service which account is signed in (`x-tomtube-profile`). Profiles are in `/var/lib/tomtube/training/users/<username>/log.json` (no cookies) and an owner's cookies in `/var/lib/tomtube/secrets/users/<username>.cookies`. Listeners who are not owners see their own suggestions and *Clear training data*, but no cookie controls; clearing only ever clears your own profile.

The single shared log from before profiles (`training/log.json` and `secrets/youtube-training.cookies`) is moved to the first owner who opens TomTube after the update, so nothing already learned is lost. Deploy the Worker first, then the service: until the Worker sends `x-tomtube-profile`, the new service answers recommendation requests with `400 no-profile`.

## Design decisions

- **A separate service, not part of the recovery agent.** It has its own systemd unit, port, token, limits (`MemoryMax`, `CPUQuota`, `TasksMax`, lower CPU and I/O priority) and `Restart=always`, so a busy stream can't slow Recovery, Navidrome, qBittorrent or SABnzbd, and a crash restarts only TomTube. It follows the agent's conventions (Node 20 ES modules, no npm dependencies, `node --test`, `/etc/<name>/<name>.env`, loopback + Cloudflare Tunnel + bearer token, immutable releases under `/opt/<name>/releases`).
- **systemd rather than Docker for the service**, because that is how Tomify's Node services already run and it can use the box's own yt-dlp setup. Docker is used only for the optional PO token provider, whose maintainers ship it as a container (`tomtube-service/docker-compose.pot-provider.yml`).
- **Through the existing Worker and its sign-in.** TomTube uses Tomify's Navidrome accounts, `x-tomify-*` headers for JSON and the existing short-lived media tokens (`TOMIFY_MEDIA_KEY`, `/api/media-session`) for media URLs. There is no new account system, and no public, unauthenticated relay.
- **HLS byte ranges over YouTube's own files** instead of remuxing with ffmpeg: no CPU cost, no temporary video files, exact seeking, adaptive quality, and native on iOS and AVPlayer. The cost is a dependency on YouTube's files keeping their segment index; if they ever don't, the service reports `no-segment-index` and the app falls back to the single-file formats.
- **Reuse versus Invidious/Piped.** Running Invidious or Piped would add a database, a Crystal or Java service and their own proxies, and they target desktop DASH rather than iOS HLS; public instances were ruled out. TomTube reuses the maintained piece that matters (yt-dlp, plus the PO token provider) and keeps the rest small.
- **The TomTube page is part of Tomify's build** (`tomtube/index.html`, `src/tomtube/`, like Tomifin), at `/tomtube/` with its own manifest and icon so it installs as a separate home-screen app. Tomify's service worker leaves `/tomtube/` alone; TomTube has no service worker, so it is always current.

## Upstream dependencies and limitations

- **YouTube changes often.** yt-dlp is the part that keeps up; keep it current (the `tomtube-ytdlp-update` timer does this daily). When playback stops working everywhere, update yt-dlp first.
- **JavaScript runtime.** yt-dlp needs one to solve YouTube's player challenges; without it only a few formats work. Deno is its default and recommended runtime (yt-dlp needs Node 22 or later if you use Node; the box has Node 20).
- **Proof-of-Origin (PO) tokens.** YouTube requires them for some clients and may require them more widely. TomTube supports the maintained [bgutil-ytdlp-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider) (yt-dlp's [PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide) documents it), run on the box.
- **The home connection, not the VPN.** TomTube's YouTube traffic goes out over the home (residential) internet connection, not through the box's VPN. A residential address is what YouTube expects, so bot checks ("Sign in to confirm you're not a bot") should be rare. If they do appear, add a PO token provider and/or a playback cookie file from a throwaway YouTube account (`TOMTUBE_YOUTUBE_COOKIES`, not your own account's cookies).
- **Addresses are tied to the server.** YouTube's media URLs expire after a few hours and are bound to the IP that fetched them, which is why the phone never uses them: the service fetches and renews them.
- **Not supported yet:** live streams and premieres (`live-not-supported`), age-restricted and members-only videos without a suitable cookie file, playlists and channels (open individual videos), subtitles, comments. Recommendations are covered [below](#recommendations).
- **Quality.** Up to 1080p H.264 (YouTube offers nothing higher in H.264). 1440p/4K are VP9/AV1 only.
- **Bandwidth goes through Cloudflare.** Like Tomify's own audio, video passes through the Cloudflare Tunnel and the Worker. That suits personal use; heavy video use through Cloudflare is worth keeping an eye on, and streaming straight from the box at home (as Tomify's LAN-direct audio does) is a possible follow-up.
- **iOS web-app limits.** Background audio works only from the `<audio>` element; `<video>` is paused by iOS when the phone locks. Whether a locked web app may start the next track is up to WebKit (see Test C).

## Setting up the media server

All on the Debian box, as `tom` unless `sudo` is shown.

1. **Folders.**

   ```bash
   sudo install -d -o tom -g tom -m 755 /opt/tomtube /opt/tomtube/releases /opt/tomtube/bin
   sudo install -d -o root -g tom -m 750 /opt/tomtube/secrets
   sudo install -d -o root -g root -m 755 /etc/tomtube
   ```

2. **yt-dlp and Deno.** TomTube gets its own yt-dlp binary, so updating it can't affect Recovery:

   ```bash
   curl -fL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /opt/tomtube/bin/yt-dlp
   chmod 755 /opt/tomtube/bin/yt-dlp
   curl -fsSL https://deno.land/install.sh | sudo DENO_INSTALL=/usr/local sh   # installs /usr/local/bin/deno
   /opt/tomtube/bin/yt-dlp --version && deno --version
   ```

   Daily updates: the first deploy (step 5) installs and enables the `tomtube-ytdlp-update` timer.

3. **Optional: PO token provider.** `docker compose -f tomtube-service/docker-compose.pot-provider.yml up -d` (listens on `127.0.0.1:4416` only), install the matching plugin for yt-dlp (download `bgutil-ytdlp-pot-provider.zip` from the same project's releases into `~/.config/yt-dlp/plugins/` for the user TomTube runs as; with the unit's `HOME=/var/lib/tomtube` that is `/var/lib/tomtube/.config/yt-dlp/plugins/`), and set `TOMTUBE_POT_PROVIDER_URL=http://127.0.0.1:4416`. `yt-dlp -v` lists loaded plugins.

4. **Settings.** Copy `tomtube-service/tomtube.env.example` to `/etc/tomtube/tomtube.env` (`sudo install -o tom -g tom -m 600 …`) and set `TOMTUBE_TOKEN` to a new random value (`openssl rand -base64 48`). Every other value has a sensible default. Never commit the env file or a cookie file.

5. **First release.** From a checkout: `./scripts/deploy-tomtube.sh` (or `--host user@host`). It stops before changing anything if `/etc/tomtube/tomtube.env` is missing. On the first run it also installs and enables `tomtube.service` and the daily `tomtube-ytdlp-update` timer from the release, so it asks for the sudo password. Then check:

   ```bash
   curl -s http://127.0.0.1:8790/health; echo     # {"ok":true,"version":"<sha>"}
   journalctl -u tomtube -n 20                     # "TomTube listening on http://127.0.0.1:8790 (yt-dlp 2026.…)"
   ```

   Later deploys are just `./scripts/deploy-tomtube.sh`. They leave the installed units alone (and say so if the release ships a changed `tomtube.service.example`), and ask for the sudo password to restart the service, unless you allow exactly that command: `echo 'tom ALL=(root) NOPASSWD: /usr/bin/systemctl restart tomtube' | sudo tee /etc/sudoers.d/tomtube-deploy && sudo chmod 440 /etc/sudoers.d/tomtube-deploy`. It keeps the five newest releases and puts the previous one back if the new one doesn't report healthy within 30 seconds.

6. **Tunnel.** Give the service its own public hostname on the tunnel the recovery agent already uses (`tomify-recovery-cloudflared`): in Cloudflare Zero Trust → Networks → Tunnels → that tunnel → Public Hostname → Add, for example `tomtube-service.tomdixon.uk` → `http://localhost:8790`. (If the tunnel is configured by a local `config.yml` instead, add the same ingress rule above the catch-all.) Check from anywhere: `curl -s https://tomtube-service.tomdixon.uk/health` returns `{"ok":true,…}`, and `/v1/status` without the token returns 401.

7. **Smoke test on the box:** `T=<the token>; curl -s -H "Authorization: Bearer $T" 'http://127.0.0.1:8790/v1/search?q=test' | head -c 300` returns results, and `curl -s -H "Authorization: Bearer $T" http://127.0.0.1:8790/v1/videos/<an id> | head -c 300` returns the title and `"playback":{"hls":true,…}`.

## Setting up the Worker

In the Cloudflare dashboard, tomify Worker → Settings → Variables and Secrets:

| Name | Kind | Value |
| --- | --- | --- |
| `TOMTUBE_SERVICE_URL` | Variable | The tunnel hostname, e.g. `https://tomtube-service.tomdixon.uk` |
| `TOMTUBE_SERVICE_TOKEN` | **Secret** | The same value as `TOMTUBE_TOKEN` on the box |
| `TOMTUBE_ALLOWED_USERS` | Variable (optional) | Comma-separated Navidrome usernames; unset means every Tomify listener |
| `TOMTUBE_TRAINING_USERS` | **`wrangler.toml`** var | Navidrome usernames allowed to add, renew, sync or remove YouTube account cookies for their own recommendation profile. Empty means nobody (fails closed) |
| `TOMIFY_MEDIA_KEY` | Secret (already used by Tomify) | **Required.** TomTube media URLs carry only a 4-hour media token made with this key; the Navidrome login is never accepted in a TomTube URL. Without it, TomTube's media answers `503 media-tokens-not-configured` and the app says so |

Deploy the site as usual (merge to `main`). Without the service variables, `/api/tomtube/*` answers `503 not-configured` and nothing else in Tomify changes.

## Installing TomTube on an iPhone

1. Open **Safari** (not another browser) and go to `https://app.tomify.tomdixon.uk/tomtube/`.
2. Sign in with your Tomify username and password.
3. Tap the **Share** button, then **Add to Home Screen**, keep the name **TomTube**, and tap **Add**. Check that the icon is the lime TV, not Tomify's.
4. Open TomTube **from the home-screen icon** from now on. It runs full screen and keeps its own sign-in (iOS gives each home-screen app separate storage, so you sign in once more there).
5. Make sure the ring/silent switch doesn't matter: web audio plays with the phone on silent, but check the volume.

## Manual playback test checklist

Use the home-screen app, on mobile data and on Wi-Fi. Record the iPhone model, iOS version, network and date for each result. "Pass" needs the observed behaviour, not a guess.

**Before you start:** `https://app.tomify.tomdixon.uk/api/version` shows the deployed site; on the box `curl -s http://127.0.0.1:8790/health` shows the service version; TomTube → Settings → **Check server** shows the yt-dlp version and no recent failures.

### Test A: ad-free video

1. Search for a popular music video (these normally carry pre-roll ads on YouTube). Thumbnails, titles, channels and durations show.
2. Tap one. The player opens and the video starts within a few seconds, **with no advert**, straight into the video.
3. Drag the seek bar to the middle: it continues from there within a couple of seconds. Use −10/+10.
4. Pause and play. Rotate the phone; tap full screen and back.
5. Paste a YouTube link (Share → Copy Link in the YouTube app) into the search box: that video opens.
6. Optional: in Safari on a Mac, Develop → (the iPhone) → Network shows requests only to `app.tomify.tomdixon.uk`, none to `googlevideo.com`, `youtube.com` or `doubleclick.net`.

Pass: video plays and seeks without ads on the iPhone through Tomify.

### Test B: locked-screen audio

1. Play a video, then tap **Audio only**. Audio continues from about the same position (within a few seconds); the picture is replaced by the thumbnail.
2. Lock the phone. Audio keeps playing for at least 5 minutes.
3. The lock screen shows the title, channel and thumbnail. Pause and play from the lock screen. Skip forward/back or scrub if shown.
4. With Bluetooth headphones: play/pause from the headphones; disconnect them (audio should pause) and reconnect.
5. Interruption: receive or make a call (or trigger Siri) while locked; afterwards resume from the lock screen.
6. Network: while locked, walk from Wi-Fi to mobile data. Playback continues (it may pause briefly).
7. Long video: play a 1-hour+ video in audio mode locked for 20 minutes; it doesn't stop.
8. **Lock during a video (paired playback):** with Settings → Audio stream on **Automatic** and "Keep listening when the phone locks" on, play a video in video mode for at least 10 seconds, then lock the phone without tapping **Audio only**. The sound carries on without a gap or restart. Unlock: the picture catches up with the sound within a second or two. Also check: lip sync over a few minutes, seeking from the seek bar and the full-screen player, pause/play from the full-screen player, **Audio only** and back (no gap in the sound), and a queued video starting while locked.

Pass: steps 1–3 work. Note any failure in 4–8 with what happened.

### Test C: queue progression while locked (experimental)

1. Queue two short videos (⋮ → Add to queue; 2–3 minutes each).
2. Play the first in **Audio only** mode, lock the phone, and wait without touching it.
3. When the first ends, the second starts on its own and the lock screen shows its title.
4. Repeat with Settings → **Continuous queue** on.
5. Repeat after the phone has been locked for 10+ minutes before the first track ends.

Record each method separately. If the standard method fails and the continuous one works, leave continuous on. If both fail, iOS is preventing progression for web apps on that version: that is the limitation to document, and the native client is the fix.

## Diagnostics and troubleshooting

- **Settings → Check server** in the app, or `GET /api/tomtube/status` (signed in) or the service's `/v1/status` (token): yt-dlp version, running/queued yt-dlp jobs, active streams, cache size, and the last 50 failures with codes.
- `journalctl -u tomtube -f` on the box: one line per yt-dlp failure with its code. Media URLs, signatures, PO tokens, cookies and paths are removed from messages.
- Error codes the app may show: `bot-check` (add a PO token provider or cookies), `rate-limited`, `age-restricted`, `private`, `members-only`, `unavailable`, `geo-blocked`, `live-not-supported`, `no-compatible-format`, `no-segment-index`, `upstream-expired` (YouTube refused a renewed address), `ytdlp-missing`, `timeout`, `busy` (too many streams or yt-dlp jobs), `not-configured` (Worker variables missing), `media-tokens-not-configured` (no `TOMIFY_MEDIA_KEY` on the Worker), `tomtube-unavailable` (tunnel or service down).
- Everything fails: update yt-dlp (`/opt/tomtube/bin/yt-dlp -U`), check `deno --version`, then try `/opt/tomtube/bin/yt-dlp -v -F <url>` as `tom` to see what YouTube returns.
- Video won't start but audio works: Settings → Video quality → **Compatible** (360p single file). Audio won't start or stops when the phone locks: Settings → Audio stream → **Single file** (already the automatic choice on iPhone and iPad). Please note which, so the default can be changed.

## Service API

All under `/v1/` need `Authorization: Bearer $TOMTUBE_TOKEN`; the Worker exposes the same paths under `/api/tomtube/` to signed-in listeners. Video ids are 11 characters; nothing takes an arbitrary URL except `resolve`, which accepts only YouTube video links.

| Path | Returns |
| --- | --- |
| `GET /health` | `{ ok, version }`, no token |
| `GET /v1/status` | Diagnostics |
| `GET /v1/search?q=` | `{ results: [{ id, title, channel, duration, viewCount, isLive }] }` |
| `GET /v1/resolve?url=` | Video details for a pasted YouTube link |
| `GET /v1/videos/<id>` | Title, channel, duration, formats (never their URLs), `playback: { hls, progressive, audio }` |
| `GET /v1/videos/<id>/master.m3u8` | HLS: H.264 variants + AAC |
| `GET /v1/videos/<id>/audio.m3u8` | HLS: AAC only (starts the audio cache) |
| `GET /v1/videos/<id>/v<itag>.m3u8`, `a<itag>.m3u8` | One stream's media playlist |
| `GET /v1/videos/<id>/<itag>.mp4`, `<itag>.m4a`, `progressive.mp4`, `audio.m4a` | Bytes, with `Range` |
| `POST /v1/videos/<id>/prefetch` | Downloads the audio to the cache in the background |
| `GET /v1/queue.m3u8?ids=a,b`, `queue.json?ids=a,b` | Continuous audio stream of up to 20 videos, and each one's offset |
| `GET /v1/thumbs/<id>/<mqdefault\|hqdefault\|maxresdefault\|…>.jpg` | Thumbnail |
| Recommendation paths below | Per account: `x-tomtube-profile: <username>` (URI-encoded) is required, and `x-tomtube-owner: 1` is required for the cookie and sync paths |
| `GET /v1/recommendations[?refresh=1]` | `{ source, cookies, topics, shelves: [{ id, title, videos: [{ …video, reason }] }] }` |
| `POST /v1/watched` | The app reports a watch: `{ id, title, channel, channelId, duration, seconds, ended, skipped }` |
| `POST /v1/feedback` | `{ id, kind: "not-interested", channelId }` |
| `GET /v1/training`, `DELETE /v1/training` | Cookie state and what has been learned (never the cookies); DELETE forgets what this account learned; `youtubeAccount` says whether it may add cookies |
| `PUT /v1/training/cookies`, `DELETE …` | A new cookies.txt as the body (max 256 KB), checked in the background; DELETE removes it |
| `POST /v1/training/sync` | Read the account feeds now (at most every 15 minutes) |
| `GET /v1/training/imports` | The last five syncs' import reports and the problems found (owner only through the Worker) |

## Security

- The service listens on loopback and refuses to start without a token of at least 32 characters. Only the Worker, through the tunnel, can reach it.
- The Worker requires a valid Tomify sign-in for every TomTube path (headers for JSON; for media, only a short-lived media token: the Navidrome login is never put in or accepted from a TomTube URL, so it can't appear in Cloudflare, proxy or browser logs), optionally limited to `TOMTUBE_ALLOWED_USERS`, and passes on only a fixed list of paths and query parameters.
- No arbitrary URL is ever fetched: clients send video ids; yt-dlp gets a URL built from the id; the proxy fetches only `https://*.googlevideo.com` (checked again on every redirect) and thumbnails only from `https://i.ytimg.com/vi/<id>/<fixed name>.jpg`. YouTube's URLs and request headers never reach the phone, and cookies are never forwarded upstream.
- yt-dlp runs without a shell, with `--ignore-config`, a timeout, an output cap and a concurrency limit. A cookie file is copied privately for each run and deleted.
- Secrets live only in `/etc/tomtube/tomtube.env`, `/opt/tomtube/secrets` and the Worker's secrets. Logs and error messages strip media URLs, signatures, PO tokens, cookies and paths.
- The recommendation cookies are separate from playback, encrypted at rest, used only for three account feeds a few times a day, and never logged or returned (see [Recommendations](#recommendations)).
- Disk use is bounded by `TOMTUBE_CACHE_MAX_BYTES`, `TOMTUBE_CACHE_MAX_AGE_HOURS` and `TOMTUBE_CACHE_MAX_FILE_BYTES`; partial downloads are removed at start-up and by the sweep every 10 minutes. Video is never written to disk.

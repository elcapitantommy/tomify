# TomTube

TomTube is Tomify's own YouTube player: ad-free videos and background audio on an iPhone, served entirely from the Tomify server. It is a home-screen web app at `https://app.tomify.tomdixon.uk/tomtube/`, with a small service on the media server that does the YouTube side.

- [Status: what is verified and what is not](#status)
- [How it works](#how-it-works)
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

**Playback formats.** iPhones play H.264 video and AAC audio natively. YouTube offers both as separate "adaptive" fragmented MP4 files (H.264 up to 1080p; AAC at 128 kbps), each starting with a segment index. TomTube reads that index (the first few kilobytes) and describes each file to Safari as an HLS playlist of byte ranges (`EXT-X-MAP`, `EXT-X-BYTERANGE`). Safari then picks the quality, buffers and seeks by itself, fetching exact byte ranges that the service streams from YouTube. A 360p single-file MP4 (YouTube's format 18) is the fallback, and audio is also available as one `.m4a` file. VP9, AV1, Opus and WebM are never offered, because iOS Safari cannot play them in HLS. Nothing is transcoded, and ffmpeg is not used at all.

**Video playback (Test A).** The app plays `/api/tomtube/videos/<id>/master.m3u8` in a `<video>` element. Because TomTube fetches the media streams itself, none of YouTube's player, ad requests or ad breaks are involved.

**Audio mode (Test B).** Tapping **Audio only** notes the position, pauses and empties the `<video>` element (it does not keep running in the background), loads `audio.m3u8` into a separate `<audio>` element and starts it at the same position. When the service is asked for an audio playlist it also downloads that video's audio (a few MB) to its disk cache, so a locked phone keeps playing even if YouTube's address expires or YouTube is slow. The Media Session API supplies the lock-screen title, channel, artwork, play/pause, next/previous and seeking, which headphones, Bluetooth and CarPlay-style controls use too. Interruptions (calls, Siri) pause, and the lock-screen play button resumes. A stalled or failed stream is reloaded from where it stopped (1, 3, 6, 10, 15 seconds), and an HLS stream that fails twice falls back to the single `.m4a` file.

**Locking during a video.** With **Keep listening when the phone locks** on (the default), TomTube switches to audio by itself when it goes to the background during a video, and back to video when you return. iOS may refuse to start audio without a tap at that moment; TomTube then stays ready, and the lock screen's play button starts it.

**Queue progression (Test C, experimental).** Two mechanisms are implemented:

1. **Standard.** When a video ends, the next one's URL is built locally and set and played on the same `<audio>` element synchronously inside the `ended` event, with no network request or `await` in between. The server has already downloaded the next video's audio while the phone was awake. iOS allows a page that is playing audio to change source like this; whether it still does once the page has been locked for a while is exactly what Test C checks.
2. **Continuous queue** (Settings, off by default). In audio mode TomTube plays the current video and the next 19 queued ones as **one** HLS stream from the server (`/api/tomtube/queue.m3u8`), each video a discontinuity with its own initialisation section. Nothing has to start between tracks, so iOS has nothing to refuse. The app follows which video is playing from the stream position and updates the lock screen. If the standard way fails on a locked phone, try this one.

If neither works reliably on iOS, that is a WebKit limitation of web apps, and the answer is a small native client (below).

**A future native client.** The service's API is plain HTTP with HLS and byte ranges, which is what AVPlayer wants. A native iOS app could use the same Worker paths (or the same service through its own token) with `AVPlayer` and `AVAudioSession` in `.playback` mode and `MPNowPlayingInfoCenter`, which removes every web-app limitation above. The same applies to an LG webOS client or TOMMICH: they need only the JSON API and the HLS URLs.

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
- **The box's VPN.** The box sends outbound traffic through NordVPN, so TomTube's YouTube traffic does too. YouTube often treats VPN addresses as bots ("Sign in to confirm you're not a bot"). If that happens, add a PO token provider and/or a cookie file from a throwaway YouTube account; there is no per-process VPN bypass in the NordVPN Linux client.
- **Addresses are tied to the server.** YouTube's media URLs expire after a few hours and are bound to the IP that fetched them, which is why the phone never uses them: the service fetches and renews them.
- **Not supported yet:** live streams and premieres (`live-not-supported`), age-restricted and members-only videos without a suitable cookie file, playlists and channels (open individual videos), subtitles, comments, subscriptions, recommendations.
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

   Daily updates: `sudo cp tomtube-service/tomtube-ytdlp-update.service.example /etc/systemd/system/tomtube-ytdlp-update.service`, the same for the `.timer`, then `sudo systemctl daemon-reload && sudo systemctl enable --now tomtube-ytdlp-update.timer`.

3. **Optional: PO token provider.** `docker compose -f tomtube-service/docker-compose.pot-provider.yml up -d` (listens on `127.0.0.1:4416` only), install the matching plugin for yt-dlp (download `bgutil-ytdlp-pot-provider.zip` from the same project's releases into `~/.config/yt-dlp/plugins/` for the user TomTube runs as; with the unit's `HOME=/var/lib/tomtube` that is `/var/lib/tomtube/.config/yt-dlp/plugins/`), and set `TOMTUBE_POT_PROVIDER_URL=http://127.0.0.1:4416`. `yt-dlp -v` lists loaded plugins.

4. **Settings.** Copy `tomtube-service/tomtube.env.example` to `/etc/tomtube/tomtube.env` (`sudo install -o tom -g tom -m 600 …`) and set `TOMTUBE_TOKEN` to a new random value (`openssl rand -base64 48`). Every other value has a sensible default. Never commit the env file or a cookie file.

5. **First release.** From a checkout: `./scripts/deploy-tomtube.sh` (or `--host user@host`). Then install the unit once:

   ```bash
   sudo cp /opt/tomtube/current/tomtube-service/tomtube.service.example /etc/systemd/system/tomtube.service
   sudo systemctl daemon-reload && sudo systemctl enable --now tomtube
   curl -s http://127.0.0.1:8790/health; echo     # {"ok":true,"version":"<sha>"}
   journalctl -u tomtube -n 20                     # "TomTube listening on http://127.0.0.1:8790 (yt-dlp 2026.…)"
   ```

   Later deploys are just `./scripts/deploy-tomtube.sh`; it asks for the sudo password to restart the service, unless you allow exactly that command: `echo 'tom ALL=(root) NOPASSWD: /usr/bin/systemctl restart tomtube' | sudo tee /etc/sudoers.d/tomtube-deploy && sudo chmod 440 /etc/sudoers.d/tomtube-deploy`. It keeps the five newest releases and puts the previous one back if the new one doesn't report healthy within 30 seconds.

6. **Tunnel.** Give the service its own public hostname on the tunnel the recovery agent already uses (`tomify-recovery-cloudflared`): in Cloudflare Zero Trust → Networks → Tunnels → that tunnel → Public Hostname → Add, for example `tomtube-service.tomdixon.uk` → `http://localhost:8790`. (If the tunnel is configured by a local `config.yml` instead, add the same ingress rule above the catch-all.) Check from anywhere: `curl -s https://tomtube-service.tomdixon.uk/health` returns `{"ok":true,…}`, and `/v1/status` without the token returns 401.

7. **Smoke test on the box:** `T=<the token>; curl -s -H "Authorization: Bearer $T" 'http://127.0.0.1:8790/v1/search?q=test' | head -c 300` returns results, and `curl -s -H "Authorization: Bearer $T" http://127.0.0.1:8790/v1/videos/<an id> | head -c 300` returns the title and `"playback":{"hls":true,…}`.

## Setting up the Worker

In the Cloudflare dashboard, tomify Worker → Settings → Variables and Secrets:

| Name | Kind | Value |
| --- | --- | --- |
| `TOMTUBE_SERVICE_URL` | Variable | The tunnel hostname, e.g. `https://tomtube-service.tomdixon.uk` |
| `TOMTUBE_SERVICE_TOKEN` | **Secret** | The same value as `TOMTUBE_TOKEN` on the box |
| `TOMTUBE_ALLOWED_USERS` | Variable (optional) | Comma-separated Navidrome usernames; unset means every Tomify listener |
| `TOMIFY_MEDIA_KEY` | Secret (already used by Tomify) | Recommended: media URLs then carry a 4-hour token instead of the Navidrome login |

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
8. **Auto switch:** play a video (video mode), then lock the phone. With "Keep listening when the phone locks" on, audio continues (or the lock screen play button starts it). Unlock: the video is back at the current position.

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
- Error codes the app may show: `bot-check` (add a PO token provider or cookies), `rate-limited`, `age-restricted`, `private`, `members-only`, `unavailable`, `geo-blocked`, `live-not-supported`, `no-compatible-format`, `no-segment-index`, `upstream-expired` (YouTube refused a renewed address), `ytdlp-missing`, `timeout`, `busy` (too many streams or yt-dlp jobs), `not-configured` (Worker variables missing), `tomtube-unavailable` (tunnel or service down).
- Everything fails: update yt-dlp (`/opt/tomtube/bin/yt-dlp -U`), check `deno --version`, then try `/opt/tomtube/bin/yt-dlp -v -F <url>` as `tom` to see what YouTube returns.
- Video won't start but audio works: Settings → Video quality → **Compatible** (360p single file). Audio won't start: Settings → Audio stream → **Single file**. Please note which, so the default can be changed.

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

## Security

- The service listens on loopback and refuses to start without a token of at least 32 characters. Only the Worker, through the tunnel, can reach it.
- The Worker requires a valid Tomify sign-in for every TomTube path (headers for JSON; a media token or the Navidrome token for media), optionally limited to `TOMTUBE_ALLOWED_USERS`, and passes on only a fixed list of paths and query parameters.
- No arbitrary URL is ever fetched: clients send video ids; yt-dlp gets a URL built from the id; the proxy fetches only `https://*.googlevideo.com` (checked again on every redirect) and thumbnails only from `https://i.ytimg.com/vi/<id>/<fixed name>.jpg`. YouTube's URLs and request headers never reach the phone, and cookies are never forwarded upstream.
- yt-dlp runs without a shell, with `--ignore-config`, a timeout, an output cap and a concurrency limit. A cookie file is copied privately for each run and deleted.
- Secrets live only in `/etc/tomtube/tomtube.env`, `/opt/tomtube/secrets` and the Worker's secrets. Logs and error messages strip media URLs, signatures, PO tokens, cookies and paths.
- Disk use is bounded by `TOMTUBE_CACHE_MAX_BYTES`, `TOMTUBE_CACHE_MAX_AGE_HOURS` and `TOMTUBE_CACHE_MAX_FILE_BYTES`; partial downloads are removed at start-up and by the sweep every 10 minutes. Video is never written to disk.

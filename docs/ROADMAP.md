# Tomify Roadmap

This roadmap is deliberately staged so Tomify becomes useful early and remains usable while the custom client is being built.

## Phase 0 — Decisions and hardware

**Goal:** remove unknowns before ripping a large collection.

- [ ] Choose the small Linux host.
- [ ] Choose primary music storage.
- [ ] Choose backup target.
- [ ] Confirm optical drive/ripping workstation.
- [ ] Decide initial remote-access method.
- [ ] Decide the initial public/private hostname strategy.
- [ ] Select a small representative test set of CDs:
  - normal album
  - compilation
  - multi-disc album
  - album with awkward metadata/artwork
- [ ] Agree naming/tagging conventions.

### Exit criteria

We know where the masters live, how they are backed up, and how albums are tagged before bulk ripping starts.

---

## Phase 1 — Ripping proof of concept

**Goal:** prove the master-library workflow.

- [ ] Configure secure CD ripping.
- [ ] Rip test albums to FLAC.
- [ ] Verify metadata and artwork.
- [ ] Establish compilation handling.
- [ ] Establish multi-disc handling.
- [ ] Copy completed rips to the server library.
- [ ] Back up the test library.
- [ ] Delete/restore at least one test album to prove recovery.

### Exit criteria

A CD can go from shelf to correctly tagged FLAC on the server and be restored from backup.

---

## Phase 2 — Navidrome MVP

**Goal:** replace the basic Spotify use case as quickly as possible.

- [ ] Install Docker/Compose on the server.
- [ ] Deploy Navidrome.
- [ ] Mount the music library read-only.
- [ ] Create Tom account.
- [ ] Create Anna account.
- [ ] Verify library scanning.
- [ ] Test browser playback on desktop.
- [ ] Test browser playback on both phones.
- [ ] Configure HTTPS/private remote access.
- [ ] Test playback away from home.
- [ ] Configure initial transcoding profiles.
- [ ] Back up Navidrome application data.

### Exit criteria

Tom and Anna can independently sign in and stream the home FLAC library both locally and remotely.

At this point **Tomify is already useful**, even before its own UI exists.

---

## Phase 3 — Tomify PWA shell

**Goal:** establish the custom client without attempting every feature.

- [ ] Select front-end stack.
- [ ] Create responsive app shell.
- [ ] Add PWA manifest/icons.
- [ ] Add installable home-screen experience.
- [ ] Implement authentication.
- [ ] Connect to Navidrome/OpenSubsonic.
- [ ] Build navigation:
  - Home
  - Artists
  - Albums
  - Playlists
  - Favourites
  - Downloads
  - Search
  - Settings
- [ ] Add basic offline app-shell caching.
- [ ] Add clear server/connection state.

### Exit criteria

The PWA installs and can authenticate and browse the live library.

---

## Phase 4 — Streaming player

**Goal:** make Tomify a credible everyday player.

- [ ] Track playback.
- [ ] Persistent mini-player.
- [ ] Full now-playing screen.
- [ ] Queue.
- [ ] Previous/next.
- [ ] Seek.
- [ ] Shuffle.
- [ ] Repeat.
- [ ] Artwork.
- [ ] Favourites.
- [ ] Playlist playback.
- [ ] Search.
- [ ] Media Session API integration.
- [ ] Test headset/lock-screen controls on target phones.
- [ ] Handle lost/recovered network cleanly.

### Exit criteria

Tomify can replace the Navidrome web UI for normal online listening.

---

## Phase 5 — Offline downloads

**Goal:** make selected music work with no connection.

### Track downloads

- [ ] Download one track.
- [ ] Store metadata locally.
- [ ] Store artwork locally.
- [ ] Store audio locally.
- [ ] Play local copy transparently.
- [ ] Remove download without touching server copy.

### Album downloads

- [ ] Download complete album.
- [ ] Show aggregate progress.
- [ ] Resume/retry failed tracks.
- [ ] Remove album download.

### Playlist downloads

- [ ] Download complete playlist.
- [ ] Handle duplicate tracks efficiently.
- [ ] Maintain playlist order.
- [ ] Remove playlist while retaining tracks still required by other downloads.

### Offline experience

- [ ] Downloads screen.
- [ ] Offline-only browsing.
- [ ] Clear download status.
- [ ] Storage usage display.
- [ ] Available storage information where platform APIs allow it.
- [ ] Graceful behaviour when server cannot be contacted.
- [ ] Test after force-closing/reopening app with no network.
- [ ] Test after phone reboot where practical.

### Quality

- [ ] Original quality.
- [ ] High-quality transcode.
- [ ] Normal-quality transcode.
- [ ] Space-saver transcode.
- [ ] Per-user default.
- [ ] Optionally override quality for an individual download.

### Exit criteria

Tom and Anna can deliberately take albums/playlists offline and reliably play them with airplane mode enabled.

---

## Phase 6 — Offline sync

**Goal:** make downloads feel like a streaming service rather than manually copied files.

- [ ] “Keep downloaded” option for playlists.
- [ ] Detect additions/removals.
- [ ] Queue missing tracks.
- [ ] Remove obsolete copies only when not used elsewhere.
- [ ] Wi-Fi-only sync option.
- [ ] Optional charging-only sync if platform behaviour makes this practical.
- [ ] Display last successful sync.
- [ ] Safe handling when background execution is restricted by the OS/browser.

### Exit criteria

A maintained playlist can stay locally synchronised with minimal user effort.

---

## Phase 7 — Library polish

**Goal:** make a large ripped collection pleasant to live with.

- [ ] Recently added.
- [ ] Recently played.
- [ ] Better album/artist pages.
- [ ] Disc-aware album presentation.
- [ ] Compilation handling.
- [ ] Sort/filter options.
- [ ] Genre browsing if useful.
- [ ] Ratings.
- [ ] ReplayGain support/behaviour.
- [ ] Better artwork management.
- [ ] Duplicate detection/reporting.
- [ ] Missing/bad metadata report.

---

## Phase 8 — Ripping/ingest automation

**Goal:** reduce the pain of adding the rest of the CD collection.

Possible workflow:

```text
insert CD
   ↓
rip securely
   ↓
identify release
   ↓
fetch tags/artwork
   ↓
human review
   ↓
write FLAC/tags
   ↓
copy to staging
   ↓
validate
   ↓
move into library
   ↓
server rescan
   ↓
backup
```

Potential features:

- [ ] Rip queue.
- [ ] Accurate-rip verification status.
- [ ] MusicBrainz release matching.
- [ ] Artwork preview/selection.
- [ ] Naming preview.
- [ ] Duplicate-release warning.
- [ ] One-click import after review.
- [ ] Post-import backup trigger/report.

Human review should remain in the loop for ambiguous releases.

---

## Phase 9 — Family features

**Goal:** lean into Tomify being for a household rather than a generic music server.

- [ ] Shared playlists.
- [ ] “Playing now” presence.
- [ ] Family favourites.
- [ ] Optional shared queue.
- [ ] Listening statistics.
- [ ] Per-user theme/preferences.
- [ ] Easy switching on shared household screens.

---

## Phase 10 — Nice-to-have integrations

Investigate only after the core experience is boringly reliable:

- [ ] Chromecast.
- [ ] AirPlay.
- [ ] Sonos.
- [ ] Home Assistant.
- [ ] Android Auto.
- [ ] CarPlay.
- [ ] Smart speakers.
- [ ] Lyrics.
- [ ] Artist/album biographies.
- [ ] Smart playlists.
- [ ] Recommendations based only on our own listening/library data.

---

## Definition of done for v1

Tomify v1 is complete when:

1. The full CD library can be stored as backed-up FLAC masters.
2. Tom and Anna have separate accounts.
3. Both can stream securely at home and remotely.
4. The Tomify PWA installs on their phones.
5. Core browse/search/queue/playback is reliable.
6. Selected tracks, albums and playlists can be downloaded.
7. Downloaded music works reliably with no network.
8. Offline storage can be inspected and cleaned up by the user.
9. A failed Tomify release does not prevent fallback playback through Navidrome.
10. A failed server disk does not mean re-ripping the CD collection.

## Things we are explicitly not doing first

These are deliberately postponed rather than forgotten:

- Writing our own music backend.
- Native apps before PWA limitations are demonstrated.
- Recommendation AI.
- Social/public sharing.
- DRM.
- Complex multi-household tenancy.
- Fancy ingest automation before the ripping conventions are proven.

The order is intentional: **protect the music first, get playback working second, make it beautiful third.**

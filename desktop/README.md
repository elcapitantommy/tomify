# Tomify for Windows

A small [Tauri](https://tauri.app) app that shows the hosted Tomify site (https://app.tomify.tomdixon.uk) in its own window: no address bar or tabs, its own taskbar icon and Start menu entry, and starting it again brings the open window forward instead of a second player. It uses the Edge WebView2 engine that ships with Windows 10 and 11.

The app is still the website. Every Tomify deploy reaches it the next time it loads, so the app only needs reinstalling when something in this folder changes.

## Getting the installer

GitHub Actions builds it (`.github/workflows/desktop.yml`) whenever `desktop/` changes on `main` or in a pull request, and on demand: **Actions → Windows app → Run workflow**. Open the finished run and download **Tomify-windows-installer** from its Artifacts section. Inside are:

- `Tomify_<version>_x64-setup.exe`: recommended. Installs for your user only, no admin prompt.
- `Tomify_<version>_x64_en-US.msi`: the same app as a Windows Installer package.

The installers are not code-signed, so Windows SmartScreen says "Windows protected your PC" the first time: choose **More info → Run anyway**.

Sign in once in the app: it keeps its own sign-in, downloads and settings, separate from Edge or Chrome.

## What is different from the browser

- **Mini player.** The pop-out button in the player bar shrinks the app's own window to the mini player, always on top. The first time it sits at the bottom right of the screen; after that it opens wherever you last left it, even after closing and restarting the app (saved in `mini-player-position.txt` in the app's settings folder, `%APPDATA%\uk.tomdixon.tomify`). If that screen has been unplugged or the spot is partly off screen, it moves just far enough to be fully on the nearest screen. Drag it by anything that isn't a control; the expand button (top right) puts the full window back where it was. Reloading Tomify also puts it back. The mini player is a fixed size, so only its position is remembered.
- **Media keys.** The app turns on Chromium's hardware media key handling, so the keyboard's play/pause, next and previous keys and the Windows media overlay drive Tomify's Media Session controls.
- **Links to other sites** (MusicBrainz, Radio Browser) open in your normal browser.
- **What the site can ask the app to do** is limited to switching the mini player on and off and dragging it (`src-tauri/capabilities/tomify-site.json`), and only from https://app.tomify.tomdixon.uk.

Things the WebView2 engine doesn't do, so they stay browser-only: Web Push notifications, and casting with AirPlay or Chromecast.

## Building it yourself

On Windows with [Rust](https://rustup.rs) and Node.js 22:

```powershell
cd desktop
npx --yes @tauri-apps/cli@2.12.4 build
```

The installers land in `desktop/src-tauri/target/release/bundle/`. `npx --yes @tauri-apps/cli@2.12.4 dev` runs it without installing. `cargo test` in `desktop/src-tauri` runs the Rust tests; `scripts/desktop-app.node-test.mjs` (part of `pnpm test`) checks the app's settings agree with each other and with the site.

## Files

- `src-tauri/src/main.rs`: the window, the mini player commands, single instance and opening other sites in the browser.
- `src-tauri/src/mini_spot.rs`: where the mini player opens (the remembered spot, kept on a connected screen) and its saved file format; plain Rust with its own tests.
- `src-tauri/tauri.conf.json`: name, version and installer settings. Bump `version` here and in `Cargo.toml` together.
- `icon.svg`: the app icon source, the rounded yellow tile (same shape and colour as `public/pwa-512x512.png`) with the skull and crossbones from `public/favicon.svg`. The PWA keeps its own T icon.
- `src-tauri/icons/`: made from `icon.svg` with `npx @tauri-apps/cli@2.12.4 icon icon.svg -o <temp folder>`, then copying `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.ico` and `icon.png` in (the other sizes it makes are for platforms this app doesn't ship).
- `offline/index.html`: required by Tauri's build; the app never shows it, because the window opens the site directly.
- The site side is `src/lib/desktop-app.ts` and the `compact` mode in `src/stores/miniPlayer.ts`.

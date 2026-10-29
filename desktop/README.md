# Tomify for Windows

A small [Tauri](https://tauri.app) app that shows the hosted Tomify site (https://app.tomify.tomdixon.uk) in its own window: no address bar or tabs, its own taskbar icon and Start menu entry, and starting it again brings the open window forward instead of a second player. It uses the Edge WebView2 engine that ships with Windows 10 and 11.

The app is still the website. Every Tomify deploy reaches it the next time it loads. Changes to the app itself (this folder) reach it through its own updater: see [Automatic updates](#automatic-updates).

## Getting the installer

Each released version is on the repository's [Releases page](https://github.com/elcapitantommy/tomify/releases) (tags `desktop-v<version>`): download `Tomify_<version>_x64-setup.exe` there. Once installed, the app updates itself.

GitHub Actions also builds it (`.github/workflows/desktop.yml`) whenever `desktop/` changes on `main` or in a pull request, and on demand: **Actions → Windows app → Run workflow**. Open the finished run and download **Tomify-windows-installer** from its Artifacts section. Inside are:

- `Tomify_<version>_x64-setup.exe`: recommended. Installs for your user only, no admin prompt.
- `Tomify_<version>_x64_en-US.msi`: the same app as a Windows Installer package.

The installers are not code-signed, so Windows SmartScreen says "Windows protected your PC" the first time: choose **More info → Run anyway**. (They are signed for the app's own updater, which is a different thing: it proves an update came from this repository's builds, but Windows doesn't know that key.)

Sign in once in the app: it keeps its own sign-in, downloads and settings, separate from Edge or Chrome.

## What is different from the browser

- **Mini player.** The pop-out button in the player bar shrinks the app's own window to the mini player, always on top. The first time it sits at the bottom right of the screen; after that it opens wherever you last left it, even after closing and restarting the app (saved in `mini-player-position.txt` in the app's settings folder, `%APPDATA%\uk.tomdixon.tomify`). If that screen has been unplugged or the spot is partly off screen, it moves just far enough to be fully on the nearest screen. Drag it by anything that isn't a control; the expand button (top right) puts the full window back where it was. Reloading Tomify also puts it back. The mini player is a fixed size, so only its position is remembered.
- **Media keys.** The app turns on Chromium's hardware media key handling, so the keyboard's play/pause, next and previous keys and the Windows media overlay drive Tomify's Media Session controls.
- **Links to other sites** (MusicBrainz, Radio Browser) open in your normal browser.
- **What the site can ask the app to do** is limited to switching the mini player on and off and dragging it (`src-tauri/capabilities/tomify-site.json`), and only from https://app.tomify.tomdixon.uk.

Things the WebView2 engine doesn't do, so they stay browser-only: Web Push notifications, and casting with AirPlay or Chromecast.

## Automatic updates

The app looks for a new version of itself 15 seconds after it starts and then every 6 hours while it stays open. When there is one it asks **Update Tomify: Update now / Later**. Update now downloads the new installer, closes Tomify for a few seconds while it installs (a small progress window, no questions) and opens it again; sign-in, downloads and settings are kept. Later asks again the next time Tomify starts. The check runs in the app's Rust code (`src-tauri/src/updates.rs`) with Tauri's updater plugin, so the website gets no updater permissions.

Where updates come from: the **Windows app** workflow on `main` publishes each new version as a GitHub release `desktop-v<version>` with the signed `.exe` and `.msi`, their `.sig` signatures and `latest.json` (made by `scripts/desktop-update-manifest.mjs`). The app reads https://github.com/elcapitantommy/tomify/releases/latest/download/latest.json and installs only an installer whose signature matches the public key built into it. A version is released once, so **to ship an app update, bump `version` in `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`** and merge; changes merged without a version bump are built but not offered. Changes to the website don't need any of this.

Builds made without the signing key (on your own PC, or before the secrets below exist) never look for updates. **Version 0.1.2 and older have no updater, so install the first signed version (0.1.3 or later) by hand once**, from the Releases page; every version after that arrives by itself.

### One-time setup: the updater signing key

The private key signs updates and lives only in GitHub's secrets and your own backup; never commit it. On your PC (PowerShell):

1. `npx --yes @tauri-apps/cli@2.12.4 signer generate -w $HOME\.tauri\tomify-updater.key` and choose a password. This writes `tomify-updater.key` (private) and `tomify-updater.key.pub` (public).
2. In GitHub: **Settings → Secrets and variables → Actions**.
   - **Secrets** tab, **New repository secret**: `TAURI_SIGNING_PRIVATE_KEY` = the whole contents of `tomify-updater.key` (`Get-Content $HOME\.tauri\tomify-updater.key -Raw | Set-Clipboard`), and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` = the password.
   - **Variables** tab, **New repository variable**: `TAURI_UPDATER_PUBLIC_KEY` = the contents of `tomify-updater.key.pub`.
3. Back up `tomify-updater.key` and its password somewhere safe (a password manager). If they are lost, installed apps can't take updates signed with a new key: you would make a new key, update the three settings, and install the next version by hand once.

With those set, every build of the workflow is signed (a build without them shows a warning and isn't released). Then run **Actions → Windows app → Run workflow** on `main` (or merge a version bump) to publish the release, and install it by hand from the Releases page once.

## Building it yourself

On Windows with [Rust](https://rustup.rs) and Node.js 22:

```powershell
cd desktop
npx --yes @tauri-apps/cli@2.12.4 build
```

The installers land in `desktop/src-tauri/target/release/bundle/`. A build made like this doesn't have the updater's public key, so it never checks for updates. `npx --yes @tauri-apps/cli@2.12.4 dev` runs it without installing. `cargo test` in `desktop/src-tauri` runs the Rust tests; `scripts/desktop-app.node-test.mjs` (part of `pnpm test`) checks the app's settings agree with each other and with the site.

## Files

- `src-tauri/src/main.rs`: the window, the mini player commands, single instance, opening other sites in the browser and starting the update checks.
- `src-tauri/src/updates.rs`: the update check (on start and every 6 hours), the Update now / Later question and installing; only in builds with the updater's public key.
- `src-tauri/src/mini_spot.rs`: where the mini player opens (the remembered spot, kept on a connected screen) and its saved file format; plain Rust with its own tests.
- `src-tauri/tauri.conf.json`: name, version, installer and updater settings (where `latest.json` is; the public key is added by the workflow). Bump `version` here and in `Cargo.toml` together; that is what releases an update.
- `../scripts/desktop-update-manifest.mjs`: writes `latest.json` for a release from the signed installers.
- `icon.svg`: the app icon source, the rounded yellow tile (same shape and colour as `public/pwa-512x512.png`) with the skull and crossbones from `public/favicon.svg`. The PWA keeps its own T icon.
- `src-tauri/icons/`: made from `icon.svg` with `npx @tauri-apps/cli@2.12.4 icon icon.svg -o <temp folder>`, then copying `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.ico` and `icon.png` in (the other sizes it makes are for platforms this app doesn't ship).
- `offline/index.html`: required by Tauri's build; the app never shows it, because the window opens the site directly.
- The site side is `src/lib/desktop-app.ts` and the `compact` mode in `src/stores/miniPlayer.ts`.

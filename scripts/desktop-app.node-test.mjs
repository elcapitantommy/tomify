import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { releaseTag, repository, signedInstaller, updateManifest, versionFromInstaller } from './desktop-update-manifest.mjs'

// Tomify for Windows (desktop/) has its settings spread over Rust, JSON and the site; these keep them in step.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const main = read('desktop/src-tauri/src/main.rs')
const build = read('desktop/src-tauri/build.rs')
const conf = JSON.parse(read('desktop/src-tauri/tauri.conf.json'))
const capability = JSON.parse(read('desktop/src-tauri/capabilities/tomify-site.json'))
const cargo = read('desktop/src-tauri/Cargo.toml')
const appUrl = main.match(/const APP_URL: &str = "([^"]+)"/)[1]

test('the app opens the hosted site, and only that site can use the app', () => {
  assert.equal(appUrl, 'https://app.tomify.tomdixon.uk/')
  assert.deepEqual(capability.remote.urls, [`${appUrl}*`])
  assert.equal(capability.local, false)
  assert.deepEqual(capability.windows, ['main'])
  assert.match(main, /WebviewWindowBuilder::new\(app, "main"/)
})

test('the mini player commands are declared, registered, granted and the ones the site calls', () => {
  const declared = JSON.parse(build.match(/commands\((&\[[^\]]*\])\)/)[1].slice(1))
  const registered = main.match(/generate_handler!\[([^\]]*)\]/)[1].split(',').map((name) => name.trim()).filter(Boolean)
  const granted = capability.permissions.filter((permission) => permission.startsWith('allow-')).map((permission) => permission.slice(6).replaceAll('-', '_'))
  const called = [...read('src/stores/miniPlayer.ts').matchAll(/invoke\('([a-z_]+)'\)/g)].map((match) => match[1])
  assert.deepEqual(declared.sort(), ['enter_mini_player', 'exit_mini_player'])
  assert.deepEqual(registered.sort(), declared)
  assert.deepEqual(granted.sort(), declared)
  assert.deepEqual([...new Set(called)].sort(), declared)
  // Nothing else from Tauri is open to the site except dragging the mini player.
  assert.deepEqual(capability.permissions.filter((permission) => !permission.startsWith('allow-')), ['core:window:allow-start-dragging'])
})

test('the mini player remembers where it was left, on leaving it and on closing the app', () => {
  const spot = read('desktop/src-tauri/src/mini_spot.rs')
  assert.match(main, /^mod mini_spot;/m)
  assert.match(main, /mini_spot::place\(load_mini_spot\(/)
  // Saved when the full window comes back, and when the app is closed as the mini player.
  assert.match(main.slice(main.indexOf('fn exit_mini_player')), /save_mini_spot\(/)
  assert.match(main, /WindowEvent::CloseRequested[\s\S]*save_mini_spot\(/)
  // One size for the mini player, defined beside the code that places it.
  assert.match(spot, /pub const MINI_WIDTH: f64 = 360\.0;/)
  assert.match(spot, /pub const MINI_HEIGHT: f64 = 168\.0;/)
  assert.doesNotMatch(main, /const MINI_(WIDTH|HEIGHT)/)
})

test('installer settings: version in step, icons present, Windows media keys on', () => {
  assert.equal(conf.version, cargo.match(/^version = "([^"]+)"/m)[1])
  assert.equal(conf.app.withGlobalTauri, true)
  assert.deepEqual(conf.bundle.targets.sort(), ['msi', 'nsis'])
  for (const icon of conf.bundle.icon) assert.ok(existsSync(new URL(`../desktop/src-tauri/${icon}`, import.meta.url)), icon)
  // The desktop icon is the rounded tile with the skull from the favicon, not the PWA's T.
  const iconSource = readFileSync(new URL('../desktop/icon.svg', import.meta.url), 'utf8')
  const skull = readFileSync(new URL('../public/favicon.svg', import.meta.url), 'utf8').match(/<path d="([^"]+)"/)[1]
  assert.ok(iconSource.includes(`d="${skull}"`), 'desktop/icon.svg uses the favicon skull')
  assert.match(iconSource, /<rect [^>]*rx="\d+"/)
  // Setting browser arguments replaces wry's defaults, so they must be kept.
  assert.match(main, /--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection/)
  assert.match(main, /--enable-features=HardwareMediaKeyHandling/)
})

test('the app updates itself from GitHub releases, checked from Rust with nothing opened to the site', () => {
  const updater = conf.plugins.updater
  assert.deepEqual(updater.endpoints, [`https://github.com/${repository}/releases/latest/download/latest.json`])
  // The public key comes from the build (repository variable), so a key is never committed here.
  assert.equal(updater.pubkey, '')
  assert.equal(updater.windows.installMode, 'passive')
  assert.match(cargo, /^tauri-plugin-updater = /m)
  assert.match(main, /^mod updates;/m)
  assert.match(main, /\.plugin\(tauri_plugin_updater::Builder::new\(\)\.build\(\)\)/)
  assert.match(main, /updates::start\(app\.handle\(\)\)/)
  // The site can't trigger, skip or fake an update.
  assert.ok(capability.permissions.every((permission) => !/updater|dialog/.test(permission)))
  assert.doesNotMatch(read('src/stores/miniPlayer.ts') + read('src/lib/desktop-app.ts'), /updater/)
})

test('CI signs the installers with secrets and releases each new version once, from main', () => {
  const workflow = read('.github/workflows/desktop.yml')
  assert.match(workflow, /TAURI_SIGNING_PRIVATE_KEY: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY \}\}/)
  assert.match(workflow, /TAURI_SIGNING_PRIVATE_KEY_PASSWORD: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY_PASSWORD \}\}/)
  assert.match(workflow, /vars\.TAURI_UPDATER_PUBLIC_KEY/)
  assert.match(workflow, /createUpdaterArtifacts = \$true/)
  assert.match(workflow, /\*\.exe\.sig/)
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/)
  assert.match(workflow, /tag="desktop-v\$version"/)
  assert.equal(releaseTag(conf.version), `desktop-v${conf.version}`)
  assert.match(workflow, /gh release create "\$tag"[\s\S]*bundle\/latest\.json/)
  // No private key next to the app (a Tauri key file starts with this, base64-encoded).
  const keyStart = Buffer.from('untrusted comment: rsign encrypted secret key').toString('base64').slice(0, 40)
  for (const text of [workflow, JSON.stringify(conf), main, read('desktop/src-tauri/src/updates.rs')]) {
    assert.ok(!text.includes(keyStart) && !text.includes('rsign encrypted secret key'))
  }
})

test('latest.json points each install type at its own signed installer', () => {
  const folder = mkdtempSync(join(tmpdir(), 'tomify-bundle-'))
  mkdirSync(join(folder, 'nsis'))
  mkdirSync(join(folder, 'msi'))
  writeFileSync(join(folder, 'nsis', 'Tomify_0.1.4_x64-setup.exe'), 'exe')
  writeFileSync(join(folder, 'nsis', 'Tomify_0.1.4_x64-setup.exe.sig'), 'exe-signature\n')
  writeFileSync(join(folder, 'msi', 'Tomify_0.1.4_x64_en-US.msi'), 'msi')
  writeFileSync(join(folder, 'msi', 'Tomify_0.1.4_x64_en-US.msi.sig'), 'msi-signature')
  const nsis = signedInstaller(join(folder, 'nsis'), '-setup.exe')
  const msi = signedInstaller(join(folder, 'msi'), '.msi')
  assert.equal(versionFromInstaller(nsis.name), '0.1.4')
  const manifest = updateManifest({ version: '0.1.4', tag: 'desktop-v0.1.4', nsis, msi, pubDate: '2026-10-29T10:00:00.000Z' })
  const base = `https://github.com/${repository}/releases/download/desktop-v0.1.4`
  assert.deepEqual(manifest.platforms, {
    'windows-x86_64': { signature: 'exe-signature', url: `${base}/Tomify_0.1.4_x64-setup.exe` },
    'windows-x86_64-nsis': { signature: 'exe-signature', url: `${base}/Tomify_0.1.4_x64-setup.exe` },
    'windows-x86_64-msi': { signature: 'msi-signature', url: `${base}/Tomify_0.1.4_x64_en-US.msi` },
  })
  assert.equal(manifest.version, '0.1.4')
  assert.equal(manifest.pub_date, '2026-10-29T10:00:00.000Z')
  // An unsigned installer is never published.
  assert.throws(() => updateManifest({ version: '0.1.4', tag: 'desktop-v0.1.4', nsis: { ...nsis, signature: ' ' }, msi, pubDate: '' }), /no signature/)
  writeFileSync(join(folder, 'msi', 'Tomify_0.1.4_x64_en-US.msi.sig'), '')
  assert.throws(() => updateManifest({ version: '0.1.4', tag: 'desktop-v0.1.4', nsis, msi: signedInstaller(join(folder, 'msi'), '.msi'), pubDate: '' }), /no signature/)
  assert.throws(() => versionFromInstaller('setup.exe'), /version/)
})

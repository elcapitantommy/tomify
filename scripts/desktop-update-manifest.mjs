// Writes latest.json, the file Tomify for Windows reads to find a new version (Tauri's updater format).
// Run by .github/workflows/desktop.yml after a signed build:
//   node scripts/desktop-update-manifest.mjs <bundle folder> <out file> <tag>
// The bundle folder holds nsis/ and msi/ from `tauri build` with createUpdaterArtifacts on.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repository = 'elcapitantommy/tomify'
export const releaseTag = (version) => `desktop-v${version}`

// Each installer type updates itself: an .exe install takes the .exe, an .msi install the .msi.
// The plain windows-x86_64 entry is for installs that don't say which they are.
export function updateManifest({ version, tag, nsis, msi, notes, pubDate }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Not a version: ${version}`)
  const download = (name) => `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(name)}`
  const entry = (file) => {
    const signature = file.signature.trim()
    if (!signature) throw new Error(`${file.name} has no signature`)
    return { signature, url: download(file.name) }
  }
  return {
    version,
    notes: notes ?? `Tomify for Windows ${version}`,
    pub_date: pubDate,
    platforms: {
      'windows-x86_64': entry(nsis),
      'windows-x86_64-nsis': entry(nsis),
      'windows-x86_64-msi': entry(msi),
    },
  }
}

// The one installer of a type in the bundle folder, and its .sig beside it.
export function signedInstaller(folder, extension) {
  const names = readdirSync(folder).filter((name) => name.endsWith(extension))
  if (names.length !== 1) throw new Error(`Expected one ${extension} in ${folder}, found ${names.length}`)
  const [name] = names
  return { name, signature: readFileSync(join(folder, `${name}.sig`), 'utf8') }
}

export function versionFromInstaller(name) {
  const match = name.match(/^Tomify_(\d+\.\d+\.\d+)_/)
  if (!match) throw new Error(`Can't read the version from ${name}`)
  return match[1]
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [bundle, out, tag] = process.argv.slice(2)
  if (!bundle || !out || !tag) {
    console.error('Usage: node scripts/desktop-update-manifest.mjs <bundle folder> <out file> <tag>')
    process.exit(1)
  }
  const nsis = signedInstaller(join(bundle, 'nsis'), '-setup.exe')
  const msi = signedInstaller(join(bundle, 'msi'), '.msi')
  const version = versionFromInstaller(nsis.name)
  if (versionFromInstaller(msi.name) !== version || tag !== releaseTag(version)) {
    throw new Error(`${nsis.name}, ${msi.name} and ${tag} don't agree on the version`)
  }
  const manifest = updateManifest({ version, tag, nsis, msi, pubDate: new Date().toISOString() })
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`Wrote ${out} for ${version}`)
}

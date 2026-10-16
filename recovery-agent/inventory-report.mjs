function value(value) { return String(value ?? '').trim() }

export function normalizeInventoryText(input) {
  return value(input).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('en')
    .replace(/&/g, ' and ').replace(/[\u2019']/g, '').replace(/[^a-z0-9]+/g, ' ').trim().replace(/^the\s+/, '')
}

function pathParts(path) { return value(path).replace(/\\/g, '/').split('/').filter(Boolean) }
function basename(path) { return pathParts(path).at(-1) || '' }
function ancestorDirectories(path) {
  const parts = pathParts(path)
  parts.pop()
  const absolute = value(path).startsWith('/')
  return parts.slice(1).map((_, index) => `${absolute ? '/' : ''}${parts.slice(0, index + 2).join('/')}`)
}
function sameRecording(left, right) {
  const leftId = value(left?.tags?.recordingId).toLowerCase()
  const rightId = value(right?.tags?.recordingId).toLowerCase()
  if (leftId && rightId && leftId === rightId) return true
  const leftArtist = normalizeInventoryText(left?.tags?.artist || left?.tags?.albumArtist)
  const rightArtist = normalizeInventoryText(right?.tags?.artist || right?.tags?.albumArtist)
  const leftTitle = normalizeInventoryText(left?.tags?.title)
  const rightTitle = normalizeInventoryText(right?.tags?.title)
  if (!leftArtist || leftArtist !== rightArtist || !leftTitle || leftTitle !== rightTitle) return false
  const leftDuration = Number(left?.probe?.duration)
  const rightDuration = Number(right?.probe?.duration)
  return Number.isFinite(leftDuration) && Number.isFinite(rightDuration) && Math.abs(leftDuration - rightDuration) <= 2
}
function fingerprint(file) {
  return value(file?.fingerprint || file?.audioFingerprint || file?.hash || file?.sha256 || file?.probe?.fingerprint || file?.probe?.hash).toLowerCase() || null
}
function groupBy(items, key) {
  const groups = new Map()
  for (const item of items) {
    const identity = key(item)
    if (!identity) continue
    const group = groups.get(identity) || []
    group.push(item)
    groups.set(identity, group)
  }
  return groups
}
function editDistanceAtMostOne(left, right) {
  if (left === right) return true
  if (Math.abs(left.length - right.length) > 1 || Math.min(left.length, right.length) < 5) return false
  let changes = 0
  for (let a = 0, b = 0; a < left.length && b < right.length;) {
    if (left[a] === right[b]) { a += 1; b += 1; continue }
    if (++changes > 1) return false
    if (left.length > right.length) a += 1
    else if (right.length > left.length) b += 1
    else { a += 1; b += 1 }
  }
  return true
}
function distinct(values) { return [...new Set(values.filter(Boolean))] }

function duplicateDirectories(files) {
  const directories = distinct(files.flatMap((file) => ancestorDirectories(file.path))).map((path) => ({ path, name: basename(path), normalized: normalizeInventoryText(basename(path)) }))
  const parent = directories.map((_, index) => index)
  const root = (index) => parent[index] === index ? index : (parent[index] = root(parent[index]))
  for (let left = 0; left < directories.length; left += 1) for (let right = left + 1; right < directories.length; right += 1) {
    const a = directories[left]
    const b = directories[right]
    if (a.name !== b.name && a.normalized && editDistanceAtMostOne(a.normalized, b.normalized)) parent[root(right)] = root(left)
  }
  const groups = new Map()
  directories.forEach((entry, index) => {
    const key = root(index)
    const group = groups.get(key) || []
    group.push(entry)
    groups.set(key, group)
  })
  return [...groups.values()].filter((entries) => entries.length > 1).map((entries) => ({ kind: 'directory', label: distinct(entries.map((entry) => entry.name)).join(' / '), paths: entries.map((entry) => entry.path).sort() }))
}

function recordingGroups(files) {
  const parent = files.map((_, index) => index)
  const root = (index) => parent[index] === index ? index : (parent[index] = root(parent[index]))
  for (let left = 0; left < files.length; left += 1) for (let right = left + 1; right < files.length; right += 1) if (sameRecording(files[left], files[right])) parent[root(right)] = root(left)
  const groups = new Map()
  files.forEach((file, index) => { const key = root(index); const group = groups.get(key) || []; group.push(file); groups.set(key, group) })
  return [...groups.values()].filter((group) => group.length > 1)
}

function findTracklist(album, tracklists) {
  return tracklists.find((tracklist) => album.releaseIds.has(value(tracklist?.releaseId).toLowerCase()))
    || tracklists.find((tracklist) => album.releaseGroupIds.has(value(tracklist?.releaseGroupId).toLowerCase()))
    || tracklists.find((tracklist) => normalizeInventoryText(tracklist?.title) === album.album && normalizeInventoryText(tracklist?.artist) === album.artist)
    || null
}

function partialAlbums(files, tracklists) {
  const albums = groupBy(files.filter((file) => file?.tags?.album), (file) => `${file.library}\0${normalizeInventoryText(file.tags.albumArtist || file.tags.artist)}\0${normalizeInventoryText(file.tags.album)}`)
  const result = []
  for (const albumFiles of albums.values()) {
    const first = albumFiles[0]
    const album = {
      artist: normalizeInventoryText(first.tags.albumArtist || first.tags.artist), album: normalizeInventoryText(first.tags.album),
      releaseIds: new Set(albumFiles.map((file) => value(file.tags.releaseId).toLowerCase()).filter(Boolean)),
      releaseGroupIds: new Set(albumFiles.map((file) => value(file.tags.releaseGroupId).toLowerCase()).filter(Boolean)),
    }
    const missingNumbers = []
    const discs = groupBy(albumFiles.filter((file) => Number(file.tags.trackNumber) > 0), (file) => Number(file.tags.discNumber) || 1)
    for (const [disc, tracks] of discs) {
      const numbers = new Set(tracks.map((file) => Number(file.tags.trackNumber)))
      const maximum = Math.max(...numbers)
      for (let number = 1; number <= maximum; number += 1) if (!numbers.has(number)) missingNumbers.push({ disc: Number(disc), number })
    }
    const tracklist = findTracklist(album, tracklists)
    const expected = Array.isArray(tracklist?.tracks) ? tracklist.tracks : []
    const actualRecordingIds = new Set(albumFiles.map((file) => value(file.tags.recordingId).toLowerCase()).filter(Boolean))
    const actualPositions = new Set(albumFiles.map((file) => `${Number(file.tags.discNumber) || 1}-${Number(file.tags.trackNumber) || 0}`))
    const missingTracks = expected.filter((track) => {
      const recordingId = value(track.recordingId).toLowerCase()
      return recordingId ? !actualRecordingIds.has(recordingId) : !actualPositions.has(`${Number(track.disc) || 1}-${Number(track.number) || 0}`)
    }).map((track) => ({ disc: Number(track.disc) || 1, number: Number(track.number) || null, title: value(track.title) }))
    const actualTracks = new Set(albumFiles.map((file) => Number(file.tags.trackNumber) > 0 ? `${Number(file.tags.discNumber) || 1}-${Number(file.tags.trackNumber)}` : `path:${file.path}`)).size
    if (!missingNumbers.length && (!expected.length || actualTracks >= expected.length)) continue
    result.push({
      kind: 'partial-album', label: `${value(first.tags.albumArtist || first.tags.artist) || 'Unknown artist'} — ${value(first.tags.album)}`,
      library: first.library, albumId: tracklist?.albumId || null, expectedTracks: expected.length || null, actualTracks,
      missingTrackNumbers: missingNumbers, missingTracks, paths: albumFiles.map((file) => file.path).sort(),
    })
  }
  return result
}

function orphanedSources(files, sourceFiles, sidecars) {
  const sourceInventoryAvailable = Array.isArray(sourceFiles)
  const preserved = sourceInventoryAvailable ? sourceFiles : []
  const filePaths = new Set([...files, ...preserved].map((file) => file.path))
  const referencedSources = new Set(sidecars.map((sidecar) => value(sidecar.sourcePath)).filter(Boolean))
  const result = []
  for (const sidecar of sidecars) {
    if (sidecar.orphan) result.push({ kind: 'orphan-sidecar', label: 'Sidecar has no audio file', paths: [sidecar.path], missingPath: sidecar.audioPath || null })
    if (sourceInventoryAvailable && sidecar.sourcePath && !filePaths.has(sidecar.sourcePath)) result.push({ kind: 'missing-source', label: 'Sidecar points to a missing preserved source', paths: distinct([sidecar.path, sidecar.audioPath]), missingPath: sidecar.sourcePath })
  }
  for (const file of preserved) if (!referencedSources.has(file.path)) result.push({ kind: 'orphan-source', label: 'Preserved source has no sidecar', paths: [file.path], missingPath: null })
  return result
}

/** Build a health report exclusively from an already stored inventory. No filesystem operations occur here. */
export function reportLibraryInventory(inventory, { tracklists = [], checkPaths = [] } = {}) {
  const allFiles = Array.isArray(inventory?.files) ? inventory.files : []
  const sourceFiles = Array.isArray(inventory?.sourceFiles) ? inventory.sourceFiles : null
  const sidecars = Array.isArray(inventory?.sidecars) ? inventory.sidecars : []
  const files = allFiles.filter((file) => !pathParts(file.path).includes('.tomify-source'))
  const duplicates = []
  for (const group of groupBy(files.filter(fingerprint), (file) => `${Number(file.size) || 0}\0${fingerprint(file)}`).values()) if (group.length > 1) duplicates.push({ kind: 'content', label: 'Matching audio fingerprint and size', paths: group.map((file) => file.path).sort() })
  for (const group of recordingGroups(files)) duplicates.push({ kind: 'recording', label: `${value(group[0].tags?.artist || group[0].tags?.albumArtist)} — ${value(group[0].tags?.title)}`, paths: group.map((file) => file.path).sort() })
  duplicates.push(...duplicateDirectories(files))
  const shadows = recordingGroups(files).filter((group) => group.some((file) => file.library === 'master') && group.some((file) => file.library === 'recovery')).map((group) => ({
    kind: 'shadowed-recovery', label: `${value(group[0].tags?.artist || group[0].tags?.albumArtist)} — ${value(group[0].tags?.title)}`,
    masterPaths: group.filter((file) => file.library === 'master').map((file) => file.path).sort(), recoveryPaths: group.filter((file) => file.library === 'recovery').map((file) => file.path).sort(), paths: group.map((file) => file.path).sort(),
  }))
  const knownPaths = new Set(allFiles.map((file) => file.path))
  return {
    completedAt: inventory?.completedAt || null,
    duplicates, partialAlbums: partialAlbums(files, Array.isArray(tracklists) ? tracklists : []),
    orphanedSources: orphanedSources(allFiles, sourceFiles, sidecars), shadowedRecovery: shadows,
    checkedPaths: Object.fromEntries((Array.isArray(checkPaths) ? checkPaths : []).map((path) => [path, knownPaths.has(path)])),
  }
}

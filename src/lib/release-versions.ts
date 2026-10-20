import type { Album, Track } from '../types'

type Version = Album & { song?: Track[] }

function formatOf(tracks: Track[]): string {
  const formats = [...new Set(tracks.map((track) => track.suffix?.trim().toUpperCase()).filter((suffix): suffix is string => Boolean(suffix)))]
  return formats.sort().join('/')
}

/**
 * Names for the album page's version picker. A version keeps its own album name; when two versions share a name,
 * the year, file format and song count are added until they can be told apart, then a number as a last resort.
 */
export function versionLabels(versions: Version[]): Map<string, string> {
  const details = versions.map((version) => {
    const tracks = version.song ?? []
    return {
      id: version.id,
      name: (version.name || version.title || 'Untitled').trim(),
      parts: [version.year ? String(version.year) : '', formatOf(tracks), `${tracks.length} ${tracks.length === 1 ? 'song' : 'songs'}`],
    }
  })
  const labels = new Map<string, string>()
  const build = (detail: (typeof details)[number], depth: number) => [detail.name, ...detail.parts.slice(0, depth).filter(Boolean)].join(' · ')
  for (const detail of details) {
    let label = detail.name
    for (let depth = 0; depth <= detail.parts.length; depth += 1) {
      label = build(detail, depth)
      const clashes = details.filter((other) => other.id !== detail.id && build(other, depth) === label)
      if (!clashes.length) break
    }
    labels.set(detail.id, label)
  }
  // Identical on every detail: number them in list order.
  const seen = new Map<string, number>()
  const totals = new Map<string, number>()
  for (const label of labels.values()) totals.set(label, (totals.get(label) ?? 0) + 1)
  for (const detail of details) {
    const label = labels.get(detail.id) ?? detail.name
    if ((totals.get(label) ?? 0) < 2) continue
    const count = (seen.get(label) ?? 0) + 1
    seen.set(label, count)
    labels.set(detail.id, `${label} (${count})`)
  }
  return labels
}

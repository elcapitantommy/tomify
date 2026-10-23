import type { TomifinResult } from './api'

export type SortKey = 'relevance' | 'seeders' | 'size-desc' | 'size-asc'

// How well a title matches the words searched for, for the Relevance sort; seeders break ties.
export function relevance(title: string, query: string) {
  const words = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  if (!words.length) return 0
  const name = title.toLowerCase()
  return words.filter((word) => name.includes(word)).length / words.length
}

export function sortResults(results: TomifinResult[], sort: SortKey, query: string) {
  const sorted = [...results]
  if (sort === 'seeders') sorted.sort((a, b) => b.seeders - a.seeders)
  else if (sort === 'size-desc') sorted.sort((a, b) => (b.size ?? -1) - (a.size ?? -1))
  else if (sort === 'size-asc') sorted.sort((a, b) => (a.size ?? Infinity) - (b.size ?? Infinity))
  else sorted.sort((a, b) => relevance(b.title, query) - relevance(a.title, query) || b.seeders - a.seeders)
  return sorted
}

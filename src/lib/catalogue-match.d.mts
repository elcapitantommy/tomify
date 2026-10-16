import type { Track } from '../types'
import type { CataloguePlaylistItem } from './catalogue-import'

export function normaliseCatalogueText(value?: string | null): string
export function stripEditionSuffix(value?: string | null): string
export function primaryArtist(value?: string | null): string
export function scoreCatalogueMatch(wanted: Pick<CataloguePlaylistItem, 'title' | 'artists' | 'album' | 'duration' | 'isrc' | 'musicBrainzRecordingId'>, candidate: Track): number
export function matchCatalogueItem(item: CataloguePlaylistItem, candidates: Track[]): CataloguePlaylistItem
export function catalogueSearchQueries(item: Pick<CataloguePlaylistItem, 'title' | 'artists'>): string[]
export function findCatalogueMatch(item: CataloguePlaylistItem, search: (query: string) => Promise<Track[]>): Promise<CataloguePlaylistItem>

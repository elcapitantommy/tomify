import { useEffect, useMemo, useState } from 'react'
import { useApi } from '../lib/api-context'
import { useLoad } from '../hooks/useLoad'
import { AlbumCard } from '../components/MediaCards'
import { EmptyState, ErrorState, SkeletonGrid } from '../components/States'
import { usePlayer } from '../stores/player'
import { collapseReleaseVariants, releaseBucket, releaseFamilyTitle, releaseYearLabel, resolvedReleaseType, sortReleases, type ReleaseFilter, type ReleaseSort } from '../lib/release-metadata'
import { useReleaseMetadata } from '../stores/releaseMetadata'

const filters: Array<{ value: ReleaseFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'album', label: 'Albums' },
  { value: 'single-ep', label: 'Singles & EPs' },
  { value: 'compilation', label: 'Compilations' },
]

export function Albums() {
  const api = useApi()
  const overrides = useReleaseMetadata((state) => state.overrides)
  const enrichMany = useReleaseMetadata((state) => state.enrichMany)
  const cloudStatus = useReleaseMetadata((state) => state.cloudStatus)
  const [filter, setFilter] = useState<ReleaseFilter>('all')
  const [sort, setSort] = useState<ReleaseSort>('newest')
  const { data, error, loading, retry } = useLoad((signal) => api.albums('alphabeticalByName', 500, signal), [api])
  const play = async (id: string) => usePlayer.getState().playTracks((await api.album(id)).song ?? [])

  useEffect(() => {
    if (data?.length && cloudStatus === 'cloud') void enrichMany(data, 24)
  }, [cloudStatus, data, enrichMany])

  const allFamilies = useMemo(() => collapseReleaseVariants(data ?? [], overrides), [data, overrides])

  const counts = useMemo(() => {
    const result = { all: allFamilies.length, album: 0, 'single-ep': 0, compilation: 0 }
    for (const family of allFamilies) result[releaseBucket(resolvedReleaseType(family.representative, overrides[family.representative.id]))] += 1
    return result
  }, [allFamilies, overrides])

  const visible = useMemo(() => {
    const filtered = (data ?? []).filter((album) => filter === 'all' || releaseBucket(resolvedReleaseType(album, overrides[album.id])) === filter)
    const families = collapseReleaseVariants(filtered, overrides)
    const representatives = sortReleases(families.map((family) => family.representative), overrides, sort)
    const byId = new Map(families.map((family) => [family.representative.id, family]))
    return representatives.map((album) => byId.get(album.id)!).filter(Boolean)
  }, [data, filter, overrides, sort])

  return <div className="page">
    <header className="page-header"><span className="eyebrow">The collection</span><h1>Albums</h1><p>{data ? `${allFamilies.length} releases · ${data.length} versions` : 'Browse every release on your shelves.'}</p></header>
    <div className="release-toolbar">
      <div className="release-tabs" role="tablist" aria-label="Release type">
        {filters.map((item) => <button key={item.value} className={filter === item.value ? 'release-tab active' : 'release-tab'} onClick={() => setFilter(item.value)}>{item.label}<span>{counts[item.value]}</span></button>)}
      </div>
      <label className="release-sort"><span>Sort</span><select value={sort} onChange={(event) => setSort(event.target.value as ReleaseSort)}><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="title">A–Z</option></select></label>
    </div>
    {loading && <SkeletonGrid rows={10}/>} {error && <ErrorState message={error} retry={retry}/>}
    {data && !data.length && <EmptyState title="No albums yet" message="Add music to Navidrome and it will appear here."/>}
    {data && data.length > 0 && !visible.length && <EmptyState title="Nothing in this section yet" message="Classify a release and it will appear here."/>}
    <div className="card-grid">{visible.map((family) => <AlbumCard album={family.representative} key={family.key} displayTitle={releaseFamilyTitle(family.representative)} variantCount={family.variants.length} dateLabel={releaseYearLabel(family.representative, overrides[family.representative.id])} onPlay={() => void play(family.representative.id)}/>)}</div>
  </div>
}

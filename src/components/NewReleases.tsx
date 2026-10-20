import { useEffect, useState } from 'react'
import { Check, Disc3, ExternalLink, LifeBuoy, Sparkle } from 'lucide-react'
import { useLoad } from '../hooks/useLoad'
import { useApi } from '../lib/api-context'
import { coverUrl, newReleasesApi, notInLibrary, releaseDateLabel, type NewRelease } from '../lib/new-releases'
import { recoveryApi } from '../lib/recovery-api'
import { useAuth } from '../stores/auth'

const SHOWN = 8
const typeLabel: Record<NewRelease['type'], string> = { album: 'Album', ep: 'EP', single: 'Single' }

function Cover({ release }: { release: NewRelease }) {
  const [failed, setFailed] = useState(false)
  return <div className="artwork new-release-cover">{failed ? <div className="artwork-fallback"><Disc3/></div> : <img src={coverUrl(release.id)} alt="" loading="lazy" onError={() => setFailed(true)}/>}</div>
}

// "New from your artists" on Home: records from the last four months (and announced ones) by artists in the
// library that aren't in it yet. Administrators can send one straight to Recovery.
export function NewReleases() {
  const api = useApi()
  const username = useAuth((state) => state.session?.username ?? '')
  const isAdmin = useAuth((state) => state.isAdmin) === true
  const [showAll, setShowAll] = useState(false)
  const [added, setAdded] = useState<Record<string, 'adding' | 'added' | string>>({})

  useEffect(() => {
    if (username) void newReleasesApi.syncArtists(username, () => api.artists()).catch(() => false)
  }, [api, username])

  const { data } = useLoad(async (signal) => {
    const [found, albums] = await Promise.all([newReleasesApi.load(signal), api.allAlbums(signal)])
    return notInLibrary(found.releases, albums)
  }, [api], `new-releases:${username}`)

  if (!data?.length) return null
  const shown = showAll ? data : data.slice(0, SHOWN)

  const addToRecovery = async (release: NewRelease) => {
    setAdded((state) => ({ ...state, [release.id]: 'adding' }))
    try {
      await recoveryApi.add({ artist: release.artist, album: release.title })
      setAdded((state) => ({ ...state, [release.id]: 'added' }))
    } catch (error) {
      setAdded((state) => ({ ...state, [release.id]: error instanceof Error ? error.message : 'Could not add it to Recovery.' }))
    }
  }

  return <section aria-label="New from your artists" className="new-releases">
    <div className="section-title"><div><span className="eyebrow">Not in your library yet</span><h2><Sparkle/>New from your artists</h2></div>{data.length > SHOWN && <button type="button" className="link-button" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show fewer' : `See all ${data.length}`}</button>}</div>
    <div className="card-grid">{shown.map((release) => {
      const state = added[release.id]
      return <article className="media-card new-release" key={release.id}>
        <a href={`https://musicbrainz.org/release-group/${release.id}`} target="_blank" rel="noreferrer" aria-label={`${release.title} by ${release.artist} on MusicBrainz`}><Cover release={release}/><h3>{release.title}</h3><p>{release.artist}</p><p className="new-release-meta">{typeLabel[release.type] ?? 'Release'} · {releaseDateLabel(release.date)}<ExternalLink size={11}/></p></a>
        {isAdmin && <button type="button" className="button secondary new-release-add" disabled={state === 'adding' || state === 'added'} onClick={() => void addToRecovery(release)}>{state === 'added' ? <><Check/>In Recovery</> : <><LifeBuoy/>{state === 'adding' ? 'Adding…' : 'Add to Recovery'}</>}</button>}
        {state && state !== 'adding' && state !== 'added' && <p className="new-release-error" role="alert">{state}</p>}
      </article>
    })}</div>
  </section>
}

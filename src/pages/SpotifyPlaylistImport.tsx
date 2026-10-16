import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ArrowLeft, Check, CircleHelp, ExternalLink, LoaderCircle, Music2, RefreshCw, Search, Unplug, X } from 'lucide-react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useApi } from '../lib/api-context'
import { catalogueApi } from '../lib/catalogue-api'
import { matchCatalogueItem, type CatalogueItemStatus, type CataloguePlaylistDraft } from '../lib/catalogue-import'
import { useAuth } from '../stores/auth'

type Filter = 'all' | 'available' | 'missing' | 'review' | 'unavailable'

export function SpotifyPlaylistImport() {
  const api = useApi(); const navigate = useNavigate(); const [params] = useSearchParams()
  // Only administrators can queue missing tracks in Recovery; everyone can import the playlist itself.
  const isAdmin = useAuth((s) => s.isAdmin) === true
  const [url, setUrl] = useState(params.get('url') || '')
  const [status, setStatus] = useState<{ configured: boolean; connected: boolean } | null>(null)
  const [draft, setDraft] = useState<CataloguePlaylistDraft | null>(null)
  const [existingId, setExistingId] = useState<string | null>(null)
  const [diff, setDiff] = useState<{ added: string[]; removed: string[]; reordered: boolean } | null>(null)
  const [filter, setFilter] = useState<Filter>('all'); const [busy, setBusy] = useState(false); const [progress, setProgress] = useState(''); const [error, setError] = useState<string | null>(params.get('spotify') === 'error' ? 'Spotify could not be connected. Try again.' : null)
  useEffect(() => { void catalogueApi.spotifyStatus().then(setStatus).catch((reason) => setError(reason instanceof Error ? reason.message : 'Could not check Spotify.')) }, [])
  const counts = useMemo(() => draft?.items.reduce<Record<string, number>>((result, item) => { result[item.status] = (result[item.status] || 0) + 1; return result }, {}) ?? {}, [draft])

  async function connect() { setBusy(true); setError(null); try { const result = await catalogueApi.connectSpotify(); window.location.assign(result.authorizationUrl) } catch (reason) { setError(reason instanceof Error ? reason.message : 'Spotify connection failed.'); setBusy(false) } }
  async function analyse() {
    setBusy(true); setError(null); setDraft(null); setProgress('Fetching playlist from Spotify…')
    try {
      const result = await catalogueApi.analyseSpotify(url); setExistingId(result.existingPlaylists[0]?.id || null); setDiff(result.diff)
      const items = [...result.playlist.items]; const searchable = items.filter((item) => item.status !== 'unavailable')
      for (let offset = 0; offset < searchable.length; offset += 5) {
        setProgress(`Matching library tracks ${Math.min(offset + 5, searchable.length)} of ${searchable.length}…`)
        await Promise.all(searchable.slice(offset, offset + 5).map(async (item) => {
          try { const found = await api.search(`${item.artists.join(' ')} ${item.title}`); items[item.position] = matchCatalogueItem(item, found.tracks) }
          catch { items[item.position] = { ...item, status: 'missing' } }
        }))
      }
      setDraft({ ...result.playlist, items }); setProgress('')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Playlist analysis failed.'); setProgress('') } finally { setBusy(false) }
  }
  function chooseMatch(position: number, candidateIndex: number) { setDraft((current) => current ? { ...current, items: current.items.map((item) => item.position === position ? { ...item, status: 'available', localTrack: item.matchCandidates?.[candidateIndex]?.track || null, localTrackId: item.matchCandidates?.[candidateIndex]?.track.id || null, matchConfidence: item.matchCandidates?.[candidateIndex]?.confidence || 0, userConfirmed: true } : item) } : current) }
  function makeMissing(position: number) { setDraft((current) => current ? { ...current, items: current.items.map((item) => item.position === position ? { ...item, status: 'missing', localTrack: null, localTrackId: null, userConfirmed: true } : item) } : current) }
  async function save(createRecovery: boolean, update: boolean) { if (!draft) return; setBusy(true); setError(null); try { const result = update && existingId ? await catalogueApi.update(existingId, draft, createRecovery) : await catalogueApi.create(draft, createRecovery); navigate(`/playlists/imported/${result.playlist.id}`) } catch (reason) { setError(reason instanceof Error ? reason.message : 'Playlist import failed.') } finally { setBusy(false) } }
  const visible = draft?.items.filter((item) => filter === 'all' || item.status === filter) || []

  return <div className="page spotify-import-page"><header className="page-header"><Link className="eyebrow" to="/playlists"><ArrowLeft size={14}/>Playlists</Link><h1>Import from Spotify</h1><p>Spotify supplies catalogue metadata only. Playback always comes from your own Tomify library.</p></header>
    {error && <div className="login-error recovery-error">{error}</div>}
    {!status ? <div className="state-card"><LoaderCircle className="spin"/><h2>Checking Spotify connection</h2></div> : !status.configured ? <section className="settings-card"><h2>Spotify import is not configured</h2><p>Add the server-side Spotify application credentials, redirect URI, and token-encryption secret described in the Recovery documentation.</p></section> : !status.connected ? <section className="spotify-connect settings-card"><Music2/><div><h2>Connect Spotify</h2><p>Spotify now requires account authorization to read playlist items. Tomify stores encrypted tokens server-side and never receives your Spotify password.</p><button className="button primary" disabled={busy} onClick={() => void connect()}>{busy ? <LoaderCircle className="spin"/> : <Music2/>}Connect Spotify</button></div></section> : <>
      <section className="spotify-analyse settings-card"><div className="section-title"><div><span className="eyebrow">Spotify playlist</span><h2>Paste a playlist link</h2></div><button className="button secondary" onClick={() => void catalogueApi.disconnectSpotify().then(() => setStatus({ configured: true, connected: false }))}><Unplug/>Disconnect</button></div><div className="spotify-url"><input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://open.spotify.com/playlist/…"/><button className="button primary" disabled={busy || !url.trim()} onClick={() => void analyse()}>{busy ? <LoaderCircle className="spin"/> : <Search/>}Analyse</button></div><small>Current Spotify API access is limited to playlists owned by or collaboratively shared with the connected account.</small>{progress && <p className="import-progress"><LoaderCircle className="spin"/>{progress}</p>}</section>
      {draft && <section className="spotify-review"><header className="spotify-playlist-heading">{draft.artwork[0]?.url ? <img src={draft.artwork[0].url} alt="" referrerPolicy="no-referrer"/> : <span><Music2/></span>}<div><span className="eyebrow">Spotify playlist</span><h2>{draft.name}</h2><p>{draft.items.length} tracks · <a href={draft.sourceUrl} target="_blank" rel="noreferrer">Open in Spotify <ExternalLink size={13}/></a></p></div></header>
        <div className="import-summary"><div className="available"><Check/><strong>{counts.available || 0}</strong><span>in Tomify</span></div><div className="missing"><AlertTriangle/><strong>{counts.missing || 0}</strong><span>missing</span></div><div className="review"><CircleHelp/><strong>{counts.review || 0}</strong><span>require review</span></div>{Boolean(counts.unavailable) && <div><X/><strong>{counts.unavailable}</strong><span>unavailable</span></div>}</div>
        {existingId && <div className="refresh-diff"><RefreshCw/><span><strong>Previously imported.</strong> {diff?.added.length || 0} added, {diff?.removed.length || 0} removed{diff?.reordered ? ', order changed' : ''}.</span></div>}
        <div className="import-filters">{(['all', 'available', 'missing', 'review', 'unavailable'] as Filter[]).map((value) => <button className={filter === value ? 'active' : ''} onClick={() => setFilter(value)} key={value}>{value[0].toUpperCase() + value.slice(1)}</button>)}</div>
        <ol className="import-track-list">{visible.map((item) => <li key={`${item.position}:${item.providerTrackId || item.title}`}><span className="import-position">{String(item.position + 1).padStart(2, '0')}</span><span className="import-track-copy"><strong>{item.artists.length ? `${item.artists.join(', ')} – ${item.title}` : item.title}</strong><small>{item.album}{item.duration ? ` · ${Math.floor(item.duration / 60)}:${String(Math.round(item.duration % 60)).padStart(2, '0')}` : ''}</small>{item.status === 'review' && item.matchCandidates?.length ? <span className="match-review">{item.matchCandidates.map((candidate, index) => <button onClick={() => chooseMatch(item.position, index)} key={candidate.track.id}>Use {candidate.track.artist} – {candidate.track.title} ({candidate.confidence}%)</button>)}<button onClick={() => makeMissing(item.position)}>Treat as missing</button></span> : null}</span><Status status={item.status} recoveryId={isAdmin ? item.recoveryId : null} reason={item.unavailableReason}/></li>)}</ol>
        <div className="import-actions"><button className={isAdmin ? 'button secondary' : 'button primary'} disabled={busy} onClick={() => void save(false, Boolean(existingId))}>{existingId ? isAdmin ? 'Update without Recovery' : 'Update playlist' : 'Import playlist'}</button>{isAdmin && <button className="button primary" disabled={busy} onClick={() => void save(true, Boolean(existingId))}>{busy ? <LoaderCircle className="spin"/> : existingId ? <RefreshCw/> : <Music2/>}{existingId ? 'Update + add missing to Recovery' : 'Import + add missing to Recovery'}</button>}{existingId && <button className="button secondary" disabled={busy} onClick={() => void save(isAdmin, false)}>Create a separate copy</button>}</div>
      </section>}
    </>}
  </div>
}

function Status({ status, recoveryId, reason }: { status: CatalogueItemStatus; recoveryId?: string | null; reason?: string | null }) { if (status === 'available') return <span className="import-status available"><Check/>In library</span>; if (status === 'review') return <span className="import-status review"><CircleHelp/>Review match</span>; if (status === 'missing') return <span className="import-status missing"><AlertTriangle/>{recoveryId ? <Link to={`/recovery?item=${recoveryId}`}>Recovery</Link> : 'Missing'}</span>; return <span className="import-status unavailable"><X/>{reason === 'episode' ? 'Podcast episode' : reason === 'local-file' ? 'Spotify local file' : 'Unavailable'}</span> }

import { useState } from 'react'
import { Check, ImageUp, LoaderCircle, RotateCcw } from 'lucide-react'
import type { Album } from '../types'
import { useAlbumArtwork, type AlbumArtworkCandidate } from '../stores/albumArtwork'

type LookupState = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; candidates: AlbumArtworkCandidate[] } | { status: 'error'; message: string }

export function AlbumArtworkPicker({ album }: { album: Album }) {
  const override = useAlbumArtwork((state) => state.overrides[album.id])
  const spotifyAvailable = useAlbumArtwork((state) => state.spotifyAvailable)
  const lookup = useAlbumArtwork((state) => state.lookup)
  const select = useAlbumArtwork((state) => state.select)
  const reset = useAlbumArtwork((state) => state.reset)
  const [state, setState] = useState<LookupState>({ status: 'idle' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const search = async () => {
    setState({ status: 'loading' })
    try { setState({ status: 'ready', candidates: await lookup(album) }) }
    catch (reason) { setState({ status: 'error', message: reason instanceof Error ? reason.message : 'Spotify artwork lookup failed.' }) }
  }

  const run = async (action: () => Promise<void>) => {
    setSaving(true); setError(null)
    try { await action() } catch (reason) { setError(reason instanceof Error ? reason.message : 'Artwork could not be saved.') } finally { setSaving(false) }
  }

  const summary = override?.provider === 'spotify'
    ? `Showing Spotify artwork${override.providerAlbum ? ` from “${override.providerAlbum}”` : ''}${override.source === 'auto' ? ', matched automatically' : ', chosen by you'}.`
    : override?.provider === 'library' ? 'Keeping the library artwork. Automatic upgrades will skip this album.' : 'Showing the artwork from your music library.'

  return <section className="artwork-picker cloud-only" aria-label="Album artwork">
    <div className="release-editor-title"><ImageUp/><div><strong>Album artwork</strong><small>{summary}{override?.provider === 'spotify' && override.storeUrl && <> <a href={override.storeUrl} target="_blank" rel="noreferrer">Open in Spotify</a></>}</small></div></div>
    <div className="artwork-picker-actions">
      <button className="button secondary" disabled={!spotifyAvailable || state.status === 'loading' || saving} onClick={() => void search()}>{state.status === 'loading' ? <LoaderCircle className="spin"/> : <ImageUp/>}{spotifyAvailable ? 'Find Spotify artwork' : 'Spotify not configured'}</button>
      {override?.provider !== 'library' && <button className="button secondary" disabled={saving} onClick={() => void run(() => select(album.id, 'library'))}>Keep library artwork</button>}
      {override?.source === 'manual' && <button className="button secondary" disabled={saving} onClick={() => void run(() => reset(album.id))}><RotateCcw/>Undo my choice</button>}
    </div>
    {state.status === 'error' && <p className="artwork-picker-note">{state.message}</p>}
    {error && <p className="artwork-picker-note">{error}</p>}
    {state.status === 'ready' && !state.candidates.length && <p className="artwork-picker-note">Spotify has no confident match for this album.</p>}
    {state.status === 'ready' && state.candidates.length > 0 && <ul className="artwork-candidates">{state.candidates.map((candidate) => {
      const current = override?.provider === 'spotify' && override.url === candidate.url
      return <li key={candidate.id}><button className={current ? 'active' : ''} disabled={saving || current} onClick={() => void run(() => select(album.id, candidate))} aria-label={`Use Spotify artwork from ${candidate.album ?? 'this release'}`}>
        <img src={candidate.previewUrl || candidate.url} alt="" loading="lazy"/>
        <span><strong>{candidate.album ?? 'Spotify release'}</strong><small>{[candidate.releaseDate?.slice(0, 4), candidate.width && candidate.height ? `${candidate.width}×${candidate.height}` : null, `${candidate.confidence}% match`].filter(Boolean).join(' · ')}</small></span>
        {current && <Check/>}
      </button></li>
    })}</ul>}
  </section>
}

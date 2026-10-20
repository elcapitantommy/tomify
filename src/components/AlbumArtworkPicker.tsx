import { useEffect, useRef, useState } from 'react'
import { Check, FolderOpen, ImageUp, LoaderCircle, RotateCcw, X } from 'lucide-react'
import type { Album } from '../types'
import { useAlbumArtwork, type AlbumArtworkLookup } from '../stores/albumArtwork'

type LookupState = { status: 'idle' } | { status: 'loading' } | ({ status: 'ready' } & AlbumArtworkLookup) | { status: 'error'; message: string }

const providerLabels: Record<string, string> = { apple: 'Apple', deezer: 'Deezer', spotify: 'Spotify' }

function listNames(names: string[]) {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

// Names the catalogues that answered and the title searched, so a miss is easy to understand.
function noMatchMessage(lookup: AlbumArtworkLookup) {
  const searched = lookup.searched.map((provider) => providerLabels[provider] ?? provider)
  if (!searched.length) return 'No catalogue could be searched for this album.'
  const query = lookup.query ? ` for “${lookup.query.album}” by ${lookup.query.artist}` : ' for this album'
  return `${listNames(searched)} ${searched.length === 1 ? 'has' : 'have'} no confident match${query}.`
}

// Opened by clicking the album's artwork (administrators only); searchOnOpen looks up replacements straight away.
export function AlbumArtworkPicker({ album, searchOnOpen = false, onClose }: { album: Album; searchOnOpen?: boolean; onClose?: () => void }) {
  const override = useAlbumArtwork((state) => state.overrides[album.id])
  const available = useAlbumArtwork((state) => state.providers.length > 0)
  const lookup = useAlbumArtwork((state) => state.lookup)
  const select = useAlbumArtwork((state) => state.select)
  const reset = useAlbumArtwork((state) => state.reset)
  const upload = useAlbumArtwork((state) => state.upload)
  const fileInput = useRef<HTMLInputElement>(null)
  const [state, setState] = useState<LookupState>({ status: 'idle' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const search = async () => {
    setState({ status: 'loading' })
    try { setState({ status: 'ready', ...await lookup(album) }) }
    catch (reason) { setState({ status: 'error', message: reason instanceof Error ? reason.message : 'Artwork lookup failed.' }) }
  }

  useEffect(() => {
    if (searchOnOpen && available) void search()
  }, [album.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (action: () => Promise<void>) => {
    setSaving(true); setError(null)
    try { await action() } catch (reason) { setError(reason instanceof Error ? reason.message : 'Artwork could not be saved.') } finally { setSaving(false) }
  }

  const providerName = override && override.provider !== 'library' && override.provider !== 'upload' ? ({ apple: 'Apple', deezer: 'Deezer', spotify: 'Spotify' })[override.provider] : ''
  const summary = override?.provider === 'upload' ? 'Showing an image uploaded from a device.'
    : override && override.provider !== 'library'
    ? `Showing ${providerName} artwork${override.providerAlbum ? ` from “${override.providerAlbum}”` : ''}${override.source === 'auto' ? ', matched automatically' : ', chosen by you'}.`
    : override?.provider === 'library' ? 'Keeping the library artwork. Automatic upgrades will skip this album.' : 'Showing the artwork from your music library.'

  return <section className="artwork-picker cloud-only" aria-label="Album artwork">
    <div className="release-editor-title"><ImageUp/><div><strong>Album artwork</strong><small>{summary}{providerName && override?.storeUrl && <> <a href={override.storeUrl} target="_blank" rel="noreferrer">Open in {providerName}</a></>}</small></div>{onClose && <button type="button" className="icon-button artwork-picker-close" onClick={onClose} aria-label="Close album artwork options"><X/></button>}</div>
    <div className="artwork-picker-actions">
      <button className="button secondary" disabled={!available || state.status === 'loading' || saving} onClick={() => void search()}>{state.status === 'loading' ? <LoaderCircle className="spin"/> : <ImageUp/>}Find better artwork</button>
      <button className="button secondary" disabled={saving} onClick={() => fileInput.current?.click()}>{saving ? <LoaderCircle className="spin"/> : <FolderOpen/>}Upload from device</button>
      <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,image/*" hidden aria-label="Album artwork image" onChange={(event) => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (file) void run(() => upload(album.id, file))
      }}/>
      {override?.provider !== 'library' && <button className="button secondary" disabled={saving} onClick={() => void run(() => select(album.id, 'library'))}>Keep library artwork</button>}
      {override?.source === 'manual' && <button className="button secondary" disabled={saving} onClick={() => void run(() => reset(album.id))}><RotateCcw/>Undo my choice</button>}
    </div>
    {state.status === 'error' && <p className="artwork-picker-note">{state.message}</p>}
    {error && <p className="artwork-picker-note">{error}</p>}
    {state.status === 'ready' && !state.candidates.length && <p className="artwork-picker-note">{noMatchMessage(state)}</p>}
    {state.status === 'ready' && state.failed.map((failure) => <p key={failure.provider} className="artwork-picker-note">{providerLabels[failure.provider] ?? failure.provider} could not be searched: {failure.message}</p>)}
    {state.status === 'ready' && state.candidates.length > 0 && <ul className="artwork-picker-candidates">{state.candidates.map((candidate) => {
      const current = override?.provider === 'spotify' && override.url === candidate.url
      return <li key={candidate.id}><button className={current ? 'active' : ''} disabled={saving || current} onClick={() => void run(() => select(album.id, candidate))} aria-label={`Use ${candidate.providerLabel ?? candidate.provider} artwork from ${candidate.album ?? 'this release'}`}>
        <img src={candidate.previewUrl || candidate.url} alt="" loading="lazy"/>
        <span><strong>{candidate.album ?? 'Release'}</strong><small>{[candidate.providerLabel ?? candidate.provider, candidate.releaseDate?.slice(0, 4), candidate.width && candidate.height ? `${candidate.width}×${candidate.height}` : null, `${candidate.confidence}% match`].filter(Boolean).join(' · ')}</small></span>
        {current && <Check/>}
      </button></li>
    })}</ul>}
  </section>
}

import { useState } from 'react'
import { AlertTriangle, ArrowLeft, Check, CircleHelp, FileUp, LoaderCircle, Plus } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { useApi } from '../lib/api-context'
import { findCatalogueMatch, type CataloguePlaylistItem } from '../lib/catalogue-import'
import { parseM3u, type M3uEntry } from '../lib/m3u'
import { recoveryApi } from '../lib/recovery-api'
import { useAuth } from '../stores/auth'
import type { Track } from '../types'

interface Row { entry: M3uEntry; status: 'found' | 'check' | 'missing'; track: Track | null; include: boolean }

const MAX_ENTRIES = 2000
const BATCH = 4

// Loads an .m3u/.m3u8 file, finds each song in the library, and saves the found ones as a new playlist.
// Admins can send the songs that weren't found to Recovery, one wanted song each.
export function PlaylistFileImport() {
  const api = useApi()
  const navigate = useNavigate()
  const isAdmin = useAuth((state) => state.isAdmin) === true
  const [name, setName] = useState('')
  const [rows, setRows] = useState<Row[] | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [sendMissing, setSendMissing] = useState(false)

  async function load(file: File) {
    setError(null); setRows(null)
    let parsed
    try { parsed = parseM3u(await file.text()) } catch { setError('That file could not be read.'); return }
    if (!parsed.entries.length) { setError('No songs were found in that file. It needs to be an M3U or M3U8 playlist.'); return }
    if (parsed.entries.length > MAX_ENTRIES) { setError(`That playlist has ${parsed.entries.length} songs; up to ${MAX_ENTRIES} can be imported at once.`); return }
    setName(parsed.name || file.name.replace(/\.m3u8?$/i, ''))
    const search = async (query: string) => (await api.search(query)).tracks
    const found: Row[] = []
    for (let offset = 0; offset < parsed.entries.length; offset += BATCH) {
      setProgress(`Looking for songs… ${offset} of ${parsed.entries.length}`)
      const batch = await Promise.all(parsed.entries.slice(offset, offset + BATCH).map(async (entry, index): Promise<Row> => {
        const item: CataloguePlaylistItem = { position: offset + index, status: 'unmatched', title: entry.title, artists: entry.artists, album: entry.album ?? null, duration: entry.duration ?? null }
        try {
          const match = await findCatalogueMatch(item, search)
          if (match.status === 'available' && match.localTrack) return { entry, status: 'found', track: match.localTrack, include: true }
          const best = match.matchCandidates?.[0]?.track
          if (match.status === 'review' && best) return { entry, status: 'check', track: best, include: true }
        } catch { /* counts as not found */ }
        return { entry, status: 'missing', track: null, include: false }
      }))
      found.push(...batch)
    }
    setProgress(null)
    setRows(found)
  }

  async function save() {
    if (!rows) return
    const songIds = rows.filter((row) => row.include && row.track).map((row) => row.track!.id)
    setSaving(true); setError(null)
    try {
      const playlist = await api.createPlaylist(name.trim() || 'Imported playlist', songIds)
      if (isAdmin && sendMissing) {
        for (const row of rows.filter((candidate) => candidate.status === 'missing')) {
          await recoveryApi.add({ artist: row.entry.artists[0], title: row.entry.title, album: row.entry.album, duration: row.entry.duration }).catch(() => undefined)
        }
      }
      navigate(`/playlists/${playlist.id}`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The playlist could not be created.')
      setSaving(false)
    }
  }

  const toggle = (index: number) => setRows((current) => current?.map((row, position) => position === index ? { ...row, include: !row.include } : row) ?? null)
  const included = rows?.filter((row) => row.include && row.track).length ?? 0
  const missing = rows?.filter((row) => row.status === 'missing').length ?? 0
  const checking = rows?.filter((row) => row.status === 'check').length ?? 0

  return <div className="page narrow-page playlist-file-import">
    <header className="page-header"><Link className="eyebrow" to="/playlists"><ArrowLeft size={14}/>Playlists</Link><h1>Import a playlist file</h1><p>Load an M3U or M3U8 file from another player. Tomify finds each song in your library and saves the ones it finds as a new playlist.</p></header>
    <label className="button secondary file-pick"><FileUp/>Choose a file<input type="file" accept=".m3u,.m3u8,audio/x-mpegurl,audio/mpegurl,application/vnd.apple.mpegurl" className="sr-only" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void load(file) }}/></label>
    {progress && <p role="status" className="import-progress"><LoaderCircle className="spin"/>{progress}</p>}
    {error && <p role="alert" className="playlist-form-error">{error}</p>}
    {rows && <section aria-label="Songs in the file">
      <div className="file-import-summary"><input value={name} onChange={(event) => setName(event.target.value)} aria-label="Playlist name" maxLength={200} placeholder="Playlist name"/>
        <p>{rows.length - missing - checking} found{checking ? ` · ${checking} to check` : ''}{missing ? ` · ${missing} not in your library` : ''}</p></div>
      <ol className="file-import-list">{rows.map((row, index) => <li key={index} className={row.status}>
        {row.track ? <input type="checkbox" checked={row.include} onChange={() => toggle(index)} aria-label={`Include ${row.entry.title}`}/> : <span className="file-import-gap"/>}
        <span className="file-import-icon" aria-hidden="true">{row.status === 'found' ? <Check/> : row.status === 'check' ? <CircleHelp/> : <AlertTriangle/>}</span>
        <span className="file-import-copy"><strong>{row.entry.title}</strong><small>{row.entry.artists.join(', ') || 'Unknown artist'}{row.entry.album ? ` · ${row.entry.album}` : ''}</small></span>
        <span className="file-import-match">{row.track ? <>{row.status === 'check' ? 'Probably ' : ''}<strong>{row.track.title}</strong><small>{row.track.artist} · {row.track.album}</small></> : <small>Not in your library</small>}</span>
      </li>)}</ol>
      {isAdmin && missing > 0 && <label className="file-import-recovery"><input type="checkbox" checked={sendMissing} onChange={(event) => setSendMissing(event.target.checked)}/>Add the {missing} missing {missing === 1 ? 'song' : 'songs'} to Recovery</label>}
      <div className="hero-actions"><button type="button" className="button primary" disabled={saving || (!included && !(isAdmin && sendMissing))} onClick={() => void save()}>{saving ? <LoaderCircle className="spin"/> : <Plus/>}Create playlist ({included} {included === 1 ? 'song' : 'songs'})</button></div>
    </section>}
  </div>
}

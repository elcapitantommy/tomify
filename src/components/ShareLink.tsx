import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Link2, LoaderCircle, Share2, Trash2 } from 'lucide-react'
import { useApi } from '../lib/api-context'
import { EXPIRY_OPTIONS, expiresLabel, expiryTime, shareErrorMessage, type Expiry } from '../lib/share-links'
import type { ShareLink } from '../lib/navidrome'
import { useLoad } from '../hooks/useLoad'

// "Share link": makes a public Navidrome link for a song, album or playlist that anyone can open in a
// browser and listen to, without a Tomify account. Links can expire and are listed in Settings.
export function ShareLinkButton({ ids, label, variant = 'button' }: { ids: string[]; label: string; variant?: 'button' | 'icon' }) {
  const api = useApi()
  const [open, setOpen] = useState(false)
  const [expiry, setExpiry] = useState<Expiry>('week')
  const [busy, setBusy] = useState(false)
  const [link, setLink] = useState<ShareLink | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const container = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  async function create() {
    setBusy(true); setError(null); setCopied(false)
    try { setLink(await api.createShareLink(ids, label, expiryTime(expiry))) } catch (reason) { setError(shareErrorMessage(reason)) } finally { setBusy(false) }
  }
  async function copy() {
    if (!link) return
    try { await navigator.clipboard.writeText(link.url); setCopied(true) } catch { setError('Copy failed. Select the link and copy it yourself.') }
  }
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

  return <div className="share-link" ref={container}>
    <button type="button" className={variant === 'icon' ? 'share-link-icon' : 'button secondary'} onClick={() => { setOpen(!open); setLink(null); setError(null) }} aria-expanded={open} aria-label={`Share a link to ${label}`} title="Share a link anyone can open">{variant === 'icon' ? <Link2/> : <><Link2/>Share link</>}</button>
    {open && <div className="share-link-menu" role="dialog" aria-label={`Share ${label}`}>
      <strong>Share “{label}”</strong>
      <p>Anyone with the link can listen in their browser, no account needed.</p>
      {!link && <><label><span>Link expires after</span><select value={expiry} onChange={(event) => setExpiry(event.target.value as Expiry)}>{EXPIRY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <button type="button" className="button primary" disabled={busy} onClick={() => void create()}>{busy ? <LoaderCircle className="spin"/> : <Link2/>}Create link</button></>}
      {link && <><input readOnly value={link.url} aria-label="Share link" onFocus={(event) => event.currentTarget.select()}/>
        <div className="share-link-actions"><button type="button" className="button primary" onClick={() => void copy()}>{copied ? <><Check/>Copied</> : <><Copy/>Copy link</>}</button>{canShare && <button type="button" className="button secondary" onClick={() => void navigator.share({ title: label, url: link.url }).catch(() => undefined)}><Share2/>Send…</button>}</div>
        <small>{expiresLabel(link.expires)}. Manage your links in Settings.</small></>}
      {error && <p className="device-error" role="alert">{error}</p>}
    </div>}
  </div>
}

// Settings: the links this account has made, with how often each was opened, and a way to switch one off.
export function SharedLinks() {
  const api = useApi()
  const { data, error, refresh } = useLoad((signal) => api.shareLinks(signal).catch(() => null), [api])
  const [busy, setBusy] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  if (error || !data) return null
  const remove = async (id: string) => {
    setBusy(id); setDeleteError(null)
    try { await api.deleteShareLink(id); refresh() } catch (reason) { setDeleteError(shareErrorMessage(reason)) } finally { setBusy(null) }
  }
  return <section className="settings-card"><h2>Shared links</h2>
    {!data.length && <p className="radio-help">Links you share with <strong>Share link</strong> on an album, playlist or Now Playing appear here.</p>}
    {data.map((share) => <div className="setting-row" key={share.id}><Link2/><span><strong>{share.description || share.entry?.[0]?.title || 'Shared music'}</strong><small><a href={share.url} target="_blank" rel="noreferrer">{share.url}</a> · {expiresLabel(share.expires)} · opened {share.visitCount ?? 0} {share.visitCount === 1 ? 'time' : 'times'}</small></span><button type="button" className="icon-button" disabled={busy !== null} onClick={() => void remove(share.id)} aria-label={`Delete link to ${share.description || 'shared music'}`} title="Delete link">{busy === share.id ? <LoaderCircle className="spin"/> : <Trash2/>}</button></div>)}
    {deleteError && <p className="device-error" role="alert">{deleteError}</p>}
  </section>
}

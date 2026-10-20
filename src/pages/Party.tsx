import { useEffect, useState } from 'react'
import { ItemArtists } from '../components/ArtistLinks'
import { Copy, LoaderCircle, PartyPopper, Save, Share2, ThumbsUp, Trash2, UserX } from 'lucide-react'
import { ErrorState } from '../components/States'
import { partyJoinUrl, type PartyOptions } from '../lib/party'
import { useParty } from '../stores/party'

const cooldowns: [number, string][] = [[0, 'Off'], [30, '30 seconds'], [60, '1 minute'], [120, '2 minutes'], [300, '5 minutes'], [600, '10 minutes']]

// Hosting a party: start one, show its code, and look after the queue guests are building.
export function Party() {
  const { party, queue = [], guests = [], loaded, error, refresh, start, update, end, remove, removeGuest } = useParty()
  const [options, setOptions] = useState<PartyOptions>({ name: 'Tomify Rocks!', cooldownSeconds: 60, maxPerGuest: 3, voting: true })
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => { if (party) setOptions({ name: party.name, cooldownSeconds: party.cooldownSeconds, maxPerGuest: party.maxPerGuest, voting: party.voting }) }, [party?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (name: string, action: () => Promise<void>) => { setBusy(name); setNotice(null); try { await action() } finally { setBusy(null) } }
  const link = party ? partyJoinUrl(party.code) : ''
  async function share() {
    if (navigator.share) { await navigator.share({ title: party?.name, text: `Join ${party?.name} on Tomify with code ${party?.code}`, url: link }).catch(() => undefined); return }
    await navigator.clipboard?.writeText(link).then(() => setNotice('Link copied.'), () => setNotice(link))
  }
  const set = (patch: PartyOptions) => setOptions((current) => ({ ...current, ...patch }))
  const fields = <>
    <label className="smart-rule"><span>Party name</span><input value={options.name ?? ''} maxLength={80} onChange={(event) => set({ name: event.target.value })}/></label>
    <div className="smart-rule-pair">
      <label className="smart-rule"><span>Wait between adds</span><select value={options.cooldownSeconds} onChange={(event) => set({ cooldownSeconds: Number(event.target.value) })}>{cooldowns.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="smart-rule"><span>Tracks each guest can have waiting</span><input type="number" min={1} max={50} value={options.maxPerGuest} onChange={(event) => set({ maxPerGuest: Math.max(1, Number(event.target.value) || 1) })}/></label>
    </div>
    <label className="party-check"><input type="checkbox" checked={options.voting} onChange={(event) => set({ voting: event.target.checked })}/>Guests can vote on what plays next</label>
  </>

  return <div className="page narrow-page"><header className="page-header"><span className="eyebrow"><PartyPopper size={14}/> Party mode</span><h1>{party ? party.name : 'Host a party'}</h1><p>Guests join on their phones with a code and add tracks to the queue. Their tracks play from this device, straight after the current song.</p></header>
    {!loaded && <LoaderCircle className="spin"/>}
    {error && <ErrorState message={error} retry={() => void refresh()}/>}
    {loaded && !party && <form className="smart-editor" onSubmit={(event) => { event.preventDefault(); void act('start', () => start(options)) }}>
      {fields}
      <div><button className="button primary" disabled={busy === 'start'}>{busy === 'start' ? <LoaderCircle className="spin"/> : <PartyPopper/>}Start the party</button></div>
    </form>}
    {party && <>
      <section className="party-code" aria-label="Access code">
        <small>Access code</small><strong>{party.code}</strong>
        <span>{link}</span>
        <div><button type="button" className="button primary" onClick={() => void share()}>{'share' in navigator ? <Share2/> : <Copy/>}Share link</button><button type="button" className="button danger" disabled={busy === 'end'} onClick={() => void act('end', end)}>End party</button></div>
        {notice && <p role="status">{notice}</p>}
      </section>
      <section className="stats-list"><h2>Up next from guests</h2>{queue.length ? <ol className="party-queue">{queue.map((item) => <li key={item.id}>
        <span><strong>{item.track.title}</strong><small><ItemArtists item={item.track}/> · added by {item.guestName}{item.state === 'queued' ? ' · up next' : ''}</small></span>
        {party.voting && <small className="party-votes"><ThumbsUp size={14}/>{item.votes}</small>}
        <button type="button" className="icon-button" aria-label={`Remove ${item.track.title}`} onClick={() => void remove(item.id)}><Trash2/></button>
      </li>)}</ol> : <p className="health-empty">Nothing yet. Guests' tracks appear here as they add them.</p>}</section>
      <section className="stats-list"><h2>Guests ({guests.length})</h2>{guests.length ? <ol className="party-queue">{guests.map((guest) => <li key={guest.id}><span><strong>{guest.name}</strong></span><button type="button" className="icon-button" aria-label={`Remove ${guest.name}`} title="Remove guest and their waiting tracks" onClick={() => void removeGuest(guest.id)}><UserX/></button></li>)}</ol> : <p className="health-empty">No one has joined yet.</p>}</section>
      <form className="smart-editor" onSubmit={(event) => { event.preventDefault(); void act('save', () => update(options)) }}>
        {fields}
        <div><button className="button secondary" disabled={busy === 'save'}>{busy === 'save' ? <LoaderCircle className="spin"/> : <Save/>}Save settings</button></div>
      </form>
    </>}
  </div>
}

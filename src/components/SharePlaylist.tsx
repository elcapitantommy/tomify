import { useState } from 'react'
import { LoaderCircle, Share2 } from 'lucide-react'

interface Props { accounts: string[]; sharedWith: string[]; save: (users: string[]) => Promise<string[]> }

export function SharePlaylist({ accounts, sharedWith, save }: Props) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string[]>(sharedWith)
  const [current, setCurrent] = useState<string[]>(sharedWith)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function toggle(account: string) { setSelected((value) => value.includes(account) ? value.filter((user) => user !== account) : [...value, account]) }
  async function submit() {
    setSaving(true); setError(null)
    try { const saved = await save(selected); setCurrent(saved); setSelected(saved); setOpen(false) } catch (reason) { setError(reason instanceof Error ? reason.message : 'Sharing could not be saved.') } finally { setSaving(false) }
  }

  return <div className="share-playlist">
    <button className="button secondary" aria-expanded={open} onClick={() => { setSelected(current); setError(null); setOpen((value) => !value) }}><Share2/>{current.length ? `Shared with ${current.length}` : 'Share'}</button>
    {open && <div className="share-playlist-panel" role="group" aria-label="Share with">
      <strong>Share with</strong>
      {accounts.length ? accounts.map((account) => <label key={account}><input type="checkbox" checked={selected.includes(account)} onChange={() => toggle(account)}/>{account}</label>)
        : <small>Other accounts appear here once they have signed in to Tomify.</small>}
      {error && <small role="alert" className="share-playlist-error">{error}</small>}
      <div><button className="button secondary" onClick={() => setOpen(false)}>Cancel</button><button className="button primary" disabled={saving || !accounts.length} onClick={() => void submit()}>{saving && <LoaderCircle className="spin"/>}Save</button></div>
    </div>}
  </div>
}

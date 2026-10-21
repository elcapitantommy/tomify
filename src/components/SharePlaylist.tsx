import { useState } from 'react'
import { LoaderCircle, Share2 } from 'lucide-react'

type Saved = string[] | { sharedWith: string[]; editors: string[] }
// `allowEditing` offers a "Can edit" switch per person (Navidrome playlists only).
interface Props { accounts: string[]; sharedWith: string[]; editors?: string[]; allowEditing?: boolean; save: (users: string[], editors: string[]) => Promise<Saved> }

export function SharePlaylist({ accounts, sharedWith, editors = [], allowEditing = false, save }: Props) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string[]>(sharedWith)
  const [current, setCurrent] = useState<string[]>(sharedWith)
  const [selectedEditors, setSelectedEditors] = useState<string[]>(editors)
  const [currentEditors, setCurrentEditors] = useState<string[]>(editors)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function toggle(account: string) {
    if (selected.includes(account)) { setSelected(selected.filter((user) => user !== account)); setSelectedEditors(selectedEditors.filter((user) => user !== account)) }
    else setSelected([...selected, account])
  }
  function toggleEditor(account: string) { setSelectedEditors((value) => value.includes(account) ? value.filter((user) => user !== account) : [...value, account]) }
  async function submit() {
    setSaving(true); setError(null)
    try {
      const saved = await save(selected, allowEditing ? selectedEditors.filter((user) => selected.includes(user)) : [])
      const users = Array.isArray(saved) ? saved : saved.sharedWith
      const kept = Array.isArray(saved) ? [] : saved.editors
      setCurrent(users); setSelected(users); setCurrentEditors(kept); setSelectedEditors(kept); setOpen(false)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Sharing could not be saved.') } finally { setSaving(false) }
  }

  return <div className="share-playlist">
    <button className="button secondary" aria-expanded={open} onClick={() => { setSelected(current); setSelectedEditors(currentEditors); setError(null); setOpen((value) => !value) }}><Share2/>{current.length ? `Shared with ${current.length}` : 'Share'}</button>
    {open && <div className="share-playlist-panel" role="group" aria-label="Share with">
      <strong>Share with</strong>
      {accounts.length ? accounts.map((account) => <div key={account} className="share-playlist-person"><label><input type="checkbox" checked={selected.includes(account)} onChange={() => toggle(account)}/>{account}</label>
        {allowEditing && selected.includes(account) && <label className="share-playlist-edit"><input type="checkbox" checked={selectedEditors.includes(account)} onChange={() => toggleEditor(account)} aria-label={`Let ${account} edit`}/>Can edit</label>}</div>)
        : <small>Other accounts appear here once they have signed in to Tomify.</small>}
      {allowEditing && selected.length > 0 && <small>People who can edit can add, remove and reorder songs. Only you can rename or delete it.</small>}
      {error && <small role="alert" className="share-playlist-error">{error}</small>}
      <div><button className="button secondary" onClick={() => setOpen(false)}>Cancel</button><button className="button primary" disabled={saving || !accounts.length} onClick={() => void submit()}>{saving && <LoaderCircle className="spin"/>}Save</button></div>
    </div>}
  </div>
}

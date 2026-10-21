import { useEffect, useState } from 'react'
import { Bell, BellOff, LoaderCircle, Send } from 'lucide-react'
import { currentSubscription, needsHomeScreen, pushApi, pushSupported, subscribe, type PushTopic } from '../lib/push'

const TOPICS: Array<{ topic: PushTopic; label: string; detail: string; admin?: boolean }> = [
  { topic: 'new-releases', label: 'New releases', detail: 'When an artist in the library puts out something new (checked once a day).' },
  { topic: 'recovery', label: 'Recovery downloads', detail: 'When a Recovery download has finished importing, or failed.', admin: true },
]

// Settings card: turns push notifications on for this device and picks what they're for.
export function Notifications({ admin }: { admin: boolean }) {
  const [topics, setTopics] = useState<PushTopic[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)
  const supported = pushSupported()
  const homeScreen = needsHomeScreen()

  useEffect(() => {
    if (!supported) return
    let active = true
    void (async () => {
      try {
        const subscription = await currentSubscription()
        const state = subscription ? await pushApi.state(subscription.endpoint) : null
        if (active) setTopics(state?.topics ?? [])
      } catch { if (active) setTopics([]) }
    })()
    return () => { active = false }
  }, [supported])

  async function toggle(topic: PushTopic) {
    const next = topics?.includes(topic) ? topics.filter((item) => item !== topic) : [...(topics ?? []), topic]
    setBusy(true); setMessage(null)
    try {
      if (!next.length) {
        const subscription = await currentSubscription()
        if (subscription) { await pushApi.save(subscription.toJSON(), []); await subscription.unsubscribe() }
        setTopics([])
        return
      }
      if (Notification.permission !== 'granted' && await Notification.requestPermission() !== 'granted') {
        setMessage({ text: 'Notifications are blocked for Tomify. Allow them in your browser or phone settings, then try again.', error: true })
        return
      }
      const { publicKey } = await pushApi.state()
      if (!publicKey) throw new Error('The server could not set up notifications.')
      const subscription = await subscribe(publicKey)
      setTopics((await pushApi.save(subscription.toJSON(), next)).topics)
    } catch (reason) { setMessage({ text: reason instanceof Error ? reason.message : 'Notifications could not be changed.', error: true }) }
    finally { setBusy(false) }
  }

  async function test() {
    setBusy(true); setMessage(null)
    try { const { sent } = await pushApi.test(); setMessage({ text: sent ? 'Test sent. It should appear in a few seconds.' : 'Nothing was sent. Turn a notification on first.', error: !sent }) }
    catch (reason) { setMessage({ text: reason instanceof Error ? reason.message : 'The test could not be sent.', error: true }) }
    finally { setBusy(false) }
  }

  return <section className="settings-card notifications-card"><h2>Notifications</h2>
    {homeScreen ? <p className="settings-note"><BellOff size={16}/>On iPhone and iPad, add Tomify to your Home Screen first (Share, then Add to Home Screen), open it from there, and turn notifications on here.</p>
      : !supported ? <p className="settings-note"><BellOff size={16}/>This browser can't show notifications from Tomify.</p>
      : <>
        <p className="settings-note">Notifications are for this device. Turn them on separately on each phone or computer.</p>
        {TOPICS.filter((item) => admin || !item.admin).map((item) => <label key={item.topic} className="setting-row notification-topic"><Bell/><span><strong>{item.label}</strong><small>{item.detail}</small></span>
          {topics === null ? <LoaderCircle className="spin"/> : <input type="checkbox" role="switch" checked={topics.includes(item.topic)} disabled={busy} onChange={() => void toggle(item.topic)} aria-label={`${item.label} notifications`}/>}</label>)}
        {Boolean(topics?.length) && <button type="button" className="button secondary" disabled={busy} onClick={() => void test()}>{busy ? <LoaderCircle className="spin"/> : <Send/>}Send a test</button>}
      </>}
    {message && <p role={message.error ? 'alert' : 'status'} className={message.error ? 'notification-error' : 'notification-status'}>{message.text}</p>}
  </section>
}

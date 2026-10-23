import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { TomifinApp } from './TomifinApp'
import './tomifin.css'

// Tomifin Downloader is its own app at its own address, with its own Jellyfin sign-in. It has no service worker, and
// removes any left over on this address (Tomify's, if Tomify's app was ever served here), so the page is never stale.
if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.getRegistrations().then((registrations) => Promise.all(registrations.map((registration) => registration.unregister()))).catch(() => undefined)
}

createRoot(document.getElementById('root')!).render(<StrictMode><TomifinApp/></StrictMode>)

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { TomifinApp } from './TomifinApp'
import './tomifin.css'

// Tomifin Downloader is its own page at /tomifin/. It shares Tomify's sign-in (the same saved session) but not its
// shell, player or service worker registration.
createRoot(document.getElementById('root')!).render(<StrictMode><TomifinApp/></StrictMode>)

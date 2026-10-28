import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { TomTubeApp } from './App'
import './tomtube.css'

// TomTube is its own home-screen app at /tomtube/ on Tomify's address. It has no service worker of
// its own (pages and media always come from the network); Tomify's service worker leaves /tomtube/ alone.
createRoot(document.getElementById('root')!).render(<StrictMode><TomTubeApp/></StrictMode>)

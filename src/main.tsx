import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './App'
import './styles.css'
import { applyTheme, useTheme, watchSystemTheme } from './stores/theme'
import { restoreDesktopWindow } from './stores/miniPlayer'

applyTheme(useTheme.getState().mode)
watchSystemTheme()
restoreDesktopWindow()
registerSW({ immediate: true })
createRoot(document.getElementById('root')!).render(<StrictMode><App/></StrictMode>)

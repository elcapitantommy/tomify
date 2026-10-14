import { createContext, useContext, useMemo } from 'react'
import { NavidromeClient } from './navidrome'
import { useAuth } from '../stores/auth'

const ApiContext = createContext<NavidromeClient | null>(null)
export function ApiProvider({ children }: { children: React.ReactNode }) { const session = useAuth((s) => s.session); const api = useMemo(() => session ? new NavidromeClient(session) : null, [session]); return <ApiContext.Provider value={api}>{children}</ApiContext.Provider> }
// eslint-disable-next-line react-refresh/only-export-components
export function useApi() { const api = useContext(ApiContext); if (!api) throw new Error('Navidrome API used without a session'); return api }

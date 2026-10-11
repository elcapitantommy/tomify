import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createAuthSession, NavidromeClient, normaliseServerUrl, type AuthSession } from '../lib/navidrome'

interface AuthState { session: AuthSession | null; status: 'signed-out' | 'checking' | 'signed-in'; error: string | null; login(serverUrl: string, username: string, password: string): Promise<void>; logout(): void; validate(): Promise<void> }

export const useAuth = create<AuthState>()(persist((set, get) => ({
  session: null, status: 'signed-out', error: null,
  login: async (serverUrl, username, password) => {
    set({ status: 'checking', error: null })
    try { const session = createAuthSession(serverUrl, username, password); await new NavidromeClient(session).ping(); set({ session, status: 'signed-in' }) }
    catch (error) { set({ session: null, status: 'signed-out', error: error instanceof Error ? error.message : 'Login failed.' }); throw error }
  },
  logout: () => set({ session: null, status: 'signed-out', error: null }),
  validate: async () => { const session = get().session; if (!session) return; set({ status: 'checking' }); try { await new NavidromeClient(session).ping(); set({ status: 'signed-in', error: null }) } catch { set({ status: 'signed-in', error: 'The music server is unavailable. Your session has been kept.' }) } },
}), { name: 'tomify-auth', partialize: ({ session }) => ({ session }), onRehydrateStorage: () => (state) => { if (state?.session) { state.session.serverUrl = normaliseServerUrl(state.session.serverUrl); state.status = 'signed-in' } } }))

import { useEffect } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { ApiProvider } from './lib/api-context'
import { useAuth } from './stores/auth'
import { useReleaseMetadata } from './stores/releaseMetadata'
import { useAlbumArtwork } from './stores/albumArtwork'
import { Login } from './components/Login'
import { AppShell } from './components/AppShell'
import { Home } from './pages/Home'
import { Artists } from './pages/Artists'
import { ArtistDetail } from './pages/ArtistDetail'
import { Albums } from './pages/Albums'
import { AlbumDetail } from './pages/AlbumDetail'
import { Search } from './pages/Search'
import { Playlists } from './pages/Playlists'
import { PlaylistDetail } from './pages/PlaylistDetail'
import { MixDetail } from './pages/MixDetail'
import { SpotifyPlaylistImport } from './pages/SpotifyPlaylistImport'
import { ImportedPlaylistDetail } from './pages/ImportedPlaylistDetail'
import { Favourites } from './pages/Favourites'
import { Downloads } from './pages/Downloads'
import { Recovery } from './pages/Recovery'
import { Settings } from './pages/Settings'
import { LibraryHealth } from './pages/LibraryHealth'
import { NotFound } from './pages/NotFound'

export default function App() {
  const session = useAuth((s) => s.session)
  const validate = useAuth((s) => s.validate)
  const loadReleaseMetadata = useReleaseMetadata((s) => s.load)
  const loadAlbumArtwork = useAlbumArtwork((s) => s.load)
  useEffect(() => { if (session) { void validate(); void loadReleaseMetadata(); void loadAlbumArtwork() } }, [session, validate, loadReleaseMetadata, loadAlbumArtwork])
  if (!session) return <Login/>
  return <ApiProvider><BrowserRouter><Routes><Route element={<AppShell/>}><Route index element={<Home/>}/><Route path="artists" element={<Artists/>}/><Route path="artists/:id" element={<ArtistDetail/>}/><Route path="albums" element={<Albums/>}/><Route path="albums/:id" element={<AlbumDetail/>}/><Route path="search" element={<Search/>}/><Route path="playlists" element={<Playlists/>}/><Route path="playlists/import/spotify" element={<SpotifyPlaylistImport/>}/><Route path="playlists/imported/:id" element={<ImportedPlaylistDetail/>}/><Route path="playlists/:id" element={<PlaylistDetail/>}/><Route path="mixes/:id" element={<MixDetail/>}/><Route path="favourites" element={<Favourites/>}/><Route path="downloads" element={<Downloads/>}/><Route path="recovery" element={<Recovery/>}/><Route path="library-health" element={<LibraryHealth/>}/><Route path="settings" element={<Settings/>}/><Route path="*" element={<NotFound/>}/></Route></Routes></BrowserRouter></ApiProvider>
}

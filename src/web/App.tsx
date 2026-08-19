import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AppShell } from './components/AppShell'
import { ArchiveProvider } from './context/ArchiveContext'
import { AccessCheckPage } from './pages/AccessCheckPage'
import { AlbumDetailPage } from './pages/AlbumDetailPage'
import { AlbumsPage } from './pages/AlbumsPage'
import { CollectionPage } from './pages/CollectionPage'
import { DiscoverPage } from './pages/DiscoverPage'
import { PlacesPage } from './pages/PlacesPage'
import { QueuePage } from './pages/QueuePage'
import { SettingsPage } from './pages/SettingsPage'
import { TimelinePage } from './pages/TimelinePage'

export default function App() {
  return <BrowserRouter><ArchiveProvider><Routes><Route element={<AppShell />}>
    <Route path="/" element={<TimelinePage />} />
    <Route path="/access-check" element={<AccessCheckPage />} />
    <Route path="/discover" element={<DiscoverPage />} />
    <Route path="/people" element={<CollectionPage type="people" />} />
    <Route path="/places" element={<PlacesPage />} />
    <Route path="/albums" element={<AlbumsPage />} />
    <Route path="/albums/:id" element={<AlbumDetailPage />} />
    <Route path="/videos" element={<CollectionPage type="videos" />} />
    <Route path="/files" element={<CollectionPage type="files" />} />
    <Route path="/favorites" element={<CollectionPage type="favorites" />} />
    <Route path="/queue" element={<QueuePage />} />
    <Route path="/settings" element={<SettingsPage />} />
    <Route path="*" element={<TimelinePage />} />
  </Route></Routes></ArchiveProvider></BrowserRouter>
}

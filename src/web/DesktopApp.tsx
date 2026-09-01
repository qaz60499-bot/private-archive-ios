import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AppShell } from './components/AppShell'
import { AuthGate } from './components/AuthGate'
import { TelegramUserGroupSyncAgent } from './components/TelegramUserGroupSyncAgent'
import { ArchiveProvider } from './context/ArchiveContext'
import { AuthProvider } from './context/AuthContext'
import { AccessCheckPage } from './pages/AccessCheckPage'
import { ActivityPage } from './pages/ActivityPage'
import { AlbumDetailPage } from './pages/AlbumDetailPage'
import { ArchivePage } from './pages/ArchivePage'
import { AlbumsPage } from './pages/AlbumsPage'
import { CollectionPage } from './pages/CollectionPage'
import { DiscoverPage } from './pages/DiscoverPage'
import { PlacesPage } from './pages/PlacesPage'
import { QueuePage } from './pages/QueuePage'
import { RecentPage } from './pages/RecentPage'
import { SettingsPage } from './pages/SettingsPage'
import { TrashPage } from './pages/TrashPage'
import { TimelinePage } from './pages/TimelinePage'

export default function DesktopApp() {
  return <BrowserRouter><AuthProvider><AuthGate><ArchiveProvider><TelegramUserGroupSyncAgent /><Routes><Route element={<AppShell />}>
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
    <Route path="/recent" element={<RecentPage />} />
    <Route path="/archive" element={<ArchivePage />} />
    <Route path="/trash" element={<TrashPage />} />
    <Route path="/activity" element={<ActivityPage />} />
    <Route path="/queue" element={<QueuePage />} />
    <Route path="/settings" element={<SettingsPage />} />
    <Route path="*" element={<TimelinePage />} />
  </Route></Routes></ArchiveProvider></AuthGate></AuthProvider></BrowserRouter>
}

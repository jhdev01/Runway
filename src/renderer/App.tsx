import React, { useEffect } from 'react';
import { TopBar } from './components/TopBar';
import { LiveView } from './views/LiveView';
import { PlaylistsView } from './views/PlaylistsView';
import { ScheduleView } from './views/ScheduleView';
import { LibraryView } from './views/LibraryView';
import { ActionsView } from './views/ActionsView';
import { EditorView } from './views/EditorView';
import { SettingsView } from './views/SettingsView';
import { useAppStore } from './state/store';
import { EnginesProvider } from './state/engines';

import './styles/layout.css';
import './styles/live.css';
import './styles/playlists.css';
import './styles/schedule.css';
import './styles/settings.css';
import './styles/editor.css';
import './styles/library.css';
import './styles/actions.css';

// Detect ?mock=1 — when true, the store gets pre-populated with mock
// state and the engine providers run in a no-op mode. Use this URL
// when iterating on Live-view layout in a browser tab without
// affecting the real Electron session.
const isMockMode = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).get('mock') === '1';

export function App() {
  const view = useAppStore(s => s.view);
  const setView = useAppStore(s => s.setView);
  const loadConfig = useAppStore(s => s.loadConfig);
  const configLoaded = useAppStore(s => s.configLoaded);

  useEffect(() => {
    if (isMockMode) {
      void import('./state/mockState').then(m => m.installMockState());
    } else {
      void loadConfig();
    }
  }, [loadConfig]);

  // Wire native menu items (Mac menu bar / Windows menu bar) to renderer
  // actions. Menu items dispatched from main.ts via webContents.send().
  useEffect(() => {
    if (isMockMode || !window.runway?.app) return;
    const unsubNav = window.runway.app.onMenuNavigate((path: string) => {
      const validViews: Array<typeof view> = [
        'live', 'schedule', 'playlists', 'library', 'actions', 'editor', 'settings',
      ];
      if ((validViews as string[]).includes(path)) {
        setView(path as typeof view);
      }
    });
    const unsubChangelog = window.runway.app.onMenuOpenChangelog(() => {
      void window.runway.app.openChangelog();
    });
    return () => {
      unsubNav();
      unsubChangelog();
    };
  }, [setView]);

  if (!configLoaded) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100vh', color: 'var(--text-faint)', fontSize: 14,
      }}>
        Loading...
      </div>
    );
  }

  return (
    <EnginesProvider>
      <div className="app">
        <TopBar />
        <div className="view-container">
          {view === 'live' && <LiveView />}
          {view === 'playlists' && <PlaylistsView />}
          {view === 'library' && <LibraryView />}
          {view === 'schedule' && <ScheduleView />}
          {view === 'actions' && <ActionsView />}
          {view === 'editor' && <EditorView />}
          {view === 'settings' && <SettingsView />}
        </div>
      </div>
    </EnginesProvider>
  );
}

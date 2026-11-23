import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AuthGate } from './auth/AuthGate';
import { installSessionWatcher } from './lib/api';
import { PublicRecapPage } from './pages/PublicRecapPage';
import './index.css';

installSessionWatcher();

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

// Shared recap links (/r/<token>) work without signing in and show nothing else.
const shared = window.location.pathname.match(/^\/r\/([A-Za-z0-9_-]+)$/);

createRoot(root).render(
  <StrictMode>
    {shared ? (
      <PublicRecapPage token={shared[1]!} />
    ) : (
      <AuthGate>
        <App />
      </AuthGate>
    )}
  </StrictMode>,
);

import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App.js';
import { currentUser, loadAuthConfig, onSessionChange } from './auth.js';
import { Login } from './components/Login.js';
import { loadConfig } from './config.js';

const config = loadConfig();

/** The dashboard for a signed-in user; the sign-in form for everyone else. */
function Root() {
  const [ready, setReady] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [user, setUser] = useState(currentUser());

  useEffect(() => onSessionChange(() => setUser(currentUser())), []);
  useEffect(() => {
    loadAuthConfig().then(() => setReady('ready'), () => setReady('failed'));
  }, []);

  if (ready === 'loading') return <main className="login-page" aria-busy="true" />;
  if (ready === 'failed') {
    return (
      <main className="login-page">
        <p id="login-unavailable" className="login-card login-error" role="alert">The sign-in service is unavailable. Reload the page to try again.</p>
      </main>
    );
  }
  // key: a different user starts from a fresh dashboard
  return user ? <App key={user} config={config} /> : <Login env={config.env} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);

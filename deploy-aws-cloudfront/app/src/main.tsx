import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App.js';
import { loadConfig } from './config.js';

// DEMO BRANCH (demo/break-frontend) - DO NOT MERGE.
// A bad release that only shows on the live site: the page keeps polling a translations file that
// was never added to the release. The integration distribution (dev-integration.…) skips it, so CI's
// smoke and end-to-end tests pass and the release goes live on frontend-user-dev. There, every open
// tab requests the missing file every 2 s: CloudFront answers 403 (the bucket has no such object),
// the 4xx rate alarm fires, and the rollback service switches the distribution back to the previous
// verified release. Keep https://dev.rollback.ionuteliantudor.com open in a browser to drive it.
const onLiveSite = !location.hostname.includes('integration') && location.hostname !== 'localhost';
if (onLiveSite) {
  const loadTranslations = () => fetch(`/locales/${navigator.language || 'en'}.json`, { cache: 'no-store' }).catch(() => undefined);
  loadTranslations();
  setInterval(loadTranslations, 2_000);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App config={loadConfig()} />
  </StrictMode>,
);

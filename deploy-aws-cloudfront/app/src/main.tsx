import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App.js';
import { loadConfig } from './config.js';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App config={loadConfig()} />
  </StrictMode>,
);

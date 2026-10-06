// Shared page setup for index.html and app.html.
import { AppConfig, loadConfig } from './config.js';
import { CognitoClient, createCognitoClient } from './cognito.js';
import { createSessionStore, SessionStore } from './session.js';

export interface PageContext {
  config: AppConfig;
  cognito: CognitoClient;
  sessions: SessionStore;
}

export const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Missing element ${selector}`);
  return el;
};

/** Loads the config, shows the release id in the footer, or shows a config error and returns undefined. */
export function setupPage(): PageContext | undefined {
  try {
    const config = loadConfig();
    $('#release').textContent = config.releaseId;
    return {
      config,
      cognito: createCognitoClient({ region: config.region, clientId: config.userPoolClientId }),
      sessions: createSessionStore(sessionStorage),
    };
  } catch (err) {
    const main = $('main');
    main.replaceChildren();
    const error = document.createElement('p');
    error.className = 'error';
    error.setAttribute('role', 'alert');
    error.textContent = `This build is misconfigured: ${(err as Error).message}`;
    main.append(error);
    return undefined;
  }
}

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

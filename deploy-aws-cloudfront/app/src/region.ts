// The region picked at the top of the page. The API Gateway and Lambda panels read it (api.ts adds
// ?region=<code> to their calls); undefined means the dashboard's own region, the API's default.
// Remembered per browser; the page works the same when storage is unavailable.
import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'rollback-dashboard-region';

function readStored(): string | undefined {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

let region = readStored();
const listeners = new Set<() => void>();

/** The picked region, or undefined for the dashboard's own region. */
export const currentRegion = (): string | undefined => region;

/** Picks a region; undefined goes back to the dashboard's own. */
export function setRegion(next: string | undefined) {
  if (next === region) return;
  region = next;
  try {
    if (next) localStorage.setItem(STORAGE_KEY, next);
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* remembered for this page only */ }
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** The picked region (undefined: the dashboard's own), re-rendering when it changes. */
export const useRegion = () => useSyncExternalStore(subscribe, currentRegion);

/** Adds ?region=<code> to a URL of a regional read, unless it is the dashboard's own region. */
export const withRegion = (url: string): string =>
  (region ? `${url}${url.includes('?') ? '&' : '?'}region=${encodeURIComponent(region)}` : url);

// Loading data from the dashboard API, and showing its dates.
import { useEffect, useState } from 'react';
import type { TableMessage } from './ui.js';

export interface Loaded<T> {
  /** the last data that loaded; kept on screen while refreshing */
  data?: T;
  loading: boolean;
  failed: boolean;
}

/** Loads with `load` whenever `key` changes; data of another key is dropped, not shown stale. */
export function useLoad<T>(key: string | undefined, load: (signal: AbortSignal) => Promise<T>): Loaded<T> {
  const [loaded, setLoaded] = useState<Loaded<T> & { key?: string }>({ loading: true, failed: false });
  useEffect(() => {
    if (key === undefined) return;
    const controller = new AbortController();
    setLoaded((current) => ({ ...(current.key?.split('#')[0] === key.split('#')[0] ? current : {}), key, loading: true, failed: false }));
    load(controller.signal).then(
      (data) => setLoaded({ key, data, loading: false, failed: false }),
      (err) => {
        if (controller.signal.aborted) return;
        console.warn(`Could not load ${key}`, err);
        setLoaded((current) => ({ ...current, loading: false, failed: true }));
      },
    );
    return () => controller.abort();
    // `key` identifies what `load` loads, so it is the only dependency
  }, [key]);
  return loaded;
}

const formatDate = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
export const DateCell = ({ iso }: { iso?: string }) => (iso ? <time dateTime={iso}>{formatDate.format(new Date(iso))}</time> : <>—</>);

/** data-state of a panel, for tests. */
export const loadState = ({ loading, failed }: Loaded<unknown>) => (loading ? 'loading' : failed ? 'error' : 'ready');

/** The message row of a table while its data is missing, else undefined. */
export const pendingMessage = (loaded: Loaded<unknown>, what: string): TableMessage | undefined =>
  loaded.failed && !loaded.data ? { text: `Could not load ${what}. Try refreshing.`, error: true }
    : !loaded.data ? { text: 'Loading…' } : undefined;

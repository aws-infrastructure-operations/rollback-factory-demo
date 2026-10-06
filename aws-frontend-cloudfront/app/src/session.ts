import { CognitoClient, CognitoError, Tokens } from './cognito.js';

/** The part of Web Storage the session needs (sessionStorage in the browser, a Map in tests). */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface Session extends Tokens {
  username: string;
}

const STORAGE_KEY = 'frontend-user.session';
/** Refresh a little before the ID token expires, so a request never goes out with a dead token. */
const EXPIRY_SKEW_MS = 60_000;

export function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  if (!payload) throw new Error('Not a JWT');
  const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Expiry of a JWT in epoch milliseconds, 0 when it can't be read. */
export function tokenExpiresAt(token: string): number {
  try {
    const { exp } = decodeJwtPayload(token);
    return typeof exp === 'number' ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

export function createSessionStore(storage: KeyValueStore, now: () => number = Date.now) {
  return {
    load(): Session | undefined {
      try {
        const session = JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null');
        return session?.idToken && session?.username ? session : undefined;
      } catch {
        return undefined;
      }
    },
    save(session: Session) {
      storage.setItem(STORAGE_KEY, JSON.stringify(session));
    },
    clear() {
      storage.removeItem(STORAGE_KEY);
    },
    isFresh(session: Session) {
      return tokenExpiresAt(session.idToken) - EXPIRY_SKEW_MS > now();
    },
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;

/**
 * The stored session with a usable ID token, refreshing it when it is about to expire.
 * Returns undefined (and forgets the session) when the user has to sign in again;
 * network errors are rethrown so a flaky connection doesn't sign the user out.
 */
export async function getValidSession(store: SessionStore, cognito: CognitoClient): Promise<Session | undefined> {
  const session = store.load();
  if (!session) return undefined;
  if (store.isFresh(session)) return session;
  if (!session.refreshToken) {
    store.clear();
    return undefined;
  }
  try {
    const refreshed: Session = { ...session, ...(await cognito.refresh(session.refreshToken)) };
    store.save(refreshed);
    return refreshed;
  } catch (err) {
    if (!(err instanceof CognitoError)) throw err;
    store.clear();
    return undefined;
  }
}

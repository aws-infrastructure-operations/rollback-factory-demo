// Client for api-user-<env>: GET / POST on /users and /messages, authorized with the Cognito ID token.

export const RESOURCES = ['users', 'messages'] as const;
export type Resource = (typeof RESOURCES)[number];

export interface ApiResponse {
  status: number;
  ok: boolean;
  /** Parsed JSON, or the raw text when the body isn't JSON. */
  body: unknown;
}

export interface ApiClientOptions {
  /** The stage URL from the API stack output ApiUrl, e.g. https://abc.execute-api.eu-central-1.amazonaws.com/v1/ */
  baseUrl: string;
  /** The Cognito authorizer reads the raw ID token from the Authorization header (no "Bearer"). */
  getIdToken: () => Promise<string>;
  fetch?: typeof fetch;
}

export function createApiClient({ baseUrl, getIdToken, fetch: fetchFn = fetch }: ApiClientOptions) {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;

  const request = async (method: 'GET' | 'POST', resource: Resource, message?: string): Promise<ApiResponse> => {
    const headers: Record<string, string> = { Authorization: await getIdToken() };
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    const res = await fetchFn(new URL(resource, base).toString(), {
      method,
      headers,
      body: method === 'POST' ? JSON.stringify({ message }) : undefined,
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // not JSON, keep the text
    }
    return { status: res.status, ok: res.ok, body };
  };

  return {
    get: (resource: Resource) => request('GET', resource),
    post: (resource: Resource, message: string) => request('POST', resource, message),
  };
}

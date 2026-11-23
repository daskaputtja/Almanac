import type { Permission, Role } from '../../../shared/permissions';

/** Fired when the server says the session has ended, so the app can show the sign-in page. */
export const SIGNED_OUT_EVENT = 'almanac:signed-out';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Watch every API response: a 401 outside the sign-in routes means the
 * session has expired or been signed out elsewhere.
 */
export function installSessionWatcher(): void {
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const res = await original(input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (res.status === 401 && url.includes('/api/') && !url.includes('/api/auth/')) {
      window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
    }
    return res;
  };
}

/** Call the API. Requests that change something carry the header the server requires. */
export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') headers['X-Almanac'] = '1';
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(path, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    credentials: 'same-origin',
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // Empty or non-JSON body.
  }
  if (!res.ok) {
    const message = (data as { error?: string } | null)?.error ?? `Almanac returned ${res.status}`;
    throw new ApiError(message, res.status);
  }
  return data as T;
}

export interface AuthState {
  setupRequired: boolean;
  stage: 'totp' | 'enroll' | 'full' | null;
  user: { username: string } | null;
  role: Role | null;
  permissions: Permission[];
  recoveryCodesLeft: number | null;
}

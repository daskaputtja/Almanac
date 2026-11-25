import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as SecureStore from 'expo-secure-store';
import type { AppServerInfo } from '../../../shared/app';

/**
 * Talking to one Almanac server. The address and the sign-in token are kept
 * in the phone's secure storage (the Keychain on iPhone, Keystore on Android).
 */
const SERVER_KEY = 'almanac.server';
const TOKEN_KEY = 'almanac.token';
const TIMEOUT_MS = 20_000;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

let server: string | null = null;
let token: string | null = null;
let onSignedOut: (() => void) | null = null;

const appVersion = Constants.expoConfig?.version ?? '1.0';
const userAgent = `Almanac app/${appVersion} (${Device.modelName ?? Device.osName ?? 'phone'})`;

export async function loadCredentials(): Promise<{ server: string | null; token: string | null }> {
  server = await SecureStore.getItemAsync(SERVER_KEY);
  token = await SecureStore.getItemAsync(TOKEN_KEY);
  return { server, token };
}

export async function setServer(url: string | null): Promise<void> {
  server = url;
  if (url) await SecureStore.setItemAsync(SERVER_KEY, url);
  else await SecureStore.deleteItemAsync(SERVER_KEY);
}

export async function setToken(value: string | null): Promise<void> {
  token = value;
  if (value) await SecureStore.setItemAsync(TOKEN_KEY, value);
  else await SecureStore.deleteItemAsync(TOKEN_KEY);
}

export function currentServer(): string | null {
  return server;
}

/** Called when the server says the sign-in has ended (signed out in Settings, or expired). */
export function whenSignedOut(callback: () => void): void {
  onSignedOut = callback;
}

/** "almanac.example.com" → "https://almanac.example.com"; drops a trailing slash. */
export function normaliseServer(input: string): string {
  let value = input.trim();
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  const url = new URL(value);
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

async function request(base: string, path: string, init: RequestInit & { auth?: string | null } = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Almanac-Client': 'app',
    'User-Agent': userAgent,
    ...((init.headers as Record<string, string>) ?? {}),
  };
  const bearer = init.auth === undefined ? token : init.auth;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  try {
    return await fetch(`${base}${path}`, { ...init, headers, signal: controller.signal });
  } catch {
    throw new ApiError('Couldn’t reach your Almanac. Check the address and your connection.', 0);
  } finally {
    clearTimeout(timer);
  }
}

/** Call the API as the signed-in user. */
export async function api<T>(path: string, options: { method?: string; body?: unknown; auth?: string | null } = {}): Promise<T> {
  if (!server) throw new ApiError('No Almanac server set.', 0);
  const res = await request(server, path, {
    method: options.method ?? 'GET',
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    auth: options.auth,
  });
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (res.status === 401 && options.auth === undefined && token) onSignedOut?.();
  if (!res.ok) throw new ApiError(data?.error ?? `Almanac answered ${res.status}`, res.status);
  return data as T;
}

/** Check an address is an Almanac before asking anyone to sign in. */
export async function checkServer(base: string): Promise<AppServerInfo> {
  const res = await request(base, '/api/app/info', { auth: null });
  const info = (await res.json().catch(() => null)) as AppServerInfo | null;
  if (res.status === 404 || info?.app !== 'almanac') {
    throw new ApiError('That address doesn’t look like an Almanac, or it needs updating (sudo almanac-update).', res.status);
  }
  return info;
}

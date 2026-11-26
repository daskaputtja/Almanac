/**
 * Suspending and unsuspending Silo services through WHMCS's own API, so a
 * WHMCS owner doesn't need anything installed for Almanac. WHMCS runs the
 * product's provisioning module, which is what turns the Silo account off.
 *
 * API: POST {WHMCS}/includes/api.php, form-encoded, with identifier, secret,
 * action and responsetype=json (plus accesskey if WHMCS asks for one).
 */

export type WhmcsMatch = 'username' | 'email' | 'username_or_email';

export interface WhmcsSettings {
  /** WHMCS's own address, e.g. https://billing.example.com (or …/whmcs). */
  url: string;
  identifier: string;
  secret: string;
  /** Only needed if WHMCS restricts the API by IP and Almanac's server isn't allowed. */
  accessKey: string | null;
  match: WhmcsMatch;
  /** WHMCS product IDs that are Silo plans. Empty: any of the customer's services. */
  productIds: number[];
}

export interface WhmcsCustomer {
  username: string;
  email: string | null;
}

interface WhmcsService {
  id: number;
  clientid: number;
  pid: number;
  name?: string;
  status: string;
  username?: string;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class WhmcsError extends Error {
  constructor(
    message: string,
    readonly notFound = false,
  ) {
    super(message);
  }
}

export class WhmcsClient {
  constructor(
    private readonly settings: WhmcsSettings,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  /** Check the address and credentials work. */
  async test(): Promise<string> {
    const r = await this.call<{ totalresults?: number | string }>('GetClientsProducts', { limitnum: '1' });
    return `Connected to WHMCS (${Number(r.totalresults ?? 0).toLocaleString('en')} services).`;
  }

  /** Suspend the customer's Silo service(s). Returns a message for the notes. */
  async suspend(customer: WhmcsCustomer, reason: string): Promise<string> {
    const all = await this.found(customer);
    const services = all.filter((s) => s.status === 'Active');
    if (!services.length) return `Nothing to do: ${describe(all)} ${all.length === 1 ? 'is' : 'are'} already ${all.map((s) => s.status.toLowerCase()).join(', ')} in WHMCS.`;
    for (const s of services) {
      await this.call('ModuleSuspend', { serviceid: String(s.id), suspendreason: `Almanac: ${reason}`.slice(0, 200) });
    }
    return `WHMCS suspended ${describe(services)}.`;
  }

  async unsuspend(customer: WhmcsCustomer): Promise<string> {
    const all = await this.found(customer);
    const services = all.filter((s) => s.status === 'Suspended');
    if (!services.length) return `Nothing to do: ${describe(all)} ${all.length === 1 ? 'isn’t' : 'aren’t'} suspended in WHMCS (${all.map((s) => s.status.toLowerCase()).join(', ')}).`;
    for (const s of services) await this.call('ModuleUnsuspend', { serviceid: String(s.id) });
    return `WHMCS unsuspended ${describe(services)}.`;
  }

  // --- Internals -------------------------------------------------------------

  /** The customer's Silo services: by service username, then (if allowed) by the client's email. */
  async services(customer: WhmcsCustomer): Promise<WhmcsService[]> {
    const { match, productIds } = this.settings;
    const silo = (list: WhmcsService[]) => (productIds.length ? list.filter((s) => productIds.includes(Number(s.pid))) : list);
    if (match !== 'email') {
      const byUsername = silo(await this.products({ username2: customer.username }));
      if (byUsername.length || match === 'username') return byUsername;
    }
    if (!customer.email) return [];
    let clientId: number | null = null;
    try {
      const details = await this.call<{ client?: { id?: number | string }; userid?: number | string; client_id?: number | string; id?: number | string }>('GetClientsDetails', {
        email: customer.email,
      });
      clientId = Number(details.client?.id ?? details.userid ?? details.client_id ?? details.id) || null;
    } catch (err) {
      if (err instanceof WhmcsError && /not found/i.test(err.message)) return [];
      throw err;
    }
    return clientId ? silo(await this.products({ clientid: String(clientId) })) : [];
  }

  private async products(filter: Record<string, string>): Promise<WhmcsService[]> {
    const r = await this.call<{ products?: { product?: WhmcsService[] } | '' }>('GetClientsProducts', { ...filter, limitnum: '250' });
    const list = r.products && typeof r.products === 'object' ? (r.products.product ?? []) : [];
    return list.map((s) => ({ ...s, id: Number(s.id), clientid: Number(s.clientid), pid: Number(s.pid) }));
  }

  /** The customer's Silo services, or an error saying how Almanac looked for them. */
  private async found(customer: WhmcsCustomer): Promise<WhmcsService[]> {
    const services = await this.services(customer);
    if (services.length) return services;
    const how = { username: `service username “${customer.username}”`, email: `client email ${customer.email ?? '(none)'}`, username_or_email: `service username “${customer.username}” or client email ${customer.email ?? '(none)'}` }[this.settings.match];
    throw new WhmcsError(`WHMCS has no Silo service for this customer (looked for ${how}${this.settings.productIds.length ? ` in products ${this.settings.productIds.join(', ')}` : ''}).`, true);
  }

  async call<T>(action: string, params: Record<string, string>): Promise<T & { result: string; message?: string }> {
    const base = this.settings.url.replace(/\/+$/, '').replace(/\/includes\/api\.php$/i, '');
    const body = new URLSearchParams({
      identifier: this.settings.identifier,
      secret: this.settings.secret,
      action,
      responsetype: 'json',
      ...(this.settings.accessKey ? { accesskey: this.settings.accessKey } : {}),
      ...params,
    });
    let res: Response;
    try {
      res = await this.fetchImpl(`${base}/includes/api.php`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Almanac' },
        body,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new WhmcsError(`Couldn’t reach WHMCS: ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = await res.text();
    let json: (T & { result?: string; message?: string }) | null = null;
    try {
      json = JSON.parse(text) as T & { result?: string; message?: string };
    } catch {
      json = null;
    }
    if (!json) {
      throw new WhmcsError(
        res.status === 403 || /access denied/i.test(text)
          ? 'WHMCS refused the request. Allow this server’s IP in WHMCS (General Settings → Security → API IP Access Restriction), or add an API access key.'
          : `WHMCS didn’t answer with JSON (${res.status}). Check the address points at your WHMCS install.`,
      );
    }
    if (json.result !== 'success') {
      const message = json.message ?? 'unknown error';
      if (/authentication failed|invalid ip|not allowed/i.test(message)) {
        throw new WhmcsError(`WHMCS refused the credentials: ${message}. Check the API identifier and secret, the API role’s permissions, and the IP allowlist.`);
      }
      throw new WhmcsError(`WHMCS: ${message}`, /not found/i.test(message));
    }
    return json as T & { result: string; message?: string };
  }
}

function describe(services: WhmcsService[]): string {
  return services.map((s) => `service #${s.id}${s.name ? ` (${s.name})` : ''}`).join(', ');
}

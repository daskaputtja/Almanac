/**
 * Is a network a VPN (or another data-centre address), or someone's home or
 * mobile connection? Worked out from who operates it, using DB-IP's free
 * ASN database. VPN services rent servers in data centres, so their exits
 * belong to hosting companies rather than broadband or mobile providers.
 */

export type NetworkKind = 'vpn' | 'isp' | 'lan' | 'unknown';

/**
 * Operators whose addresses are VPN exits or rented servers. The first group
 * was checked on a real server: accounts on them hop between many addresses
 * from the same operator, the way VPN users do, unlike home broadband.
 */
const VPN_OPERATORS = [
  // VPN services and the hosting they run on
  'datacamp',
  'm247',
  'packethub',
  'clouvider',
  'f.n.s. holdings',
  'hydra communications',
  'proton ag',
  'cyberzone',
  'tzulo',
  'gsl networks',
  'strong technology',
  '31173 services',
  'hostroyale',
  'global layer',
  'gthost',
  'nordvpn',
  'surfshark',
  'expressvpn',
  'mullvad',
  'private internet access',
  'windscribe',
  'ipvanish',
  'cdn77',
  'datapacket',
  // Big hosting and cloud providers (rented servers, VPNs, relays)
  'leaseweb',
  'ovh',
  'hetzner',
  'digitalocean',
  'linode',
  'akamai',
  'vultr',
  'choopa',
  'the constant company',
  'contabo',
  'zenlayer',
  'psychz',
  'quadranet',
  'amazon',
  'google llc',
  'google cloud',
  'microsoft',
  'oracle',
  'alibaba',
  'tencent',
  'scaleway',
  'online s.a.s',
  'xtom',
  'ionos',
  'hostinger',
  'kamatera',
  'cloudflare',
  'zscaler',
  'netcup',
  'colocrossing',
  'servers.com',
  'i3d.net',
  'worldstream',
  'melbicom',
  'serverius',
  'nforce',
  'hivelocity',
  'sharktech',
  'frantech',
  'flokinet',
  'stark industries',
  'aeza',
  'performive',
  'g-core',
  'gcore',
  'combahton',
  'aruba s.p.a',
  'upcloud',
  'packet host',
  'equinix',
];

/** Words that give away a hosting company even when it isn't listed. */
const HOSTING_WORDS = /\b(hosting|host|server|servers|cloud|data ?cent(er|re)s?|vps|vpn|colo(cation)?|datacenter)\b/i;

export function classifyNetwork(operator: string | null | undefined): NetworkKind {
  if (!operator) return 'unknown';
  const name = operator.toLowerCase();
  if (VPN_OPERATORS.some((o) => name.includes(o))) return 'vpn';
  if (HOSTING_WORDS.test(operator)) return 'vpn';
  return 'isp';
}

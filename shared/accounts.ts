/** Offline downloads and registered devices, from Silo's admin API. */

export interface DownloadEntry {
  id: string;
  userId: string;
  username: string;
  title: string;
  /** "S02E05 · Episode name" for an episode, otherwise null. */
  episode: string | null;
  mediaType: string;
  deviceName: string | null;
  /** preparing, ready, downloading, completed, failed or revoked. */
  status: string;
  quality: string | null;
  sizeBytes: number | null;
  createdAt: string;
  /** Still on the device as far as Silo knows. */
  present: boolean;
  /** Where it was downloaded from. Admins only; null for mods. */
  ip: string | null;
}

export interface DownloadTopUser {
  userId: string;
  username: string;
  email: string | null;
  downloads: number;
  bytes: number;
  lastAt: string;
}

export interface DownloadsResponse {
  /** When Almanac's record of downloads starts (Silo only keeps recent ones). */
  since: string | null;
  totals: {
    onDevices: number;
    onDevicesBytes: number;
    accountsWithDownloads: number;
    last7Days: number;
    last7DaysBytes: number;
    last30Days: number;
    last30DaysBytes: number;
  };
  /** Most downloads in the last 30 days. */
  topUsers: DownloadTopUser[];
  recent: DownloadEntry[];
  syncedAt: string | null;
}

export interface UserDownloads {
  last30Days: number;
  last30DaysBytes: number;
  total: number;
  totalBytes: number;
  onDevices: number;
  recent: DownloadEntry[];
}

export interface RegisteredDevice {
  deviceId: string;
  name: string;
  platform: string | null;
  profiles: string[];
  lastUsedAt: string | null;
}

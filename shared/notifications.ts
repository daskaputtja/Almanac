import type { StaffAlertsSettings } from './reliability.js';

/** Which files a channel posts about, judged by the copy in the library it watches. */
export type QualityFilter = 'any' | '4k' | 'hdr' | 'dolby_vision';

export const QUALITY_FILTERS: { value: QualityFilter; label: string }[] = [
  { value: 'any', label: 'Everything' },
  { value: '4k', label: '4K only' },
  { value: 'hdr', label: 'HDR only (any kind)' },
  { value: 'dolby_vision', label: 'Dolby Vision only' },
];

/** A Discord channel that recently added movies and episodes are posted to. */
export interface NotifyChannel {
  id: string;
  name: string;
  /** The webhook address with its secret part hidden, for recognising it. */
  webhookHint: string;
  libraryIds: string[];
  quality: QualityFilter;
  enabled: boolean;
  createdAt: string;
  lastSentAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  waiting: number;
}

export interface NotifyChannelInput {
  name?: string;
  /** Empty or missing keeps the current webhook when editing. */
  webhookUrl?: string;
  libraryIds?: string[];
  quality?: QualityFilter;
  enabled?: boolean;
}

export type NotifyStatus = 'pending' | 'sent' | 'failed' | 'skipped';

export interface NotifyLogEntry {
  channelId: string;
  channelName: string;
  title: string;
  libraryName: string | null;
  status: NotifyStatus;
  detectedAt: string;
  sentAt: string | null;
  error: string | null;
}

export interface MetadataKeyStatus {
  tmdb: boolean;
  tvdb: boolean;
  tvdbPin: boolean;
}

export interface NotificationsResponse {
  channels: NotifyChannel[];
  libraries: { id: string; name: string; type: string | null }[];
  keys: MetadataKeyStatus;
  log: NotifyLogEntry[];
  /** Added by the route. */
  staff?: StaffAlertsSettings;
  board?: LibraryBoardSettings;
  status?: StatusBoardSettings;
}

/** One server from the Uptime Kuma status page. */
export interface StatusBoardMonitor {
  name: string;
  group: string | null;
  state: 'up' | 'down' | 'pending' | 'maintenance' | 'unknown';
  /** Share of checks up over the last 24 hours (0 to 1). */
  uptimeToday: number | null;
  downSince: string | null;
}

/** A Discord message showing each server's status from Uptime Kuma, edited every couple of minutes. */
export interface StatusBoardSettings {
  pageUrl: string | null;
  accessTokenSet: boolean;
  webhookHint: string | null;
  lastUpdatedAt: string | null;
  lastError: string | null;
  monitors: StatusBoardMonitor[];
}

/** A Discord message listing every library and how much is in it, edited hourly. */
export interface LibraryBoardSettings {
  webhookHint: string | null;
  hiddenLibraryIds: string[];
  lastUpdatedAt: string | null;
  lastError: string | null;
}

/** Discord's webhook addresses, optionally posting into a thread or forum post. */
export const DISCORD_WEBHOOK_PATTERN =
  /^https:\/\/(?:(?:ptb|canary)\.)?(?:discord|discordapp)\.com\/api(?:\/v\d{1,2})?\/webhooks\/(\d{5,25})\/([\w-]{20,120})\/?(?:\?thread_id=\d{5,25})?$/;

/** Boards that can also go to Telegram. */
export type TelegramBoard = 'library' | 'status';

export interface TelegramChat {
  id: string;
  title: string;
  type: 'group' | 'supergroup' | 'channel';
}

export interface TelegramTargetView {
  chatId: string | null;
  chatTitle: string | null;
  /** The topic, in a group with topics; null for the main chat. */
  threadId: number | null;
  lastUpdatedAt: string | null;
  lastError: string | null;
}

/** Telegram, through a bot from @BotFather. The token is never sent back. */
export interface TelegramSettings {
  tokenSet: boolean;
  botUsername: string | null;
  /** Groups and channels the bot has been added to. */
  chats: TelegramChat[];
  targets: Record<TelegramBoard, TelegramTargetView>;
}

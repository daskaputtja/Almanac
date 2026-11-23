import { describe, expect, it } from 'vitest';
import type { ActivityStream } from '../shared/activity.js';
import { toActivityStream } from '../server/activity/map.js';
import { MockSessionSource } from '../server/silo/mock.js';
import {
  channelsLabel,
  codecLabel,
  formatBitrate,
  formatClock,
  livePosition,
  platformLabel,
  reasonLabel,
} from '../web/src/lib/format.js';

describe('format helpers', () => {
  it('formats clock times', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(125)).toBe('2:05');
    expect(formatClock(3725)).toBe('1:02:05');
  });

  it('formats bitrates', () => {
    expect(formatBitrate(null)).toBe('—');
    expect(formatBitrate(820)).toBe('820 kbps');
    expect(formatBitrate(4537)).toBe('4.5 Mbps');
    expect(formatBitrate(1_250_000)).toBe('1.25 Gbps');
  });

  it('labels codecs, channels, platforms and reasons', () => {
    expect(codecLabel('subrip')).toBe('SRT');
    expect(codecLabel('xyz')).toBe('XYZ');
    expect(channelsLabel(6, '5.1(side)')).toBe('5.1');
    expect(channelsLabel(2, 'stereo')).toBe('Stereo');
    expect(platformLabel('tvOS')).toBe('tvOS');
    expect(platformLabel('android-tv')).toBe('Android TV');
    expect(reasonLabel('bandwidth_cap')).toBe('Bandwidth cap');
    expect(reasonLabel('something_new')).toBe('Something new');
  });
});

describe('livePosition', () => {
  async function stream(paused: boolean): Promise<ActivityStream> {
    const [session] = await new MockSessionSource().listSessions();
    return toActivityStream({
      ...session!,
      is_paused: paused,
      position_seconds: 100,
      file_duration: 200,
      updated_at: '2026-01-01T00:00:00.000Z',
    });
  }

  it('moves forward while playing', async () => {
    const s = await stream(false);
    expect(livePosition(s, '2026-01-01T00:00:02.000Z', 1000, 4000)).toBe(105);
  });

  it('stands still while paused', async () => {
    const s = await stream(true);
    expect(livePosition(s, '2026-01-01T00:00:02.000Z', 1000, 4000)).toBe(100);
  });

  it('never extrapolates more than a minute or past the end', async () => {
    const s = await stream(false);
    expect(livePosition(s, '2026-01-01T00:00:00.000Z', 0, 600_000)).toBe(160);
    const short = { ...s, media: { ...s.media, durationSeconds: 120 } };
    expect(livePosition(short, '2026-01-01T00:00:00.000Z', 0, 600_000)).toBe(120);
  });
});

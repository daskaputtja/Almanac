import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import type { ModerationFlag, Severity } from '../../../shared/moderation';
import type { SuspensionRequest } from '../../../shared/suspensions';
import { ApiError, api } from '../lib/api';
import { flagText, formatWhen } from '../lib/format';
import { colors, radius, space } from '../lib/theme';
import { Button, Card, ErrorText, Muted, Pill } from './ui';

export const SEVERITY: Record<Severity, { label: string; color: string }> = {
  high: { label: 'Serious', color: colors.critical },
  medium: { label: 'Worth a look', color: colors.serious },
  low: { label: 'Minor', color: colors.warning },
};

const GROUP_TITLES: Record<string, string> = {
  sharing: 'Possible account sharing',
  nonstop: 'Non-stop playback',
  ripping: 'Possible ripping',
};

const noteStyle = { backgroundColor: colors.canvas, borderColor: colors.line, borderWidth: 1, borderRadius: radius.md, color: colors.ink, padding: space.md, minHeight: 70, textAlignVertical: 'top' as const };

/** One account flag, with "Mark as reviewed". */
export function FlagCard({ flag, onChanged, showUser = true }: { flag: ModerationFlag; onChanged: () => void; showUser?: boolean }) {
  const [reviewing, setReviewing] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const severity = SEVERITY[flag.severity];

  const review = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/moderation/flags/${encodeURIComponent(flag.id)}/review`, { method: 'POST', body: { note } });
      setReviewing(false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save that.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card accent={severity.color}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' }}>
        <Pill text={severity.label} color={severity.color} />
        <Text style={{ color: colors.faint, fontSize: 11, fontWeight: '600', letterSpacing: 0.6, textTransform: 'uppercase' }}>{GROUP_TITLES[flag.group] ?? flag.group}</Text>
      </View>
      {showUser ? (
        <Pressable onPress={() => router.push(`/users/${encodeURIComponent(flag.userId)}` as never)}>
          <Text style={{ color: colors.accent, fontSize: 15, fontWeight: '600', marginTop: 4 }}>
            {flag.username}
            {flag.email ? <Text style={{ color: colors.muted, fontWeight: '400' }}> · {flag.email}</Text> : null}
          </Text>
        </Pressable>
      ) : null}
      <Text style={{ color: colors.ink, fontSize: 16, fontWeight: '700', marginTop: 2 }}>{flag.headline}</Text>
      {flag.details.map((d, i) => (
        <Muted key={i}>{flagText(d)}</Muted>
      ))}
      {flag.adminDetails.map((d, i) => (
        <Muted key={`a${i}`} small>
          {flagText(d)}
        </Muted>
      ))}
      <Muted small>Last seen {formatWhen(flag.lastSeenAt)}</Muted>
      {flag.status === 'open' && !reviewing ? (
        <View style={{ marginTop: space.sm }}>
          <Button title="Mark as reviewed" kind="secondary" onPress={() => setReviewing(true)} />
        </View>
      ) : null}
      {flag.status !== 'open' ? <Muted small>Reviewed</Muted> : null}
      {reviewing ? (
        <View style={{ gap: space.sm, marginTop: space.sm }}>
          <TextInput value={note} onChangeText={setNote} placeholder="What did you find? (optional, saved as a note)" placeholderTextColor={colors.faint} multiline style={noteStyle} />
          {error ? <ErrorText>{error}</ErrorText> : null}
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <View style={{ flex: 1 }}>
              <Button title="Mark reviewed" onPress={() => void review()} busy={busy} />
            </View>
            <View style={{ flex: 1 }}>
              <Button title="Cancel" kind="secondary" onPress={() => setReviewing(false)} />
            </View>
          </View>
        </View>
      ) : null}
    </Card>
  );
}

const STATUS: Record<SuspensionRequest['status'], { label: string; color: string }> = {
  pending: { label: 'Waiting for an admin', color: colors.warning },
  done: { label: 'Done', color: colors.good },
  rejected: { label: 'Rejected', color: colors.faint },
  failed: { label: 'Failed', color: colors.critical },
};

/** A suspension request; admins can approve or reject it here. */
export function RequestCard({ request: r, canReview, onChanged, showUser = true }: { request: SuspensionRequest; canReview: boolean; onChanged: () => void; showUser?: boolean }) {
  const [deciding, setDeciding] = useState<'approve' | 'reject' | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = STATUS[r.status];

  const decide = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/suspensions/${r.id}/review`, { method: 'POST', body: { decision: deciding, note } });
      setDeciding(null);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t send that.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card accent={status.color}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' }}>
        <Pill text={status.label} color={status.color} />
        <Text style={{ color: colors.ink, fontWeight: '700' }}>{r.action === 'suspend' ? 'Suspend' : 'Lift suspension'}</Text>
      </View>
      {showUser ? (
        <Pressable onPress={() => router.push(`/users/${encodeURIComponent(r.userId)}` as never)}>
          <Text style={{ color: colors.accent, fontSize: 15, fontWeight: '600', marginTop: 4 }}>
            {r.username}
            {r.email ? <Text style={{ color: colors.muted, fontWeight: '400' }}> · {r.email}</Text> : null}
          </Text>
        </Pressable>
      ) : null}
      <Text style={{ color: colors.ink, fontSize: 15, marginTop: 2 }}>{r.reason}</Text>
      <Muted small>
        Asked by {r.requestedBy} · {formatWhen(r.requestedAt)}
      </Muted>
      {r.reviewedBy ? (
        <Muted small>
          {r.status === 'rejected' ? 'Rejected' : 'Approved'} by {r.reviewedBy}
          {r.reviewNote ? `: ${r.reviewNote}` : ''}
        </Muted>
      ) : null}
      {r.portalMessage ? <Muted small>Billing portal: {r.portalMessage}</Muted> : null}
      {canReview && r.status === 'pending' && !deciding ? (
        <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.sm }}>
          <View style={{ flex: 1 }}>
            <Button title="Approve" onPress={() => setDeciding('approve')} />
          </View>
          <View style={{ flex: 1 }}>
            <Button title="Reject" kind="secondary" onPress={() => setDeciding('reject')} />
          </View>
        </View>
      ) : null}
      {deciding ? (
        <View style={{ gap: space.sm, marginTop: space.sm }}>
          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder={deciding === 'reject' ? 'Why not? (required)' : 'Anything to add? (optional)'}
            placeholderTextColor={colors.faint}
            multiline
            style={noteStyle}
          />
          {error ? <ErrorText>{error}</ErrorText> : null}
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <View style={{ flex: 1 }}>
              <Button
                title={deciding === 'approve' ? (r.action === 'suspend' ? 'Approve and suspend' : 'Approve') : 'Reject'}
                kind={deciding === 'approve' && r.action === 'suspend' ? 'danger' : 'primary'}
                onPress={() => void decide()}
                busy={busy}
                disabled={deciding === 'reject' && note.trim().length < 10}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button title="Cancel" kind="secondary" onPress={() => setDeciding(null)} />
            </View>
          </View>
        </View>
      ) : null}
    </Card>
  );
}

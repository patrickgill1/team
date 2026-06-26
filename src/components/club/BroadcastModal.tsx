// @ts-nocheck
// @ts-nocheck
import React, { useMemo, useState } from 'react';
import { sendEmailBatch, sendPushToUsers } from '../../utils/notify';
import { useAuth } from '../../hooks/useAuth';
import { Sheet, Button, FormField, fieldInputClass } from '../ui';

interface TeamOption { id: string; name: string }
interface MemberOption { uid: string; name: string; email?: string; role?: string; teamIds: string[] }

interface Props {
  isOpen: boolean;
  onClose: () => void;
  teams: TeamOption[];
  members: MemberOption[];
}

/**
 * Club-wide broadcast: send an announcement (email + optional push) to
 * everyone in selected teams, or to the entire club at once.
 *
 * Recipient resolution happens client-side from the loaded member list
 * (already filtered to club users). For pushes we send to UIDs; for
 * emails we batch through the existing notify worker.
 */
const BroadcastModal: React.FC<Props> = ({ isOpen, onClose, teams, members }) => {
  const { userData } = useAuth();
  const [scope, setScope] = useState<'all' | 'parents' | 'coaches' | 'teams'>('all');
  const [pickedTeamIds, setPickedTeamIds] = useState<Set<string>>(new Set());
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sendPush, setSendPush] = useState(true);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const recipients = useMemo(() => {
    let list = members.slice();
    if (scope === 'parents') list = list.filter((m) => (m.role || 'parent') === 'parent');
    if (scope === 'coaches') list = list.filter((m) => m.role === 'coach' || m.role === 'team_manager');
    if (scope === 'teams') {
      if (pickedTeamIds.size === 0) return [] as MemberOption[];
      list = list.filter((m) => m.teamIds.some((t) => pickedTeamIds.has(t)));
    }
    if (userData?.uid) list = list.filter((m) => m.uid !== userData.uid);
    return list;
  }, [members, scope, pickedTeamIds, userData?.uid]);

  if (!isOpen) return null;

  const toggleTeam = (id: string) => {
    setPickedTeamIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleSend = async () => {
    if (!subject.trim() || !body.trim()) return;
    if (recipients.length === 0) return;
    if (!window.confirm(`Send this announcement to ${recipients.length} ${recipients.length === 1 ? 'person' : 'people'}? This can't be undone.`)) return;

    setSending(true);
    setResult(null);
    try {
      // Email path — only members with an email address.
      const safeBody = body.replace(/</g, '&lt;').replace(/\n/g, '<br/>');
      const emails = recipients
        .filter((m) => m.email)
        .map((m) => ({
          to: m.email!,
          subject: subject.trim(),
          html: `<div style="font-family:-apple-system,sans-serif;color:#111827;line-height:1.5;">
            <p style="color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">Club announcement</p>
            <h2 style="margin:8px 0 16px 0;color:#0f172a;">${subject.trim().replace(/</g, '&lt;')}</h2>
            <div style="color:#374151;white-space:pre-wrap;">${safeBody}</div>
            <p style="margin-top:24px;color:#9ca3af;font-size:12px;">— Sent by ${userData?.name || 'GoalKickr'}</p>
          </div>`,
        }));
      if (emails.length > 0) {
        await sendEmailBatch(emails);
      }
      // Push path — opt-in, send to all UIDs.
      if (sendPush) {
        await sendPushToUsers(
          recipients.map((m) => m.uid),
          { title: subject.trim(), body: body.trim().slice(0, 200) },
          { pushPrefKey: 'broadcast' },
        );
      }
      setResult(`Sent to ${recipients.length} recipient${recipients.length === 1 ? '' : 's'}.`);
      setSubject('');
      setBody('');
      // Close after a moment so the user sees the success state.
      setTimeout(() => { setResult(null); onClose(); }, 1500);
    } catch (err: any) {
      console.error('[broadcast] failed', err);
      setResult(`Failed: ${err?.message || 'try again'}`);
    } finally {
      setSending(false);
    }
  };

  return (
    <Sheet
      open={isOpen}
      onClose={onClose}
      kicker="Club broadcast"
      title="Send to multiple teams at once"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={handleSend}
            disabled={!subject.trim() || !body.trim() || recipients.length === 0}
            loading={sending}
          >
            Send to {recipients.length}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <p className="text-[10px] font-extrabold uppercase tracking-widest text-bone/55 mb-2">Recipients</p>
          <div className="grid grid-cols-2 gap-2">
            {[
              { k: 'all', label: 'Everyone' },
              { k: 'parents', label: 'Parents only' },
              { k: 'coaches', label: 'Coaches only' },
              { k: 'teams', label: 'Specific teams' },
            ].map((opt: any) => {
              const active = scope === opt.k;
              return (
                <button
                  key={opt.k}
                  type="button"
                  onClick={() => setScope(opt.k)}
                  className={`p-2 rounded-xl text-sm font-semibold ring-1 transition ${
                    active ? 'ring-brand-primary bg-brand-primary/15 text-bone' : 'ring-white/10 bg-charcoal-950 text-bone/70 hover:bg-white/5'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          {scope === 'teams' && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {teams.map((t) => {
                const active = pickedTeamIds.has(t.id);
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => toggleTeam(t.id)}
                    className={`text-xs font-semibold px-2.5 py-1 rounded-full ring-1 transition ${
                      active ? 'bg-brand-primary text-brand-primary-fg ring-brand-primary' : 'bg-charcoal-950 text-bone/70 ring-white/10 hover:bg-white/5'
                    }`}
                  >
                    {t.name}
                  </button>
                );
              })}
            </div>
          )}
          <p className="text-xs text-bone/55 mt-2">
            Will reach <span className="font-bold text-bone">{recipients.length}</span> {recipients.length === 1 ? 'person' : 'people'}.
          </p>
        </div>

        <FormField label="Subject">
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="e.g. Practice canceled tonight"
            className={fieldInputClass}
            style={{ fontSize: '16px' }}
          />
        </FormField>

        <FormField label="Message">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={5}
            placeholder="Field is flooded, practice is canceled for tonight. We'll regroup Thursday."
            className={`${fieldInputClass} resize-none`}
            style={{ fontSize: '16px' }}
          />
        </FormField>

        <label className="flex items-center gap-2 text-sm text-bone/85 cursor-pointer">
          <input
            type="checkbox"
            checked={sendPush}
            onChange={(e) => setSendPush(e.target.checked)}
            className="w-4 h-4 accent-brand-primary"
          />
          Also send as a push notification
        </label>

        {result && (
          <p className={`text-sm font-semibold ${result.startsWith('Failed') ? 'text-rose-300' : 'text-emerald-300'}`}>
            {result}
          </p>
        )}
      </div>
    </Sheet>
  );
};

export default BroadcastModal;

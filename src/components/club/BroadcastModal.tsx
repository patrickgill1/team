// @ts-nocheck
import React, { useMemo, useState } from 'react';
import { sendEmailBatch, sendPushToUsers } from '../../utils/notify';
import { useAuth } from '../../hooks/useAuth';

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
    <div
      className="fixed inset-0 flex items-center justify-center px-4 bg-black/60 backdrop-blur-sm"
      style={{
        zIndex: 100,
        paddingTop: 'calc(4rem + env(safe-area-inset-top))',
        paddingBottom: 'calc(4rem + env(safe-area-inset-bottom))',
      }}
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-full flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between bg-gradient-to-r from-amber-50 to-white">
          <div>
            <h3 className="text-lg font-bold text-gray-900">📣 Club broadcast</h3>
            <p className="text-xs text-gray-500">Send an announcement to multiple teams at once.</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-gray-100 text-gray-500" aria-label="Close">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-2">Recipients</p>
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
                    onClick={() => setScope(opt.k)}
                    className={`p-2 rounded-xl text-sm font-semibold ring-1 transition ${
                      active ? 'ring-crimson-500 bg-crimson-50/60' : 'ring-gray-200 bg-white hover:bg-gray-50'
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
                      onClick={() => toggleTeam(t.id)}
                      className={`text-xs font-semibold px-2.5 py-1 rounded-full ring-1 transition ${
                        active ? 'bg-crimson-600 text-white ring-crimson-600' : 'bg-white text-gray-700 ring-gray-300 hover:bg-gray-50'
                      }`}
                    >
                      {t.name}
                    </button>
                  );
                })}
              </div>
            )}
            <p className="text-xs text-gray-500 mt-2">
              Will reach <span className="font-bold text-gray-900">{recipients.length}</span> {recipients.length === 1 ? 'person' : 'people'}.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Subject</label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="e.g. Practice canceled tonight"
              className="w-full border border-gray-300 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-crimson-500 text-base"
              style={{ fontSize: '16px' }}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Message</label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={5}
              placeholder="Field is flooded, practice is canceled for tonight. We'll regroup Thursday."
              className="w-full border border-gray-300 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-crimson-500 text-base"
              style={{ fontSize: '16px' }}
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={sendPush}
              onChange={(e) => setSendPush(e.target.checked)}
              className="w-4 h-4 accent-crimson-600"
            />
            Also send as a push notification
          </label>

          {result && (
            <p className={`text-sm font-semibold ${result.startsWith('Failed') ? 'text-red-600' : 'text-emerald-700'}`}>
              {result}
            </p>
          )}
        </div>

        <div className="border-t border-gray-100 p-4 flex items-center justify-end gap-2 bg-gray-50">
          <button onClick={onClose} className="px-4 py-2 text-sm font-semibold text-gray-700 hover:text-gray-900">
            Cancel
          </button>
          <button
            onClick={handleSend}
            disabled={sending || !subject.trim() || !body.trim() || recipients.length === 0}
            className="bg-amber-600 hover:bg-amber-700 disabled:bg-gray-300 text-white font-semibold rounded-xl px-5 py-2 text-sm transition-colors"
          >
            {sending ? 'Sending…' : `📣 Send to ${recipients.length}`}
          </button>
        </div>
      </div>
    </div>
  );
};

export default BroadcastModal;

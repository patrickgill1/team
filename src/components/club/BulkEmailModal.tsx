import React, { useMemo, useState } from 'react';
import { sendEmailBatch, type CoachSignature, type NotifyMessage } from '../../utils/notify';
import { logActivity } from '../../utils/activityLog';
import type { Registration } from '../../types';

// Send a one-off email to an explicit list of selected Registrations.
// Distinct from RegistrationBlastModal which targets the active player
// roster — this targets exactly the rows the admin checked. Dedupes by
// parent email so a family with two registered kids gets one message.

interface Props {
  registrations: Registration[];
  clubId: string;
  signature?: CoachSignature;
  onClose: () => void;
  onSent: (count: number) => void;
}

const BulkEmailModal: React.FC<Props> = ({ registrations, clubId, signature, onClose, onSent }) => {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Build the deduped recipient list. Each entry tracks one or more
  // kids so the email can address "Hunter and family" when applicable.
  const recipients = useMemo(() => {
    const map = new Map<string, { email: string; kids: string[]; registrationIds: string[]; seasonId?: string }>();
    for (const r of registrations) {
      const email = r.parents?.[0]?.email?.toLowerCase().trim();
      if (!email) continue;
      const kidName = `${r.player?.firstName || ''} ${r.player?.lastName || ''}`.trim();
      const existing = map.get(email);
      if (existing) {
        existing.kids.push(kidName);
        existing.registrationIds.push(r.id);
      } else {
        map.set(email, { email, kids: [kidName], registrationIds: [r.id], seasonId: r.seasonId });
      }
    }
    return Array.from(map.values());
  }, [registrations]);

  const canSend = !!(subject.trim() && body.trim() && recipients.length > 0 && !sending);

  const handleSend = async () => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    setResult(null);
    try {
      const safeBody = body
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br/>');
      const sigBlock = signature?.name ? `
        <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e2e8f0;font-size:13px;color:#475569;">
          ${signature.name}${signature.role ? ` · ${signature.role}` : ''}${signature.teamName ? ` · ${signature.teamName}` : ''}
          ${signature.email ? `<div><a href="mailto:${signature.email}" style="color:#0e7490;">${signature.email}</a></div>` : ''}
        </div>` : '';

      const messages: NotifyMessage[] = recipients.map(r => {
        const lead = r.kids.length > 1 ? `${r.kids[0]} and family` : r.kids[0];
        const html = `
          <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:24px;background:#f0f9ff;">
            <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(15,23,42,0.08);">
              <div style="background:linear-gradient(135deg,#0b1220 0%,#0f172a 100%);padding:20px;text-align:center;border-bottom:3px solid #06b6d4;color:#fff;font-weight:900;letter-spacing:2.5px;text-transform:uppercase;font-size:16px;">GoalKickr</div>
              <div style="padding:24px;color:#0f172a;line-height:1.6;font-size:15px;">
                <p style="margin:0 0 12px;color:#475569;">For <b style="color:#0f172a;">${lead}</b></p>
                <div>${safeBody}</div>
                ${sigBlock}
              </div>
            </div>
          </div>`;
        return { to: r.email, subject: subject.trim(), html };
      });

      // Batch endpoint caps at 50 per call — chunk if needed.
      const chunks: NotifyMessage[][] = [];
      for (let i = 0; i < messages.length; i += 50) chunks.push(messages.slice(i, i + 50));
      for (const chunk of chunks) {
        const ok = await sendEmailBatch(chunk);
        if (!ok) throw new Error('send-batch failed');
      }

      // One activity per recipient family — keyed by registration so it
      // shows up on the family timeline.
      await Promise.all(recipients.flatMap(r => r.registrationIds.map(regId => logActivity({
        clubId,
        kind: 'email_sent',
        registrationId: regId,
        parentEmail: r.email,
        seasonId: r.seasonId,
        payload: {
          subject: subject.trim(),
          channel: 'registrations_bulk_email',
        },
      }))));

      setResult(`Sent to ${recipients.length} famil${recipients.length === 1 ? 'y' : 'ies'}.`);
      onSent(recipients.length);
    } catch (err: any) {
      console.error('bulk email send failed', err);
      setError(err?.message || 'Send failed.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-6 overflow-y-auto">
      <div className="bg-white w-full sm:max-w-xl sm:rounded-2xl overflow-hidden flex flex-col max-h-[100vh]">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h2 className="font-black text-charcoal-950">Email selected</h2>
            <p className="text-[11px] text-ink-primary/55">{recipients.length} famil{recipients.length === 1 ? 'y' : 'ies'} ({registrations.length} registration{registrations.length === 1 ? '' : 's'})</p>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700 text-2xl leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <label className="block">
            <span className="block text-[10px] font-extrabold uppercase tracking-widest text-ink-primary/60 mb-1">Subject</span>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Quick update on this weekend's tryout"
              className="w-full px-3 py-2 rounded-lg bg-surface-input text-ink-primary placeholder:text-ink-primary/45 ring-1 ring-line-default/15 focus:ring-2 focus:ring-brand-primary-soft text-sm"
            />
          </label>

          <label className="block">
            <span className="block text-[10px] font-extrabold uppercase tracking-widest text-ink-primary/60 mb-1">Message</span>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={9}
              placeholder="Hey there — quick note..."
              className="w-full px-3 py-2 rounded-lg bg-surface-input text-ink-primary placeholder:text-ink-primary/45 ring-1 ring-line-default/15 focus:ring-2 focus:ring-brand-primary-soft text-sm leading-relaxed"
            />
            <p className="text-[10px] text-slate-500 mt-1">Plain text. Line breaks preserved. Your signature is appended automatically.</p>
          </label>

          {result && <div className="rounded-lg bg-emerald-50 ring-1 ring-emerald-300 px-3 py-2 text-sm text-emerald-700">{result}</div>}
          {error && <div className="rounded-lg bg-rose-50 ring-1 ring-rose-300 px-3 py-2 text-sm text-rose-700">{error}</div>}
        </div>

        <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-2 rounded-lg text-sm font-bold text-slate-600 hover:text-slate-900">
            {result ? 'Done' : 'Cancel'}
          </button>
          {!result && (
            <button
              type="button"
              disabled={!canSend}
              onClick={handleSend}
              className="px-4 py-2 rounded-lg bg-brand-primary hover:bg-brand-primary disabled:opacity-50 text-white text-sm font-bold"
            >
              {sending ? 'Sending…' : `Send to ${recipients.length}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default BulkEmailModal;

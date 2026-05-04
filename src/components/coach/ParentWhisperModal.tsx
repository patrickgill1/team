// @ts-nocheck
import React, { useMemo, useState } from 'react';
import { useAuth } from '../../hooks/useAuth';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  player: any;
  recentMedia: any[];           // already loaded list, latest first
  activePlans: any[];           // already loaded
}

const ParentWhisperModal: React.FC<Props> = ({ isOpen, onClose, player, recentMedia, activePlans }) => {
  const { userData } = useAuth();
  const [message, setMessage] = useState('');
  const [includeClipId, setIncludeClipId] = useState<string>('none');
  const [includePlan, setIncludePlan] = useState(true);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<null | { ok: boolean; count: number; reason?: string }>(null);

  const recentClips = useMemo(
    () => (recentMedia || []).filter(m => m && m.url).slice(0, 6),
    [recentMedia]
  );
  const newestPlan = (activePlans || [])[0];

  const presetMessages = [
    `Wanted to share — ${player?.name?.split(' ')[0] || 'your kid'} had a great week of work. Keep encouraging them!`,
    `Big improvement showing up in ${player?.name?.split(' ')[0] || 'their'} game lately. Just wanted you to know.`,
    `Thank you for getting ${player?.name?.split(' ')[0] || 'them'} to practice this week — it's making a difference.`,
  ];

  if (!isOpen) return null;

  const handleSend = async () => {
    if (!message.trim() || !userData || !player) return;
    setSending(true);
    setResult(null);
    try {
      const { getParentEmailsForPlayer, tplCoachWhisper, sendEmailBatch } = await import('../../utils/notify');
      const parents = await getParentEmailsForPlayer(player.id, 'devPlan');
      if (parents.length === 0) {
        setResult({ ok: false, count: 0, reason: 'No parent emails found for this player.' });
        setSending(false);
        return;
      }
      const clip = includeClipId !== 'none' ? recentClips.find(c => c.id === includeClipId) : null;
      const { subject, html } = tplCoachWhisper({
        playerName: player.name,
        coachName: userData.name || 'Coach',
        message: message.trim(),
        clipUrl: clip?.url,
        clipCaption: clip?.caption,
        recentDevPlanTitle: includePlan && newestPlan ? newestPlan.title : undefined,
      });
      const messages = parents.map(p => ({ to: p.email, subject, html }));
      const ok = await sendEmailBatch(messages);
      setResult({ ok, count: parents.length, reason: ok ? undefined : 'Send failed — check email settings.' });
      if (ok) {
        setTimeout(() => { onClose(); setResult(null); setMessage(''); }, 1500);
      }
    } catch (err) {
      console.error('whisper send failed', err);
      setResult({ ok: false, count: 0, reason: 'Unexpected error.' });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-navy-950/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl w-full sm:max-w-lg max-h-[92vh] overflow-y-auto ring-1 ring-slate-200" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="sticky top-0 bg-gradient-to-r from-navy-700 via-navy-600 to-fire-700 px-5 py-4 z-10">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold text-white tracking-tight flex items-center gap-2">
                <span>💬</span><span>Parent Whisper</span>
              </h2>
              <p className="text-xs text-white/70 mt-0.5">Private note to {player?.name}'s parents</p>
            </div>
            <button onClick={onClose} className="text-white/70 hover:text-white hover:bg-white/15 rounded-lg p-1">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="p-5 space-y-4">
          {/* Quick presets */}
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-2">Quick start</div>
            <div className="flex flex-wrap gap-2">
              {presetMessages.map((p, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setMessage(p)}
                  className="text-xs px-2.5 py-1.5 rounded-lg bg-fire-50 hover:bg-fire-100 text-navy-700 border border-fire-200"
                >
                  {p.slice(0, 32)}…
                </button>
              ))}
            </div>
          </div>

          {/* Message */}
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">Your note</label>
            <textarea
              value={message}
              onChange={e => setMessage(e.target.value)}
              rows={5}
              maxLength={1000}
              placeholder="Write something kind, specific, and short. (e.g. 'Sara stayed after practice 3 days this week to work on left-foot shots — really paying off.')"
              className="w-full px-3 py-2.5 rounded-xl border border-slate-300 focus:border-fire-500 focus:ring-2 focus:ring-fire-500/20 text-sm"
            />
            <div className="text-[10px] text-slate-400 mt-1 text-right">{message.length}/1000</div>
          </div>

          {/* Attach plan */}
          {newestPlan && (
            <label className="flex items-start gap-2 p-3 rounded-xl bg-slate-50 hover:bg-slate-100 cursor-pointer ring-1 ring-slate-200">
              <input
                type="checkbox"
                checked={includePlan}
                onChange={e => setIncludePlan(e.target.checked)}
                className="mt-0.5 h-4 w-4 text-fire-600 focus:ring-fire-500/30 border-slate-300 rounded"
              />
              <div className="text-sm">
                <div className="font-semibold text-slate-700">Mention current dev plan</div>
                <div className="text-xs text-slate-500 mt-0.5">"{newestPlan.title}"</div>
              </div>
            </label>
          )}

          {/* Attach clip */}
          {recentClips.length > 0 && (
            <div>
              <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">Attach a recent clip (optional)</div>
              <select
                value={includeClipId}
                onChange={e => setIncludeClipId(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-slate-300 focus:border-fire-500 focus:ring-2 focus:ring-fire-500/20 text-sm bg-white"
              >
                <option value="none">— None —</option>
                {recentClips.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.type === 'video' ? '🎬' : '📸'} {c.caption || c.fileName || c.id} {c.createdAt ? `· ${new Date(c.createdAt).toLocaleDateString()}` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          {result && (
            <div className={`text-sm rounded-xl p-3 ${result.ok ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200' : 'bg-rose-50 text-rose-700 ring-1 ring-rose-200'}`}>
              {result.ok ? `✓ Sent to ${result.count} parent${result.count === 1 ? '' : 's'}.` : (result.reason || 'Send failed.')}
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={sending}
              className="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold py-3 rounded-xl"
            >Cancel</button>
            <button
              type="button"
              onClick={handleSend}
              disabled={sending || !message.trim()}
              className="flex-1 bg-gradient-to-r from-fire-600 to-navy-600 hover:from-fire-500 hover:to-navy-500 text-white font-semibold py-3 rounded-xl shadow-sm disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {sending ? <div className="animate-spin rounded-full h-5 w-5 border-2 border-white/40 border-t-white" /> : <>📨 Send Whisper</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ParentWhisperModal;

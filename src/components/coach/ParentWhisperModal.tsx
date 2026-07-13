// @ts-nocheck
import React, { useMemo, useState } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { useTeam } from '../../contexts/TeamContext';
import { Sheet, Button, FormField, fieldInputClass } from '../ui';
import { workerFetch } from '../../utils/workerFetch';

// Fixed XP a whisper awards. Kept in lockstep with WHISPER_XP in
// worker/src/writeGuards.ts — coach cannot override.
const WHISPER_XP = 50;

interface Props {
  isOpen: boolean;
  onClose: () => void;
  player: any;
  recentMedia: any[];           // already loaded list, latest first
  activePlans: any[];           // already loaded
}

const ParentWhisperModal: React.FC<Props> = ({ isOpen, onClose, player, recentMedia, activePlans }) => {
  const { userData } = useAuth();
  const { selectedTeam } = useTeam();
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
    `Wanted to share — ${player?.name?.split(' ')[0] || 'this player'} had a great week of work. Keep encouraging them!`,
    `Big improvement showing up in ${player?.name?.split(' ')[0] || 'their'} game lately. Just wanted you to know.`,
    `Thank you for getting ${player?.name?.split(' ')[0] || 'them'} to practice this week — it's making a difference.`,
  ];

  if (!isOpen) return null;

  const xpEnabled = (selectedTeam as any)?.xpConfig?.enabled === true;

  const handleSend = async () => {
    if (!message.trim() || !userData || !player) return;
    setSending(true);
    setResult(null);
    try {
      const { getParentEmailsForPlayer, tplCoachWhisper, sendEmailBatch, sendPushToPlayerParents } = await import('../../utils/notify');
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
        signature: {
          name: userData.name || 'Coach',
          role: (userData as any).coachLevel === 'assistant_coach' ? 'Assistant Coach' : 'Head Coach',
          teamName: selectedTeam?.name,
          email: userData.email,
          avatarUrl: (userData as any).photoURL || (userData as any).profilePhotoUrl,
        },
      });
      const messages = parents.map(p => ({ to: p.email, subject, html }));
      const ok = await sendEmailBatch(messages);

      // Persist the whisper so parents can re-read it from the in-app
      // history later. Patrick: 'when you send one, they get a push
      // notification but it shows part of the message, and it is
      // confusing to the parents as they think they should be receiving
      // a message in the app, but it is an actual email.' The push now
      // says check-your-email, and the in-app inbox lives on
      // /player/{id} → Whispers tab.
      try {
        const { addDoc, collection, serverTimestamp } = await import('firebase/firestore');
        const { db } = await import('../../utils/firebase');
        await addDoc(collection(db, 'parent_whispers'), {
          playerId: player.id,
          playerName: player.name,
          clubId: (player as any).clubId || null,
          teamId: (player as any).teamId || null,
          coachUid: userData.uid,
          coachName: userData.name || 'Coach',
          coachAvatarUrl: (userData as any).photoURL || (userData as any).profilePhotoUrl || null,
          message: message.trim(),
          clipId: clip?.id || null,
          clipUrl: clip?.url || null,
          clipCaption: clip?.caption || null,
          devPlanTitle: includePlan && newestPlan ? newestPlan.title : null,
          recipientEmails: parents.map(p => p.email),
          recipientCount: parents.length,
          xp: WHISPER_XP,
          kind: 'whisper',
          createdAt: serverTimestamp(),
        });
      } catch (err) {
        // Non-fatal: email already went out. Coach can re-send if they
        // really need an in-app record.
        console.warn('whisper persist failed', err);
      }

      // XP fanout — fires the fixed +50 XP grant + derived Coach's
      // Pick badge check via the worker. Non-fatal on failure: the
      // whisper's already out and the family got the note; the XP
      // just doesn't land. Coach can nudge Give XP if it really
      // matters. Only fires when this team has XP enabled — we
      // don't need to check that client-side because the worker
      // itself no-ops on xpConfig.enabled !== true.
      try {
        const teamIdForXp = (player as any).teamId || selectedTeam?.id || '';
        if (teamIdForXp && (selectedTeam as any)?.xpConfig?.enabled === true) {
          await workerFetch('/xp/award-whisper', {
            method: 'POST',
            body: JSON.stringify({ playerId: player.id, teamId: teamIdForXp }),
          });
        }
      } catch (err) {
        console.warn('whisper xp grant failed (non-fatal)', err);
      }

      // Push: deliberately generic — parent sees 'New whisper, check
      // your email' instead of a 140-char preview that made them hunt
      // in the app for content that wasn't there. Tap lands on the
      // player profile (where the Whispers tab now lives), not on
      // anything that would imply 'open a message in the app.'
      sendPushToPlayerParents(player.id, {
        title: `New whisper from Coach ${userData.name?.split(' ')[0] || ''}`.trim(),
        body: `About ${player.name?.split(' ')[0] || 'your player'}. Full note in your email — and saved in their profile.`,
        path: `/player/${player.id}?tab=whispers`,
      }, 'devPlan');
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
    <Sheet
      open={true}
      onClose={onClose}
      kicker="Parent Whisper"
      title={`Private note to ${player?.name || 'this player'}'s parents`}
      size="lg"
      footer={
        <>
          {xpEnabled && (
            <span className="hidden sm:inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-brand-primary-soft mr-auto">
              +{WHISPER_XP} XP
            </span>
          )}
          <Button variant="ghost" onClick={onClose} disabled={sending}>Cancel</Button>
          <Button
            variant="primary"
            onClick={handleSend}
            disabled={!message.trim()}
            loading={sending}
          >
            Send Whisper
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* Quick presets */}
        <div>
          <div className="text-[10px] font-extrabold uppercase tracking-widest text-ink-primary/55 mb-2">Quick start</div>
          <div className="flex flex-wrap gap-2">
            {presetMessages.map((p, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setMessage(p)}
                className="text-xs px-2.5 py-1.5 rounded-lg bg-brand-primary/15 hover:bg-brand-primary/25 text-ink-primary ring-1 ring-brand-primary-soft/30"
              >
                {p.slice(0, 32)}…
              </button>
            ))}
          </div>
        </div>

        <FormField label="Your note" hint={`${message.length}/1000`}>
          <textarea
            value={message}
            onChange={e => setMessage(e.target.value)}
            rows={5}
            maxLength={1000}
            placeholder="Write something kind, specific, and short. (e.g. 'Sara stayed after practice 3 days this week to work on left-foot shots — really paying off.')"
            className={`${fieldInputClass} resize-none`}
            style={{ fontSize: '16px' }}
          />
        </FormField>

        {newestPlan && (
          <label className="flex items-start gap-2 p-3 rounded-xl bg-line-default/[0.04] hover:bg-line-default/[0.06] cursor-pointer ring-1 ring-line-default/10">
            <input
              type="checkbox"
              checked={includePlan}
              onChange={e => setIncludePlan(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-brand-primary"
            />
            <div className="text-sm">
              <div className="font-semibold text-ink-primary">Mention current dev plan</div>
              <div className="text-xs text-ink-primary/55 mt-0.5">"{newestPlan.title}"</div>
            </div>
          </label>
        )}

        {recentClips.length > 0 && (
          <FormField label="Attach a recent clip" optional>
            <select
              value={includeClipId}
              onChange={e => setIncludeClipId(e.target.value)}
              className={fieldInputClass}
            >
              <option value="none">— None —</option>
              {recentClips.map(c => (
                <option key={c.id} value={c.id}>
                  {c.type === 'video' ? 'Video' : 'Photo'} · {c.caption || c.fileName || c.id} {c.createdAt ? `(${new Date(c.createdAt).toLocaleDateString()})` : ''}
                </option>
              ))}
            </select>
          </FormField>
        )}

        {result && (
          <div className={`text-sm rounded-xl p-3 ${
            result.ok
              ? 'bg-emerald-500/10 text-emerald-200 ring-1 ring-emerald-400/30'
              : 'bg-rose-500/10 text-rose-200 ring-1 ring-rose-400/30'
          }`}>
            {result.ok ? `Sent to ${result.count} parent${result.count === 1 ? '' : 's'}.` : (result.reason || 'Send failed.')}
          </div>
        )}
      </div>
    </Sheet>
  );
};

export default ParentWhisperModal;

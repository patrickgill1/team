// @ts-nocheck
import React, { useMemo, useState } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { Sheet, Button, FormField, fieldInputClass } from '../ui';

// Kudos composer — any Player Circle member (parent, grandparent,
// other guardian in player.parentIds) can send a Kudos to a player.
// Coach can one-tap convert to +N XP later; the Kudos exists as a
// moment on the player's profile regardless.
//
// Mirrors ParentWhisperModal structure so the UX rhymes across the
// two "notes to a player" primitives. Distinct primitives because
// audience is different: Whisper is coach-authored (private note to
// parents); Kudos is Circle-authored (public-to-circle affirmation).
//
// See project_player_circle_mission memory for the emotional model.

const NOTE_MAX = 500;
const NOTE_MIN = 3;

type PresetKind = 'practiced_hard' | 'kind_moment' | 'great_effort' | 'showed_up' | null;

interface Preset {
  kind: PresetKind;
  label: string;
  bodyFor: (firstName: string) => string;
}

const PRESETS: Preset[] = [
  {
    kind: 'practiced_hard',
    label: 'Practiced hard',
    bodyFor: (n) => `${n} practiced hard today without being asked — proud of that.`,
  },
  {
    kind: 'kind_moment',
    label: 'Kind moment',
    bodyFor: (n) => `Caught ${n} doing something kind for a teammate. Wanted you to know.`,
  },
  {
    kind: 'great_effort',
    label: 'Great effort',
    bodyFor: (n) => `${n} gave a great effort out there. Whatever the scoreline said, this was a win.`,
  },
  {
    kind: 'showed_up',
    label: 'Showed up',
    bodyFor: (n) => `${n} just showed up — energy, focus, ready. That's the habit.`,
  },
];

interface Props {
  isOpen: boolean;
  onClose: () => void;
  player: any;
  onSent?: () => void;
}

const KudosComposerModal: React.FC<Props> = ({ isOpen, onClose, player, onSent }) => {
  const { userData } = useAuth();
  const [note, setNote] = useState('');
  const [presetKind, setPresetKind] = useState<PresetKind>(null);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<null | { ok: boolean; reason?: string }>(null);

  const firstName = useMemo(
    () => (player?.name ? String(player.name).split(' ')[0] : 'this player'),
    [player?.name]
  );

  if (!isOpen) return null;

  const applyPreset = (p: Preset) => {
    setPresetKind(p.kind);
    setNote(p.bodyFor(firstName));
  };

  const handleSend = async () => {
    if (!userData || !player) return;
    const trimmed = note.trim();
    if (trimmed.length < NOTE_MIN) {
      setResult({ ok: false, reason: `Note is too short — say a little more (min ${NOTE_MIN} characters).` });
      return;
    }
    if (trimmed.length > NOTE_MAX) {
      setResult({ ok: false, reason: `Note is too long — trim to ${NOTE_MAX} characters or fewer.` });
      return;
    }
    setSending(true);
    setResult(null);
    try {
      const { addDoc, collection, serverTimestamp } = await import('firebase/firestore');
      const { db } = await import('../../utils/firebase');
      const teamId = (player as any).teamId
        || (Array.isArray((player as any).teamIds) ? (player as any).teamIds[0] : '')
        || '';
      const kudosDoc = await addDoc(collection(db, 'kudos'), {
        playerId: player.id,
        playerName: player.name || 'Player',
        teamId: teamId || null,
        clubId: (player as any).clubId || null,
        senderUid: userData.uid,
        senderName: userData.name || 'A Circle member',
        senderAvatarUrl: (userData as any).photoURL || (userData as any).profilePhotoUrl || null,
        presetKind: presetKind || null,
        note: trimmed,
        createdAt: serverTimestamp(),
      });

      // Fire-and-forget email + push fanout to the team's coach(es).
      // Best-effort: if either fails the kudos still lives in Firestore
      // and shows up on the player's profile stream.
      try {
        const { tplKudosNew, sendEmailBatch, sendPushToTeamCoaches } = await import('../../utils/notify');
        if (teamId) {
          const { subject, html } = tplKudosNew({
            playerName: player.name || 'the player',
            senderName: userData.name || 'A Circle member',
            note: trimmed,
            presetKind: presetKind || null,
            playerId: player.id,
          });
          // Push to coaches first (in-hand) — email is the durable backup.
          sendPushToTeamCoaches(teamId, {
            title: `Kudos for ${player.name || 'a player'} from ${userData.name || 'a Circle member'}`,
            body: trimmed.slice(0, 140),
            url: `/player/${player.id}?tab=whispers`,
          }, 'devPlan').catch(() => { /* non-fatal */ });
          // Email to the team's coach(es) via existing batch endpoint.
          import('../../utils/notify').then(async ({ getCoachEmailsForTeam }) => {
            try {
              const coaches = await getCoachEmailsForTeam(teamId, 'devPlan');
              if (coaches.length > 0) {
                await sendEmailBatch(coaches.map(c => ({ to: c.email, subject, html })));
              }
            } catch { /* non-fatal */ }
          });
        }
      } catch (fanoutErr) {
        console.warn('[kudos] fanout failed (non-fatal):', fanoutErr);
      }

      setResult({ ok: true });
      setSending(false);
      // Give the toast a beat, then close.
      setTimeout(() => {
        onSent?.();
        onClose();
        setNote('');
        setPresetKind(null);
        setResult(null);
      }, 1500);
    } catch (err: any) {
      console.error('[kudos] send failed', err);
      setSending(false);
      setResult({ ok: false, reason: err?.message || 'Something went wrong sending your Kudos. Try again.' });
    }
  };

  return (
    <Sheet open={isOpen} onClose={onClose} title={`Kudos for ${firstName}`}>
      <div className="p-4 sm:p-5 flex flex-col gap-4">
        {/* Intro */}
        <p className="text-sm text-ink-primary/70 leading-relaxed">
          Send {firstName} a note about something you noticed. Coach may add XP if they agree, but
          the moment itself lands on {firstName}&rsquo;s profile either way &mdash; your people
          seeing you is the point.
        </p>

        {/* Presets */}
        <div>
          <div className="text-[10px] font-black uppercase tracking-widest text-ink-primary/55 mb-2">Quick starts</div>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map(p => (
              <button
                key={p.kind || 'none'}
                type="button"
                onClick={() => applyPreset(p)}
                className={`px-3 py-1.5 rounded-full text-[12px] font-black uppercase tracking-wider ring-1 transition ${
                  presetKind === p.kind
                    ? 'bg-brand-primary text-white ring-brand-primary'
                    : 'bg-line-default/5 text-ink-primary/80 ring-line-default/25 hover:bg-line-default/10'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* Note textarea */}
        <FormField label="Your note">
          <textarea
            className={`${fieldInputClass} min-h-[120px] resize-none`}
            style={{ fontSize: '16px' }}
            placeholder={`What did you see? "${firstName} stayed after to work on their left foot…"`}
            value={note}
            onChange={(e) => {
              setNote(e.target.value.slice(0, NOTE_MAX));
              // Once the user edits, no longer count as a "preset."
              if (presetKind) setPresetKind(null);
            }}
            maxLength={NOTE_MAX}
          />
          <div className="text-[10px] text-ink-primary/45 tabular-nums text-right mt-1">
            {note.length}/{NOTE_MAX}
          </div>
        </FormField>

        {/* Result banner */}
        {result && (
          <div className={`px-3 py-2 rounded-lg text-sm font-medium ${
            result.ok
              ? 'bg-emerald-500/10 text-emerald-600 ring-1 ring-emerald-500/20'
              : 'bg-rose-500/10 text-rose-600 ring-1 ring-rose-500/20'
          }`}>
            {result.ok
              ? `Sent — coach can add XP if they agree, and ${firstName} will see this on their profile.`
              : result.reason || 'Could not send. Try again.'}
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose} disabled={sending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSend}
            disabled={sending || note.trim().length < NOTE_MIN}
          >
            {sending ? 'Sending…' : 'Send Kudos'}
          </Button>
        </div>
      </div>
    </Sheet>
  );
};

export default KudosComposerModal;

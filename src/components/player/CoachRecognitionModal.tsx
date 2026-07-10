// CoachRecognitionModal — coach awards a private XP recognition to
// one kid with a required short note. Fanout lands the note in the
// parents' /player/{id} Whispers tab, bumps player.xp, and either
// awards or bumps the "Coach's Pick" badge.
//
// The whole submit goes through the worker /xp/award-recognition
// endpoint so the per-kid-per-week cap can't be bypassed. Errors
// (weekly_cap_reached, xp_not_enabled) map to inline hints, not
// alerts.

import React, { useState } from 'react';
import { Sheet, Button } from '../ui';
import { Player } from '../../types';
import { workerFetch } from '../../utils/workerFetch';

interface Props {
  open: boolean;
  onClose: () => void;
  player: Player;
  teamId: string;
  onAwarded?: (result: { xp: number; totalXp: number; remainingThisWeek: number; badgeCount: number }) => void;
}

const NOTE_MIN = 5;
const NOTE_MAX = 500;
const NOTE_PLACEHOLDERS = [
  'What specifically caught your eye today?',
  'Effort · attitude · a defensive stand · a great pass?',
  'Say the thing you\'d say to their face.',
];

const CoachRecognitionModal: React.FC<Props> = ({ open, onClose, player, teamId, onAwarded }) => {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Cycle the placeholder each time the modal opens so a coach who
  // uses this daily gets a small nudge in different directions.
  const placeholder = NOTE_PLACEHOLDERS[Math.min(NOTE_PLACEHOLDERS.length - 1, Math.floor(note.length / 40))];

  const firstName = player.name.split(' ')[0];
  const trimmed = note.trim();
  const submittable = trimmed.length >= NOTE_MIN && !busy;

  const handleSubmit = async () => {
    if (!submittable) return;
    setBusy(true);
    setError(null);
    try {
      const res = await workerFetch('/xp/award-recognition', {
        method: 'POST',
        body: JSON.stringify({ playerId: player.id, teamId, note: trimmed }),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        // Map the worker's machine-readable codes to warm inline copy.
        const code = String(data?.error || '');
        if (code === 'weekly_cap_reached') {
          setError(data.message || `You've already recognized ${firstName} this week. Save the next one for next week.`);
        } else if (code === 'xp_not_enabled') {
          setError('XP + badges is turned off for this team. Enable it in Team Settings first.');
        } else if (code === 'note_required') {
          setError(`Add a little more — at least ${NOTE_MIN} characters.`);
        } else {
          setError(data?.message || 'Could not save. Please try again.');
        }
        setBusy(false);
        return;
      }
      onAwarded?.(data);
      setNote('');
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Network error. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={() => { if (!busy) { setNote(''); setError(null); onClose(); } }}
      kicker="Coach recognition"
      title={`Recognize ${firstName}`}
      subtitle="Private note to the family. Awards XP and a Coach's Pick badge."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={handleSubmit} disabled={!submittable}>
            {busy ? 'Sending…' : 'Send recognition'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value.slice(0, NOTE_MAX))}
          placeholder={placeholder}
          rows={4}
          autoFocus
          className="w-full rounded-xl bg-surface-input border border-line-default/15 text-ink-primary placeholder:text-ink-primary/40 text-sm p-3 leading-snug focus:border-brand-primary/50 focus:ring-1 focus:ring-brand-primary/40 focus:outline-none resize-none"
        />
        <div className="flex items-center justify-between text-[11px] text-ink-primary/50">
          <span>
            {trimmed.length < NOTE_MIN
              ? `${NOTE_MIN - trimmed.length} more character${NOTE_MIN - trimmed.length === 1 ? '' : 's'} to unlock`
              : `${trimmed.length} / ${NOTE_MAX}`}
          </span>
          <span>Max 2 per kid per week</span>
        </div>
        {error && (
          <div className="rounded-xl bg-amber-500/15 ring-1 ring-amber-400/30 px-3 py-2 text-[12px] text-amber-100 leading-snug">
            {error}
          </div>
        )}
      </div>
    </Sheet>
  );
};

export default CoachRecognitionModal;

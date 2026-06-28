// @ts-nocheck
import React, { useEffect, useState } from 'react';
import { deleteDoc, doc } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { sendPushToUsers } from '../../utils/notify';
import { useAuth } from '../../contexts/AuthContext';
import type { CalendarEvent } from '../../types';
import { Sheet, Button, FormField, fieldInputClass } from '../ui';

interface Props {
  event: CalendarEvent | null;
  onClose: () => void;
  onDeleted?: () => void;
}

// Confirmation sheet for deleting a calendar event. Includes an
// "Alert team" toggle — a delete can sometimes need to ping the
// parents who'd already RSVPed ("game cancelled, here's why") and
// sometimes shouldn't ("I created a duplicate by accident, nuke it
// quietly"). Default ON because the more common case is telling the
// team. PITR isn't enabled so deletes are permanent.
const DeleteEventSheet: React.FC<Props> = ({ event, onClose, onDeleted }) => {
  const { userData } = useAuth();
  const [alertTeam, setAlertTeam] = useState(true);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (event) {
      setAlertTeam(true);
      setNote('');
      setError(null);
      setBusy(false);
    }
  }, [event?.id]);

  const handleDelete = async () => {
    if (!event || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (alertTeam) {
        const recipients = new Set<string>();
        Object.keys(event.rsvps || {}).forEach(uid => recipients.add(uid));
        Object.values(event.playerRsvps || {}).forEach((r: any) => {
          if (r?.byUid) recipients.add(r.byUid);
        });
        if (userData?.uid) recipients.delete(userData.uid);
        if (recipients.size > 0) {
          const trimmed = note.trim();
          const senderName = userData?.name || 'Coach';
          await sendPushToUsers(
            Array.from(recipients),
            {
              title: `Cancelled: ${event.title}`,
              body: trimmed
                ? `${senderName}: ${trimmed.slice(0, 140)}`
                : `${senderName} removed this event from the calendar.`,
              url: '/calendar',
            },
            { pushPrefKey: 'events' },
          );
        }
      }
      await deleteDoc(doc(db, 'events', event.id));
      onDeleted?.();
      onClose();
    } catch (err: any) {
      console.error('event delete failed', err);
      setError(err?.message || 'Delete failed — try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={!!event}
      onClose={() => { if (!busy) onClose(); }}
      kicker="Delete event"
      title={event ? `Permanently delete "${event.title}"?` : ''}
      subtitle="This removes the event for everyone and can't be undone. If the event still happened but was cancelled, use Cancel event instead so it stays visible with a CANCELLED badge."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Keep event</Button>
          <Button variant="danger" onClick={handleDelete} loading={busy}>Delete</Button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="flex items-start gap-3 rounded-xl ring-1 ring-line-default/10 px-3 py-2.5 bg-line-default/[0.04] cursor-pointer">
          <input
            type="checkbox"
            className="mt-1 w-4 h-4 accent-brand-primary"
            checked={alertTeam}
            onChange={(e) => setAlertTeam(e.target.checked)}
          />
          <span className="flex-1">
            <span className="block text-[14px] font-bold text-ink-primary">Alert the team</span>
            <span className="block text-[12px] text-ink-primary/55 mt-0.5">
              Push notification to everyone who RSVPed. Turn off for silent cleanup (duplicate event, test entry, etc.).
            </span>
          </span>
        </label>

        {alertTeam && (
          <FormField label="Note" optional>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why it's gone — e.g. 'rescheduled, watch for the new one'"
              rows={2}
              className={`${fieldInputClass} resize-none`}
              style={{ fontSize: '16px' }}
            />
          </FormField>
        )}

        {error && (
          <div className="rounded-lg bg-rose-950/30 ring-1 ring-rose-700/40 px-3 py-2 text-[12px] text-rose-200">
            {error}
          </div>
        )}
      </div>
    </Sheet>
  );
};

export default DeleteEventSheet;

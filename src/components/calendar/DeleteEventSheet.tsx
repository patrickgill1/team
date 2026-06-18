import React, { useEffect, useState } from 'react';
import { deleteDoc, doc } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { sendPushToUsers } from '../../utils/notify';
import { useAuth } from '../../contexts/AuthContext';
import type { CalendarEvent } from '../../types';

interface Props {
  event: CalendarEvent | null;
  onClose: () => void;
  onDeleted?: () => void;
}

// Confirmation sheet for deleting a calendar event. Replaces the
// legacy window.confirm with a proper bottom sheet that includes an
// "Alert team" toggle — Patrick's ask: a delete can sometimes need
// to ping the parents who'd already RSVPed ("game cancelled, here's
// why") and sometimes shouldn't ("I created a duplicate by accident,
// nuke it quietly"). Default ON because the more common case is
// telling the team. PITR isn't enabled so deletes are permanent —
// surface that clearly in the body.
const DeleteEventSheet: React.FC<Props> = ({ event, onClose, onDeleted }) => {
  const { userData } = useAuth();
  const [alertTeam, setAlertTeam] = useState(true);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form whenever the sheet re-opens for a different event.
  useEffect(() => {
    if (event) {
      setAlertTeam(true);
      setNote('');
      setError(null);
      setBusy(false);
    }
  }, [event?.id]);

  if (!event) return null;

  const handleDelete = async () => {
    if (busy) return;
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
    <div
      className="fixed inset-0 z-50 bg-black/55 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in"
      onClick={() => { if (!busy) onClose(); }}
    >
      <div
        className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden animate-sheet-up sm:animate-pop-in"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="bg-gradient-to-b from-charcoal-950 to-charcoal-900 px-4 py-3 flex items-center justify-between">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="text-[11px] font-extrabold tracking-widest uppercase text-slate-400 hover:text-white disabled:opacity-40"
          >
            Cancel
          </button>
          <div className="text-xs font-extrabold tracking-widest uppercase text-rose-300">Delete event</div>
          <span className="w-12" aria-hidden />
        </div>

        <div className="px-5 pt-4 pb-3 space-y-3">
          <p className="text-[15px] text-slate-900">
            Permanently delete <span className="font-bold">{event.title}</span>?
          </p>
          <p className="text-[12.5px] text-slate-500 leading-relaxed">
            This removes the event for everyone and can't be undone. If the event still happened but was cancelled, use <span className="font-semibold text-slate-700">Cancel event</span> instead so it stays visible with a CANCELLED badge.
          </p>

          <label className="flex items-start gap-3 rounded-xl ring-1 ring-slate-200 px-3 py-2.5 bg-slate-50 cursor-pointer">
            <input
              type="checkbox"
              className="mt-1 w-4 h-4 accent-crimson-600"
              checked={alertTeam}
              onChange={(e) => setAlertTeam(e.target.checked)}
            />
            <span className="flex-1">
              <span className="block text-[14px] font-bold text-slate-900">Alert the team</span>
              <span className="block text-[12px] text-slate-500 mt-0.5">
                Push notification to everyone who RSVPed. Turn off for silent cleanup (duplicate event, test entry, etc.).
              </span>
            </span>
          </label>

          {alertTeam && (
            <div>
              <label className="block text-[11px] font-extrabold tracking-widest uppercase text-slate-500 mb-1.5">
                Note (optional)
              </label>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Why it's gone — e.g. 'rescheduled, watch for the new one'"
                rows={2}
                className="w-full px-3 py-2 rounded-lg ring-1 ring-slate-200 focus:ring-2 focus:ring-crimson-400 text-[14px] resize-none"
                style={{ fontSize: '16px' }}
              />
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-rose-50 ring-1 ring-rose-200 px-3 py-2 text-[12px] text-rose-700">
              {error}
            </div>
          )}
        </div>

        <div className="px-5 py-3 flex items-center justify-end gap-2 border-t border-slate-100 bg-slate-50/60">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 text-[13px] font-bold text-slate-700 hover:text-slate-900 rounded-md disabled:opacity-40"
          >
            Keep event
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={busy}
            className="px-4 py-2 text-[13px] font-extrabold uppercase tracking-widest text-white bg-rose-600 hover:bg-rose-500 rounded-md shadow-sm disabled:opacity-50"
          >
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default DeleteEventSheet;

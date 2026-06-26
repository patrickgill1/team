// @ts-nocheck
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { collection, query, where, getDocs, doc, updateDoc, deleteDoc } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { clearActiveSeasonCache } from '../../utils/seasons';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  teamId: string;
}

interface SeasonRow {
  id: string;
  name: string;
  startDate: Date;
  endDate: Date;
  isActive: boolean;
}

/**
 * "Manage seasons" — the season equivalent of a Past Players view.
 * Lists every season for the active team with options to set active /
 * rename / change dates / delete. Designed for the case where someone
 * created a season on the wrong team and needs a self-serve fix.
 */
const ManageSeasonsModal: React.FC<Props> = ({ isOpen, onClose, teamId }) => {
  const [seasons, setSeasons] = useState<SeasonRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<SeasonRow | null>(null);
  const [editName, setEditName] = useState('');
  const [editStart, setEditStart] = useState('');
  const [editEnd, setEditEnd] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const snap = await getDocs(query(collection(db, 'seasons'), where('teamId', '==', teamId)));
      const rows: SeasonRow[] = snap.docs.map((d) => {
        const data: any = d.data();
        return {
          id: d.id,
          name: data.name || 'Season',
          startDate: data.startDate?.toDate?.() || new Date(data.startDate || Date.now()),
          endDate: data.endDate?.toDate?.() || new Date(data.endDate || Date.now()),
          isActive: !!data.isActive,
        };
      });
      // Sort: active first, then most-recent end date first.
      rows.sort((a, b) => {
        if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
        return b.endDate.getTime() - a.endDate.getTime();
      });
      setSeasons(rows);
    } catch (err: any) {
      setError(err?.message || 'Failed to load seasons.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isOpen || !teamId) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, teamId]);

  if (!isOpen) return null;

  const startEdit = (s: SeasonRow) => {
    setEditing(s);
    setEditName(s.name);
    setEditStart(s.startDate.toISOString().slice(0, 10));
    setEditEnd(s.endDate.toISOString().slice(0, 10));
  };

  const cancelEdit = () => {
    setEditing(null);
    setEditName('');
    setEditStart('');
    setEditEnd('');
  };

  const saveEdit = async () => {
    if (!editing) return;
    if (!editName.trim() || !editStart || !editEnd) {
      setError('Name + both dates are required.');
      return;
    }
    const s = new Date(editStart);
    const e = new Date(editEnd);
    if (e <= s) {
      setError('End date must be after start date.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await updateDoc(doc(db, 'seasons', editing.id), {
        name: editName.trim(),
        startDate: s,
        endDate: e,
      });
      cancelEdit();
      await load();
    } catch (err: any) {
      setError(err?.message || 'Save failed.');
    } finally {
      setBusy(false);
    }
  };

  const setActive = async (s: SeasonRow) => {
    if (s.isActive) return;
    setBusy(true);
    setError(null);
    try {
      // Demote whichever season is currently active first.
      const currentActive = seasons.find((x) => x.isActive);
      if (currentActive) {
        await updateDoc(doc(db, 'seasons', currentActive.id), { isActive: false });
      }
      await updateDoc(doc(db, 'seasons', s.id), { isActive: true });
      clearActiveSeasonCache(teamId);
      await load();
    } catch (err: any) {
      setError(err?.message || 'Could not change active season.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (s: SeasonRow) => {
    const warning = s.isActive
      ? `Delete the ACTIVE season "${s.name}"?\n\nPlayer stats tied to it will lose their season label (they'll still exist, just won't roll up under any season). This cannot be undone.`
      : `Delete season "${s.name}"?\n\nPlayer stats tied to it will lose their season label. This cannot be undone.`;
    if (!window.confirm(warning)) return;
    setBusy(true);
    setError(null);
    try {
      await deleteDoc(doc(db, 'seasons', s.id));
      clearActiveSeasonCache(teamId);
      await load();
    } catch (err: any) {
      setError(err?.message || 'Delete failed.');
    } finally {
      setBusy(false);
    }
  };

  const fmt = (d: Date) =>
    d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center px-4 bg-black/60 backdrop-blur-sm"
      style={{
        zIndex: 200,
        paddingTop: 'calc(4rem + env(safe-area-inset-top))',
        paddingBottom: 'calc(4rem + env(safe-area-inset-bottom))',
      }}
      onClick={busy ? undefined : onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-full flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between bg-gradient-to-r from-brand-primary-soft to-white">
          <div>
            <h3 className="text-lg font-bold text-gray-900">Manage seasons</h3>
            <p className="text-xs text-gray-500">Rename, set active, or delete past seasons for this team.</p>
          </div>
          <button onClick={onClose} disabled={busy} className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 disabled:opacity-50" aria-label="Close">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="overflow-y-auto p-4 space-y-3 flex-1">
          {loading ? (
            <p className="text-sm text-gray-500 text-center py-6">Loading seasons…</p>
          ) : seasons.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-6">No seasons yet for this team.</p>
          ) : (
            seasons.map((s) => {
              const isEditing = editing?.id === s.id;
              return (
                <div key={s.id} className="rounded-xl ring-1 ring-gray-200 p-3">
                  {isEditing ? (
                    <div className="space-y-2">
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-primary text-base"
                        style={{ fontSize: '16px' }}
                      />
                      <div className="grid grid-cols-2 gap-2">
                        <input
                          type="date"
                          value={editStart}
                          onChange={(e) => setEditStart(e.target.value)}
                          className="border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-primary text-base"
                          style={{ fontSize: '16px' }}
                        />
                        <input
                          type="date"
                          value={editEnd}
                          onChange={(e) => setEditEnd(e.target.value)}
                          className="border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-primary text-base"
                          style={{ fontSize: '16px' }}
                        />
                      </div>
                      <div className="flex justify-end gap-2">
                        <button onClick={cancelEdit} disabled={busy} className="px-3 py-1.5 text-sm font-semibold text-gray-700">
                          Cancel
                        </button>
                        <button onClick={saveEdit} disabled={busy} className="bg-brand-primary hover:bg-brand-primary text-white font-semibold px-3 py-1.5 rounded-lg text-sm disabled:opacity-50">
                          Save
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-2 mb-1">
                        <p className="font-bold text-gray-900 truncate">{s.name}</p>
                        {s.isActive && (
                          <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 bg-emerald-50 ring-1 ring-emerald-200 px-1.5 py-0.5 rounded">
                            Active
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-500">{fmt(s.startDate)} → {fmt(s.endDate)}</p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <button onClick={() => startEdit(s)} disabled={busy} className="text-xs font-semibold text-gray-700 bg-gray-100 hover:bg-gray-200 px-2.5 py-1 rounded-full disabled:opacity-50">
                          Edit
                        </button>
                        {!s.isActive && (
                          <button onClick={() => setActive(s)} disabled={busy} className="text-xs font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 ring-1 ring-emerald-200 px-2.5 py-1 rounded-full disabled:opacity-50">
                            Set active
                          </button>
                        )}
                        <button onClick={() => remove(s)} disabled={busy} className="text-xs font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 ring-1 ring-rose-200 px-2.5 py-1 rounded-full disabled:opacity-50">
                          Delete
                        </button>
                      </div>
                    </>
                  )}
                </div>
              );
            })
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <div className="border-t border-gray-100 p-3 text-center bg-gray-50">
          <button onClick={onClose} disabled={busy} className="text-sm font-semibold text-gray-700 disabled:opacity-50">
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default ManageSeasonsModal;

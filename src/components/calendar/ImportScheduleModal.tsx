import React, { useRef, useState } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { useTeam } from '../../contexts/TeamContext';
import { useFirestore } from '../../hooks/useFirestore';
import { parseIcs, classifyEvent, isDuplicate, ParsedIcsEvent } from '../../utils/icsImport';
import { CalendarEvent } from '../../types';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** Existing events on this team — used to flag duplicates. */
  existingEvents: Pick<CalendarEvent, 'title' | 'date'>[];
  /** Fired after a successful import so the parent can refresh. */
  onImported?: () => void;
}

interface ParsedRow {
  raw: ParsedIcsEvent;
  selected: boolean;
  isDup: boolean;
}

const ImportScheduleModal: React.FC<Props> = ({ isOpen, onClose, existingEvents, onImported }) => {
  const { userData } = useAuth();
  const { selectedTeamId, selectedTeam } = useTeam();
  const { addEvent } = useFirestore();

  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  const reset = () => {
    setRows([]);
    setFileName(null);
    setWarnings([]);
    setError(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handlePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setError(null);
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    try {
      const text = await file.text();
      const { events, warnings: ws } = parseIcs(text);
      if (events.length === 0) {
        setError("Couldn't find any events in that file. Make sure it's a .ics export.");
        return;
      }
      const parsedRows: ParsedRow[] = events.map((raw) => {
        const isDup = existingEvents.some((ex) => isDuplicate(raw, ex));
        return { raw, selected: !isDup, isDup };
      });
      setRows(parsedRows);
      setWarnings(ws);
    } catch (err) {
      console.error('[import] parse failed', err);
      setError('Could not read that file. Please try again.');
    }
  };

  const handleImport = async () => {
    if (!userData || !selectedTeamId) return;
    const picked = rows.filter((r) => r.selected);
    if (picked.length === 0) return;
    setImporting(true);
    try {
      const teamName = selectedTeam?.name || '';
      for (const row of picked) {
        const cls = classifyEvent(row.raw.title, teamName);
        // Build the new event. Omit empty optional fields so Firestore
        // doesn't error on `undefined`.
        const data: any = {
          title: row.raw.title,
          date: row.raw.date,
          location: row.raw.location || '',
          type: cls.type,
          teamId: selectedTeamId,
          createdBy: userData.uid,
          createdByName: userData.name,
        };
        if (row.raw.description) data.description = row.raw.description;
        if (cls.opponent) data.opponent = cls.opponent;
        if (cls.homeAway) data.homeAway = cls.homeAway;
        await addEvent(data);
      }
      onImported?.();
      reset();
      onClose();
    } catch (err) {
      console.error('[import] failed', err);
      setError('Some events failed to import. Please try again.');
    } finally {
      setImporting(false);
    }
  };

  const allSelected = rows.length > 0 && rows.every((r) => r.selected);
  const toggleAll = () => {
    setRows((prev) => prev.map((r) => ({ ...r, selected: !allSelected })));
  };
  const toggleRow = (i: number) => {
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, selected: !r.selected } : r)));
  };

  const fmt = (d: Date) =>
    d.toLocaleString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });

  return (
    <div
      className="fixed inset-0 flex items-center justify-center px-4 bg-black/60 backdrop-blur-sm"
      style={{
        zIndex: 100,
        paddingTop: 'calc(4rem + env(safe-area-inset-top))',
        paddingBottom: 'calc(4rem + env(safe-area-inset-bottom))',
      }}
      onClick={handleClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-full flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between bg-gradient-to-r from-cyan-50 to-white">
          <div>
            <h3 className="text-lg font-bold text-gray-900">Import Schedule</h3>
            <p className="text-xs text-gray-500">Upload an .ics file exported from GotSoccer, Demosphere, TeamSnap, Google Calendar, etc.</p>
          </div>
          <button onClick={handleClose} className="p-2 rounded-lg hover:bg-gray-100 text-gray-500" aria-label="Close">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {rows.length === 0 ? (
            <div className="p-6">
              <label
                htmlFor="ics-file"
                className="block border-2 border-dashed border-cyan-300 rounded-2xl p-8 text-center cursor-pointer hover:bg-cyan-50 transition-colors"
              >
                <svg className="w-12 h-12 mx-auto mb-3 text-cyan-500" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
                </svg>
                <p className="font-semibold text-gray-900">Choose a .ics file</p>
                <p className="text-sm text-gray-500 mt-1">{fileName ? fileName : 'or drag and drop here'}</p>
                <input
                  ref={inputRef}
                  id="ics-file"
                  type="file"
                  accept=".ics,text/calendar"
                  onChange={handlePick}
                  className="hidden"
                />
              </label>
              {error && <p className="mt-4 text-sm text-red-600 text-center">{error}</p>}
              <div className="mt-6 text-xs text-gray-500 space-y-1">
                <p className="font-semibold text-gray-700">Where do I find this?</p>
                <p>• <b>GotSoccer:</b> Team page → Schedule → "Export iCal" (or copy the .ics URL and save it as a file).</p>
                <p>• <b>Demosphere:</b> Team Schedule → Subscribe → "Download .ics".</p>
                <p>• <b>Google Calendar:</b> Settings → "Export" → unzip the file you get.</p>
                <p>• <b>Apple Calendar:</b> File → Export → "Export…"</p>
              </div>
            </div>
          ) : (
            <div className="p-6">
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm font-semibold text-gray-900">
                  Found {rows.length} event{rows.length === 1 ? '' : 's'}
                  {rows.some((r) => r.isDup) && (
                    <span className="ml-2 text-xs font-normal text-amber-700 bg-amber-50 px-2 py-0.5 rounded ring-1 ring-amber-200">
                      {rows.filter((r) => r.isDup).length} look like duplicates — unchecked
                    </span>
                  )}
                </p>
                <button onClick={toggleAll} className="text-xs font-semibold text-cyan-700 hover:text-cyan-900">
                  {allSelected ? 'Deselect all' : 'Select all'}
                </button>
              </div>
              <ul className="divide-y divide-gray-100 ring-1 ring-gray-200 rounded-xl overflow-hidden bg-white">
                {rows.map((row, i) => {
                  const cls = classifyEvent(row.raw.title, selectedTeam?.name || '');
                  const typePill =
                    cls.type === 'game' ? 'bg-rose-100 text-rose-700' :
                    cls.type === 'practice' ? 'bg-emerald-100 text-emerald-700' :
                    'bg-slate-100 text-slate-700';
                  return (
                    <li key={i} className={`p-3 flex items-start gap-3 ${row.selected ? '' : 'bg-gray-50'}`}>
                      <input
                        type="checkbox"
                        checked={row.selected}
                        onChange={() => toggleRow(i)}
                        className="mt-1 w-4 h-4 accent-cyan-600 flex-shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-gray-900 truncate">{row.raw.title}</span>
                          <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${typePill}`}>
                            {cls.type}
                          </span>
                          {row.isDup && (
                            <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">
                              Duplicate
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-gray-500 mt-0.5">{fmt(row.raw.date)}</p>
                        {row.raw.location && (
                          <p className="text-xs text-gray-500 truncate">📍 {row.raw.location}</p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
              {warnings.length > 0 && (
                <div className="mt-3 text-xs text-amber-700 bg-amber-50 ring-1 ring-amber-200 rounded-lg p-2">
                  {warnings.map((w, i) => <p key={i}>⚠️ {w}</p>)}
                </div>
              )}
              {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
            </div>
          )}
        </div>

        {rows.length > 0 && (
          <div className="border-t border-gray-100 p-4 flex items-center justify-between gap-3 bg-gray-50">
            <button onClick={reset} className="text-sm font-medium text-gray-600 hover:text-gray-900">
              Choose another file
            </button>
            <button
              onClick={handleImport}
              disabled={importing || rows.every((r) => !r.selected)}
              className="bg-cyan-600 hover:bg-cyan-700 disabled:bg-gray-300 text-white font-semibold rounded-xl px-5 py-2.5 transition-colors"
            >
              {importing ? 'Importing…' : `Import ${rows.filter((r) => r.selected).length} event${rows.filter((r) => r.selected).length === 1 ? '' : 's'}`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default ImportScheduleModal;

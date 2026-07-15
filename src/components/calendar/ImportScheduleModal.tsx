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
  const [feedUrl, setFeedUrl] = useState('');
  const [fetchingUrl, setFetchingUrl] = useState(false);
  // Date-range filter. dateFrom defaults to today on first parse so coaches
  // importing a whole season's schedule from Ollie / GotSoccer aren't
  // re-creating last August's games. Both fields use YYYY-MM-DD (the
  // native HTML date input format). Empty string = open-ended on that
  // side of the range.
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  const reset = () => {
    setRows([]);
    setFileName(null);
    setWarnings([]);
    setError(null);
    setFeedUrl('');
    setFetchingUrl(false);
    setDateFrom('');
    setDateTo('');
    if (inputRef.current) inputRef.current.value = '';
  };

  // YYYY-MM-DD for today, in the local timezone.
  const todayYmd = (): string => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  // Test whether a parsed row is currently in the date filter range.
  // Empty dateFrom / dateTo are treated as open-ended on that side.
  const isInRange = (row: ParsedRow): boolean => {
    if (!dateFrom && !dateTo) return true;
    const d = row.raw.date instanceof Date ? row.raw.date : new Date(row.raw.date);
    if (dateFrom) {
      const from = new Date(`${dateFrom}T00:00:00`);
      if (d < from) return false;
    }
    if (dateTo) {
      const to = new Date(`${dateTo}T23:59:59`);
      if (d > to) return false;
    }
    return true;
  };

  // Parse a chunk of .ics text into our row format. Shared by the
  // file picker and the URL-paste flow so they stay in sync.
  const ingestIcsText = (text: string, label: string) => {
    const { events, warnings: ws } = parseIcs(text);
    if (events.length === 0) {
      setError("Couldn't find any events in that file. Make sure it's a .ics export.");
      return;
    }
    const parsedRows: ParsedRow[] = events.map((raw) => {
      const isDup = existingEvents.some((ex) => isDuplicate(raw, ex));
      return { raw, selected: !isDup, isDup };
    });
    setFileName(label);
    setRows(parsedRows);
    setWarnings(ws);
    // Default the from-date filter to today so a coach importing a
    // full-season Ollie export doesn't get last fall's games. They can
    // clear it to see past events if they want to backfill history.
    setDateFrom((prev) => prev || todayYmd());
    setDateTo('');
  };

  const handleFetchUrl = async () => {
    const trimmed = feedUrl.trim();
    if (!trimmed) return;
    setError(null);
    setFetchingUrl(true);
    try {
      const { workerFetch, hasWorkerConfig } = await import('../../utils/workerFetch');
      if (!hasWorkerConfig()) {
        setError('Calendar URL import is not configured for this build.');
        return;
      }
      const res = await workerFetch('/ical-fetch', {
        method: 'POST',
        body: JSON.stringify({ url: trimmed }),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        const code = data?.error || `http-${res.status}`;
        if (code === 'not-ical') {
          setError("That URL didn't return calendar data. Make sure it's the iCal feed URL (usually ends with .ics).");
        } else if (code === 'invalid-url') {
          setError('Please paste a full https:// URL.');
        } else {
          setError(`Could not fetch that URL (${code}). Try downloading the .ics file instead.`);
        }
        return;
      }
      // Trim the URL down to a short label for the success state.
      let label = trimmed;
      try {
        const u = new URL(trimmed);
        label = u.hostname.replace(/^www\./, '') + (u.pathname.length > 1 ? u.pathname : '');
        if (label.length > 60) label = label.slice(0, 57) + '…';
      } catch { /* keep raw */ }
      ingestIcsText(data.text, label);
    } catch (err) {
      console.error('[import] url fetch failed', err);
      setError('Could not reach that URL. Check your connection and try again.');
    } finally {
      setFetchingUrl(false);
    }
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handlePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setError(null);
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      ingestIcsText(text, file.name);
    } catch (err) {
      console.error('[import] parse failed', err);
      setError('Could not read that file. Please try again.');
    }
  };

  const handleImport = async () => {
    if (!userData || !selectedTeamId) return;
    // Selected AND inside the date filter. A row that was selected
    // before the user narrowed the date window shouldn't sneak in.
    const picked = rows.filter((r) => r.selected && isInRange(r));
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

  // Visibility + selection both honor the date filter — out-of-range
  // rows are hidden AND ignored by toggleAll / import counts.
  const visibleRowIdxs = rows
    .map((r, i) => (isInRange(r) ? i : -1))
    .filter((i) => i >= 0);
  const allVisibleSelected =
    visibleRowIdxs.length > 0 &&
    visibleRowIdxs.every((i) => rows[i].selected);
  const toggleAll = () => {
    const next = !allVisibleSelected;
    setRows((prev) =>
      prev.map((r, i) => (visibleRowIdxs.includes(i) ? { ...r, selected: next } : r)),
    );
  };
  const toggleRow = (i: number) => {
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, selected: !r.selected } : r)));
  };
  const visibleSelectedCount = visibleRowIdxs.filter((i) => rows[i].selected).length;
  const filteredOutCount = rows.length - visibleRowIdxs.length;

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
        className="bg-surface-elevated rounded-2xl shadow-2xl w-full max-w-2xl max-h-full flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-line-default/10 flex items-center justify-between bg-surface-elevated">
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
              {/* Paste-URL path. Fast lane for live iCal feeds (Ollie,
                  GotSoccer, etc.) so coaches don't have to download
                  a file first. Proxied through the notify worker to
                  bypass browser CORS — most calendar feeds don't
                  serve CORS headers because they're built for
                  server-side calendar clients (Apple, Google). */}
              <div className="mb-5">
                <label htmlFor="ics-url" className="block text-xs font-semibold uppercase tracking-wider text-gray-700 mb-1.5">
                  Paste a calendar URL
                </label>
                <div className="flex gap-2">
                  <input
                    id="ics-url"
                    type="url"
                    inputMode="url"
                    autoCapitalize="off"
                    spellCheck={false}
                    placeholder="https://api.olliesports.com/ical/org-…"
                    value={feedUrl}
                    onChange={(e) => setFeedUrl(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleFetchUrl(); }}
                    className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary/40"
                  />
                  <button
                    type="button"
                    onClick={handleFetchUrl}
                    disabled={!feedUrl.trim() || fetchingUrl}
                    className="px-4 py-2 text-sm font-bold text-white bg-brand-primary hover:bg-brand-primary disabled:opacity-50 rounded-lg whitespace-nowrap"
                  >
                    {fetchingUrl ? 'Fetching…' : 'Fetch'}
                  </button>
                </div>
                <p className="mt-1.5 text-[11px] text-gray-500">
                  Works with Ollie, GotSoccer, Demosphere, TeamSnap — anything that gives you a public iCal feed URL.
                </p>
              </div>

              <div className="relative my-5">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-gray-200" />
                </div>
                <div className="relative flex justify-center text-[10px] uppercase tracking-widest text-gray-400">
                  <span className="bg-white px-2">or upload a file</span>
                </div>
              </div>

              <label
                htmlFor="ics-file"
                className="block border-2 border-dashed border-brand-primary-soft rounded-2xl p-8 text-center cursor-pointer hover:bg-brand-primary-soft transition-colors"
              >
                <svg className="w-12 h-12 mx-auto mb-3 text-brand-primary" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
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
                <p>• <b>Ollie:</b> Team page → Schedule → copy the iCal URL (looks like <code className="text-[10px]">api.olliesports.com/ical/…</code>). See note below for what to do with it.</p>
                <p>• <b>GotSoccer:</b> Team page → Schedule → "Export iCal" (or copy the .ics URL and save it as a file).</p>
                <p>• <b>Demosphere:</b> Team Schedule → Subscribe → "Download .ics".</p>
                <p>• <b>Google Calendar:</b> Settings → "Export" → unzip the file you get.</p>
                <p>• <b>Apple Calendar:</b> File → Export → "Export…"</p>
                <p className="mt-3 font-semibold text-gray-700">Got a URL, not a file?</p>
                <p>Open the URL in a browser (or paste it after the <code>?</code> in your address bar). Most platforms will download a .ics file you can pick here. On a Mac, you can also drag the URL into Apple Calendar → File → Export to convert.</p>
              </div>
            </div>
          ) : (
            <div className="p-6">
              {/* Date filter — coaches importing a whole season's
                  schedule usually don't want last year's matches
                  too. Defaults to today onwards on first parse;
                  clear it to backfill history. */}
              <div className="mb-4 rounded-xl ring-1 ring-slate-200 bg-white p-3">
                <div className="flex items-center justify-between mb-2.5">
                  <p className="text-[11px] font-extrabold tracking-widest uppercase text-slate-700">
                    Date filter
                  </p>
                  {(dateFrom || dateTo) && (
                    <button
                      onClick={() => { setDateFrom(''); setDateTo(''); }}
                      className="text-[12px] font-semibold text-brand-primary hover:text-brand-primary-dim"
                    >
                      Clear
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[11px] font-bold text-slate-700 mb-1">From</label>
                    <input
                      type="date"
                      value={dateFrom}
                      onChange={(e) => setDateFrom(e.target.value)}
                      // colorScheme: 'light' forces iOS / Safari to render the
                      // native date picker in light mode even when the system
                      // is in dark mode — otherwise the input renders dark-on-
                      // darker against our white card and is unreadable.
                      style={{ colorScheme: 'light' }}
                      className="w-full px-3 py-2 text-sm text-ink-primary border border-line-default rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary/40 bg-surface-input"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold text-slate-700 mb-1">To</label>
                    <input
                      type="date"
                      value={dateTo}
                      onChange={(e) => setDateTo(e.target.value)}
                      style={{ colorScheme: 'light' }}
                      className="w-full px-3 py-2 text-sm text-slate-900 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary/40 bg-white"
                    />
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between mb-3">
                <p className="text-sm font-semibold text-gray-900">
                  {visibleRowIdxs.length === rows.length ? (
                    <>Found {rows.length} event{rows.length === 1 ? '' : 's'}</>
                  ) : (
                    <>
                      {visibleRowIdxs.length} event{visibleRowIdxs.length === 1 ? '' : 's'} in range
                      <span className="ml-1 text-xs font-normal text-slate-500">
                        ({filteredOutCount} hidden by filter)
                      </span>
                    </>
                  )}
                  {rows.some((r) => r.isDup) && (
                    <span className="ml-2 text-xs font-normal text-amber-700 bg-amber-50 px-2 py-0.5 rounded ring-1 ring-amber-200">
                      {rows.filter((r) => r.isDup).length} duplicate{rows.filter((r) => r.isDup).length === 1 ? '' : 's'} — unchecked
                    </span>
                  )}
                </p>
                {visibleRowIdxs.length > 0 && (
                  <button onClick={toggleAll} className="text-xs font-semibold text-brand-primary hover:text-brand-primary-dim">
                    {allVisibleSelected ? 'Deselect all' : 'Select all'}
                  </button>
                )}
              </div>
              <ul className="divide-y divide-gray-100 ring-1 ring-line-default rounded-xl overflow-hidden bg-surface-elevated">
                {rows.map((row, i) => {
                  if (!isInRange(row)) return null;
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
                        className="mt-1 w-4 h-4 accent-brand-primary flex-shrink-0"
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
              disabled={importing || visibleSelectedCount === 0}
              className="bg-brand-primary hover:bg-brand-primary disabled:bg-gray-300 text-white font-semibold rounded-xl px-5 py-2.5 transition-colors"
            >
              {importing ? 'Importing…' : `Import ${visibleSelectedCount} event${visibleSelectedCount === 1 ? '' : 's'}`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default ImportScheduleModal;

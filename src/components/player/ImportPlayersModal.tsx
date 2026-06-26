import React, { useMemo, useState } from 'react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** The active team id — every imported player lands on this team. */
  teamId: string;
  /** Called per row at confirm time. Should write the player doc and
   *  resolve when done. Caller controls the actual Firestore write so
   *  this component stays UI-only. */
  onCreatePlayer: (row: ParsedPlayer) => Promise<void>;
}

export interface ParsedPlayer {
  firstName: string;
  lastName: string;
  name: string;
  dateOfBirth?: string;
  jerseyNumber?: number;
  position?: string;
  parentEmails: string[];
  parentNames: string[];
  parentPhones: string[];
}

// Minimal CSV parser. Handles quoted fields with commas and double-quote
// escapes ("" → "). Sports Connect exports are well-formed so we don't
// need PapaParse's full bag of edge cases.
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { inQuotes = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(cell => cell.trim() !== ''));
}

// Header → canonical field name. Lowercased + space/punct stripped for
// fuzzy match. First hit wins, so synonyms list MOST specific first.
const HEADER_MAP: Record<string, string> = {
  // names
  'firstname': 'firstName',
  'playerfirstname': 'firstName',
  'lastname': 'lastName',
  'playerlastname': 'lastName',
  'fullname': 'fullName',
  'playername': 'fullName',
  'name': 'fullName',
  // dob
  'dateofbirth': 'dob',
  'dob': 'dob',
  'birthdate': 'dob',
  'birthday': 'dob',
  // jersey
  'jerseynumber': 'jersey',
  'jersey': 'jersey',
  'number': 'jersey',
  'shirtnumber': 'jersey',
  // position
  'position': 'position',
  'primaryposition': 'position',
  // parent 1
  'parent1email': 'parent1Email',
  'parentemail': 'parent1Email',
  'parent1firstname': 'parent1First',
  'parent1lastname': 'parent1Last',
  'parent1name': 'parent1Name',
  'parent1phone': 'parent1Phone',
  'parent1cell': 'parent1Phone',
  // parent 2
  'parent2email': 'parent2Email',
  'parent2firstname': 'parent2First',
  'parent2lastname': 'parent2Last',
  'parent2name': 'parent2Name',
  'parent2phone': 'parent2Phone',
  'parent2cell': 'parent2Phone',
  // generic email/phone fallbacks (last-resort — Sports Connect
  // sometimes labels parent fields without a "Parent" prefix)
  'email': 'parent1Email',
  'phone': 'parent1Phone',
  'cell': 'parent1Phone',
};

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function rowsToPlayers(headers: string[], rows: string[][]): ParsedPlayer[] {
  const colMap: Record<number, string> = {};
  headers.forEach((h, i) => {
    const key = HEADER_MAP[normalizeHeader(h)];
    if (key) colMap[i] = key;
  });
  return rows.map(r => {
    const vals: Record<string, string> = {};
    Object.entries(colMap).forEach(([idx, key]) => {
      vals[key] = (r[Number(idx)] || '').trim();
    });
    const firstName = vals.firstName || (vals.fullName ? vals.fullName.split(' ')[0] : '');
    const lastName = vals.lastName || (vals.fullName ? vals.fullName.split(' ').slice(1).join(' ') : '');
    const name = `${firstName} ${lastName}`.trim() || vals.fullName || '';
    const parentEmails = [vals.parent1Email, vals.parent2Email].filter(e => e && /@/.test(e)).map(e => e.toLowerCase());
    const parent1Name = vals.parent1Name || `${vals.parent1First || ''} ${vals.parent1Last || ''}`.trim();
    const parent2Name = vals.parent2Name || `${vals.parent2First || ''} ${vals.parent2Last || ''}`.trim();
    const parentNames = [parent1Name, parent2Name].filter(Boolean);
    const parentPhones = [vals.parent1Phone, vals.parent2Phone].filter(Boolean);
    const jerseyNumber = vals.jersey && /^\d+$/.test(vals.jersey) ? parseInt(vals.jersey, 10) : undefined;
    return {
      firstName,
      lastName,
      name,
      dateOfBirth: vals.dob || undefined,
      jerseyNumber,
      position: vals.position || undefined,
      parentEmails,
      parentNames,
      parentPhones,
    };
  }).filter(p => p.name);
}

const ImportPlayersModal: React.FC<Props> = ({ isOpen, onClose, teamId, onCreatePlayer }) => {
  const [rawText, setRawText] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [doneCount, setDoneCount] = useState(0);
  const [failed, setFailed] = useState<string[]>([]);
  const [skipIdx, setSkipIdx] = useState<Set<number>>(new Set());

  const parsed = useMemo(() => {
    if (!rawText) return null;
    const rows = parseCSV(rawText);
    if (rows.length < 2) return { headers: [], players: [], totalRows: 0 };
    const headers = rows[0];
    const players = rowsToPlayers(headers, rows.slice(1));
    return { headers, players, totalRows: rows.length - 1 };
  }, [rawText]);

  const handleFile = async (file: File) => {
    const text = await file.text();
    setRawText(text);
    setSkipIdx(new Set());
    setDoneCount(0);
    setFailed([]);
  };

  const handleConfirm = async () => {
    if (!parsed) return;
    setImporting(true);
    setDoneCount(0);
    setFailed([]);
    for (let i = 0; i < parsed.players.length; i++) {
      if (skipIdx.has(i)) continue;
      const p = parsed.players[i];
      try {
        await onCreatePlayer(p);
        setDoneCount(c => c + 1);
      } catch (err) {
        console.error('Import row failed', p.name, err);
        setFailed(f => [...f, p.name]);
      }
    }
    setImporting(false);
  };

  const reset = () => {
    setRawText(null);
    setImporting(false);
    setDoneCount(0);
    setFailed([]);
    setSkipIdx(new Set());
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white w-full max-w-3xl rounded-2xl shadow-2xl max-h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between flex-shrink-0">
          <div>
            <h3 className="text-lg font-bold text-slate-900">Import players from CSV</h3>
            <p className="text-xs text-slate-500 mt-0.5">Sports Connect / Affinity exports work directly.</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {!parsed && (
            <div className="border-2 border-dashed border-slate-300 rounded-xl p-10 text-center">
              <p className="text-sm font-semibold text-slate-700 mb-2">Drop your CSV here</p>
              <p className="text-xs text-slate-500 mb-4">Export from Sports Connect → Reports → Roster → CSV.</p>
              <label className="inline-block px-4 py-2 rounded-lg bg-brand-primary hover:bg-brand-primary text-white text-sm font-bold cursor-pointer">
                Choose file
                <input
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); }}
                />
              </label>
            </div>
          )}

          {parsed && parsed.players.length === 0 && (
            <div className="text-center py-10">
              <p className="text-sm font-semibold text-rose-600">No players detected.</p>
              <p className="text-xs text-slate-500 mt-2">
                Couldn't match any columns to "First Name" / "Last Name" / "Player Name".
                Check that the header row uses standard names.
              </p>
              <button onClick={reset} className="mt-4 text-xs font-bold uppercase tracking-widest text-brand-primary">Try another file</button>
            </div>
          )}

          {parsed && parsed.players.length > 0 && !importing && doneCount === 0 && (
            <>
              <div className="mb-4 flex items-center justify-between gap-3">
                <p className="text-sm text-slate-700">
                  Found <b>{parsed.players.length}</b> player{parsed.players.length === 1 ? '' : 's'} in {parsed.totalRows} row{parsed.totalRows === 1 ? '' : 's'}.
                  Uncheck any rows to skip them.
                </p>
                <button onClick={reset} className="text-xs font-bold uppercase tracking-widest text-slate-500 hover:text-slate-800">
                  Change file
                </button>
              </div>
              <div className="border border-slate-200 rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-[10px] font-extrabold uppercase tracking-widest text-slate-600">
                    <tr>
                      <th className="px-2 py-2 text-left w-8"></th>
                      <th className="px-2 py-2 text-left">Name</th>
                      <th className="px-2 py-2 text-left">DOB</th>
                      <th className="px-2 py-2 text-left">Jersey</th>
                      <th className="px-2 py-2 text-left">Parents</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {parsed.players.map((p, i) => {
                      const skipped = skipIdx.has(i);
                      return (
                        <tr key={i} className={skipped ? 'opacity-40' : ''}>
                          <td className="px-2 py-1.5">
                            <input
                              type="checkbox"
                              checked={!skipped}
                              onChange={() => {
                                setSkipIdx(prev => {
                                  const next = new Set(prev);
                                  if (next.has(i)) next.delete(i); else next.add(i);
                                  return next;
                                });
                              }}
                            />
                          </td>
                          <td className="px-2 py-1.5 font-medium text-slate-900">{p.name}</td>
                          <td className="px-2 py-1.5 text-slate-600">{p.dateOfBirth || '—'}</td>
                          <td className="px-2 py-1.5 text-slate-600">{p.jerseyNumber ?? '—'}</td>
                          <td className="px-2 py-1.5 text-slate-600">
                            {p.parentEmails.length > 0 ? p.parentEmails.join(', ') : <span className="text-amber-600">no email — manual link later</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {(importing || doneCount > 0) && parsed && (
            <div className="text-center py-6">
              <p className="text-sm font-semibold text-slate-700">
                {importing ? 'Importing…' : 'Done.'} {doneCount} of {parsed.players.length - skipIdx.size} created.
              </p>
              {failed.length > 0 && (
                <div className="mt-3 text-left max-w-md mx-auto">
                  <p className="text-xs font-bold uppercase tracking-widest text-rose-600 mb-1">Failed ({failed.length})</p>
                  <ul className="text-xs text-rose-600">
                    {failed.map(n => <li key={n}>{n}</li>)}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-end gap-2 flex-shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-100 rounded-lg">
            {importing || doneCount > 0 ? 'Close' : 'Cancel'}
          </button>
          {parsed && parsed.players.length > 0 && !importing && doneCount === 0 && (
            <button
              onClick={handleConfirm}
              disabled={parsed.players.length - skipIdx.size === 0}
              className="px-4 py-2 text-sm font-bold text-white bg-brand-primary hover:bg-brand-primary disabled:opacity-50 rounded-lg"
            >
              Import {parsed.players.length - skipIdx.size} player{parsed.players.length - skipIdx.size === 1 ? '' : 's'} to team
            </button>
          )}
        </div>

        {teamId === '' && (
          <div className="px-5 py-2 bg-amber-50 text-amber-900 text-xs border-t border-amber-200">
            Select a team in the team picker before importing.
          </div>
        )}
      </div>
    </div>
  );
};

export default ImportPlayersModal;

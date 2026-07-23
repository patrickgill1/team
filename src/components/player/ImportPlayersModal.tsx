import React, { useMemo, useState } from 'react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** The active team id — every imported player lands on this team. */
  teamId: string;
  /** Called per row at confirm time. Should write the player doc and
   *  resolve with the new playerId (or void if the caller doesn't
   *  want to enable the Circle-invite fanout). Caller controls the
   *  actual Firestore write so this component stays UI-only. */
  onCreatePlayer: (row: ParsedPlayer) => Promise<string | void>;
  /** Optional. When provided AND the coach leaves the "Also send
   *  Circle invites" box checked, the modal calls this once per
   *  unique parent email captured across the import (dedupe across
   *  siblings). Resolve `true` for a successful send, `false` for a
   *  hard failure (caller should already have swallowed idempotent
   *  cases like "user already has an account" and returned true).
   *  Throwing is fine too — modal treats it as a failure. */
  onSendInvite?: (args: { playerId: string; email: string; playerName: string }) => Promise<boolean>;
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
  // Row-preserving pairing so display can show "Arturo Alonzo ·
  // arturo@..." instead of just the email. Entries kept only when
  // at least name or email is present. The flat arrays above stay
  // for backward compat with Players.tsx handleImportRow.
  parents: Array<{ name?: string; email?: string; phone?: string }>;
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
    const parent1Name = vals.parent1Name || `${vals.parent1First || ''} ${vals.parent1Last || ''}`.trim();
    const parent2Name = vals.parent2Name || `${vals.parent2First || ''} ${vals.parent2Last || ''}`.trim();
    const parent1Email = vals.parent1Email && /@/.test(vals.parent1Email) ? vals.parent1Email.toLowerCase() : '';
    const parent2Email = vals.parent2Email && /@/.test(vals.parent2Email) ? vals.parent2Email.toLowerCase() : '';
    const parents = [
      { name: parent1Name || undefined, email: parent1Email || undefined, phone: vals.parent1Phone || undefined },
      { name: parent2Name || undefined, email: parent2Email || undefined, phone: vals.parent2Phone || undefined },
    ].filter(p => p.name || p.email);
    const parentEmails = parents.map(p => p.email).filter((e): e is string => !!e);
    const parentNames = parents.map(p => p.name).filter((n): n is string => !!n);
    const parentPhones = parents.map(p => p.phone).filter((p): p is string => !!p);
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
      parents,
    };
  }).filter(p => p.name);
}

const ImportPlayersModal: React.FC<Props> = ({ isOpen, onClose, teamId, onCreatePlayer, onSendInvite }) => {
  const [rawText, setRawText] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [doneCount, setDoneCount] = useState(0);
  const [failed, setFailed] = useState<string[]>([]);
  const [skipIdx, setSkipIdx] = useState<Set<number>>(new Set());
  // Circle-invite fanout. Default ON per Patrick — the modal has the
  // parent emails right there and it saves the coach a round-trip
  // through the single-player "Add to circle" button 20 times.
  const [sendInvites, setSendInvites] = useState(true);
  // Set once we know how many unique emails we'll try. Zero until the
  // player-creation loop is done and we've built the dedupe set.
  const [invitesTotal, setInvitesTotal] = useState(0);
  const [invitesSent, setInvitesSent] = useState(0);
  const [inviteFailed, setInviteFailed] = useState<string[]>([]);
  const [invitePhase, setInvitePhase] = useState(false);

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
    setInvitesTotal(0);
    setInvitesSent(0);
    setInviteFailed([]);
    setInvitePhase(false);
  };

  const handleConfirm = async () => {
    if (!parsed) return;
    setImporting(true);
    setDoneCount(0);
    setFailed([]);
    setInvitesTotal(0);
    setInvitesSent(0);
    setInviteFailed([]);
    setInvitePhase(false);

    // Build the dedupe queue as we go. First occurrence of each
    // email wins — a sibling row that shares arturo@... with an
    // earlier row doesn't fire a second invite. We keep the map
    // in a plain local so we can walk it after the loop closes;
    // React state would be batched and stale here.
    const inviteQueue = new Map<string, { playerId: string; playerName: string }>();
    const wantInvites = sendInvites && !!onSendInvite;

    for (let i = 0; i < parsed.players.length; i++) {
      if (skipIdx.has(i)) continue;
      const p = parsed.players[i];
      try {
        const playerId = await onCreatePlayer(p);
        setDoneCount(c => c + 1);
        if (wantInvites && typeof playerId === 'string' && playerId) {
          for (const raw of p.parentEmails) {
            const email = String(raw || '').trim().toLowerCase();
            if (!email || !/^\S+@\S+\.\S+$/.test(email)) continue;
            if (inviteQueue.has(email)) continue;
            inviteQueue.set(email, { playerId, playerName: p.name });
          }
        }
      } catch (err) {
        console.error('Import row failed', p.name, err);
        setFailed(f => [...f, p.name]);
      }
    }

    // Invite fanout — sequential on purpose. A 30-family import will
    // take a few seconds; that's fine and safer for the worker + the
    // email provider than slamming them with Promise.all.
    if (wantInvites && inviteQueue.size > 0 && onSendInvite) {
      setInvitePhase(true);
      setInvitesTotal(inviteQueue.size);
      // Array.from — the codebase targets ES5 downlevel and can't
      // iterate a Map directly (TS2802).
      for (const [email, meta] of Array.from(inviteQueue.entries())) {
        try {
          const ok = await onSendInvite({
            playerId: meta.playerId,
            email,
            playerName: meta.playerName,
          });
          if (ok) {
            setInvitesSent(c => c + 1);
          } else {
            setInviteFailed(f => [...f, email]);
          }
        } catch (err) {
          console.warn('Circle invite failed for', email, err);
          setInviteFailed(f => [...f, email]);
        }
      }
      setInvitePhase(false);
    }

    setImporting(false);
  };

  const reset = () => {
    setRawText(null);
    setImporting(false);
    setDoneCount(0);
    setFailed([]);
    setSkipIdx(new Set());
    setInvitesTotal(0);
    setInvitesSent(0);
    setInviteFailed([]);
    setInvitePhase(false);
    // Reset the invite toggle to its default when a fresh file is
    // loaded. Without this the modal remembers a prior "unchecked"
    // state across files, silently skipping invites on subsequent
    // imports.
    setSendInvites(true);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-surface-base w-full max-w-3xl rounded-2xl shadow-2xl max-h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-line-default/20 flex items-center justify-between flex-shrink-0">
          <div>
            <h3 className="text-lg font-bold text-ink-primary">Add your roster from a spreadsheet</h3>
            <p className="text-xs text-ink-primary/60 mt-0.5">Sports Connect and Affinity exports work directly.</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-2 -m-2 rounded-lg text-ink-primary/45 hover:text-ink-primary hover:bg-line-default/10">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {!parsed && (
            <div className="border-2 border-dashed border-line-default/30 rounded-xl p-10 text-center">
              <p className="text-sm font-semibold text-ink-primary/85 mb-2">Drop your CSV here</p>
              <p className="text-xs text-ink-primary/60 mb-4">Export from Sports Connect: Reports, Roster, CSV.</p>
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
              <p className="text-sm font-semibold text-rose-500">No players detected.</p>
              <p className="text-xs text-ink-primary/60 mt-2">
                We couldn't find any names in this file. Make sure the first row has "First Name",
                "Last Name", or "Player Name" and try again.
              </p>
              <button onClick={reset} className="mt-4 text-xs font-bold uppercase tracking-widest text-brand-primary">Try another file</button>
            </div>
          )}

          {parsed && parsed.players.length > 0 && !importing && doneCount === 0 && (
            <>
              <div className="mb-4 flex items-center justify-between gap-3">
                <p className="text-sm text-ink-primary/85">
                  Found <b>{parsed.players.length}</b> in {parsed.totalRows} row{parsed.totalRows === 1 ? '' : 's'}. Tap any to leave out.
                </p>
                <button onClick={reset} className="text-xs font-bold uppercase tracking-widest text-ink-primary/60 hover:text-ink-primary">
                  Change file
                </button>
              </div>
              <div className="border border-line-default/20 rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-surface-input text-[10px] font-extrabold uppercase tracking-widest text-ink-primary/70">
                    <tr>
                      <th className="px-2 py-2 text-left w-8"></th>
                      <th className="px-2 py-2 text-left">Name</th>
                      <th className="px-2 py-2 text-left">DOB</th>
                      <th className="px-2 py-2 text-left">Jersey</th>
                      <th className="px-2 py-2 text-left">Parents</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line-default/10">
                    {parsed.players.map((p, i) => {
                      const skipped = skipIdx.has(i);
                      const toggle = () => setSkipIdx(prev => {
                        const next = new Set(prev);
                        if (next.has(i)) next.delete(i); else next.add(i);
                        return next;
                      });
                      return (
                        <tr key={i} className={skipped ? 'opacity-40' : ''}>
                          <td className="px-2 py-1.5">
                            <label className="flex items-center justify-center h-8 w-8 -m-1 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={!skipped}
                                onChange={toggle}
                                aria-label={`Include ${p.name}`}
                                className="h-4 w-4"
                              />
                            </label>
                          </td>
                          <td className="px-2 py-1.5 font-medium text-ink-primary">{p.name}</td>
                          <td className="px-2 py-1.5 text-ink-primary/70">{p.dateOfBirth || '·'}</td>
                          <td className="px-2 py-1.5 text-ink-primary/70">{p.jerseyNumber ?? '·'}</td>
                          <td className="px-2 py-1.5 text-ink-primary/70">
                            {p.parents.length === 0 ? (
                              <span className="text-amber-500">no parent info (add later)</span>
                            ) : (
                              <div className="space-y-0.5">
                                {p.parents.map((par, pi) => (
                                  <div key={pi}>
                                    {par.name && <span className="text-ink-primary font-medium">{par.name}</span>}
                                    {par.name && par.email && <span className="text-ink-primary/40"> · </span>}
                                    {par.email
                                      ? <span>{par.email}</span>
                                      : par.name && <span className="text-amber-500 text-xs"> (no email)</span>
                                    }
                                  </div>
                                ))}
                              </div>
                            )}
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
              <p className="text-sm font-semibold text-ink-primary/85">
                {importing || invitePhase ? 'Adding to your squad…' : 'Squad added.'} {doneCount} of {parsed.players.length - skipIdx.size}.
              </p>
              {failed.length > 0 && (
                <div className="mt-3 text-left max-w-md mx-auto">
                  <p className="text-xs font-bold uppercase tracking-widest text-rose-500 mb-1">Failed ({failed.length})</p>
                  <ul className="text-xs text-rose-500">
                    {failed.map(n => <li key={n}>{n}</li>)}
                  </ul>
                </div>
              )}
              {invitePhase && (
                <p className="text-sm font-semibold text-ink-primary/85 mt-3">
                  {invitesTotal > 0
                    ? `Sending Circle invites… ${invitesSent + inviteFailed.length} of ${invitesTotal}.`
                    : 'Sending Circle invites…'}
                </p>
              )}
              {!invitePhase && doneCount > 0 && sendInvites && invitesTotal === 0 && (
                <p className="text-xs text-ink-primary/60 mt-3">
                  No emails to invite. Add family to each player's Circle later.
                </p>
              )}
              {!invitePhase && invitesTotal > 0 && (
                <p className="text-sm font-semibold text-ink-primary/85 mt-3">
                  {inviteFailed.length === 0
                    ? `Sent ${invitesSent} Circle invite${invitesSent === 1 ? '' : 's'}.`
                    : `Sent ${invitesSent} Circle invite${invitesSent === 1 ? '' : 's'}. ${inviteFailed.length} didn't reach (see below).`}
                </p>
              )}
              {inviteFailed.length > 0 && (
                <div className="mt-3 text-left max-w-md mx-auto">
                  <p className="text-xs font-bold uppercase tracking-widest text-rose-500 mb-1">Couldn't reach ({inviteFailed.length})</p>
                  <ul className="text-xs text-rose-500 break-all">
                    {inviteFailed.map(e => <li key={e}>{e}</li>)}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-line-default/20 flex flex-col gap-3 flex-shrink-0">
          {parsed && parsed.players.length > 0 && !importing && doneCount === 0 && onSendInvite && (
            <label
              className="flex items-start gap-3 p-3 rounded-xl bg-surface-elevated ring-1 ring-line-default/15 cursor-pointer select-none"
            >
              <input
                type="checkbox"
                checked={sendInvites}
                onChange={(e) => setSendInvites(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-line-default text-brand-primary focus:ring-2 focus:ring-brand-primary/40"
              />
              <span className="flex-1 leading-tight">
                <span className="block text-sm font-semibold text-ink-primary">Also invite everyone on these rows into each kid's Circle</span>
                <span className="block text-xs text-ink-primary/65 mt-0.5">Anyone we found an email for. They can join whether or not they already have a GoalKickr account.</span>
              </span>
            </label>
          )}
          <div className="flex items-center justify-end gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm font-bold text-ink-primary/85 hover:bg-line-default/10 rounded-lg">
              {importing || doneCount > 0 ? 'Close' : 'Cancel'}
            </button>
            {parsed && parsed.players.length > 0 && !importing && doneCount === 0 && (
              <button
                onClick={handleConfirm}
                disabled={parsed.players.length - skipIdx.size === 0}
                className="px-4 py-2 text-sm font-bold text-white bg-brand-primary hover:bg-brand-primary disabled:opacity-50 rounded-lg"
              >
                Add {parsed.players.length - skipIdx.size} to your squad
              </button>
            )}
          </div>
        </div>

        {teamId === '' && (
          <div className="px-5 py-2 bg-amber-500/15 text-amber-700 text-xs border-t border-amber-500/25">
            Pick a team in the team picker before importing.
          </div>
        )}
      </div>
    </div>
  );
};

export default ImportPlayersModal;

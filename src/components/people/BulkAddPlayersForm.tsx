// @ts-nocheck
import React, { useState } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { useFirestore } from '../../hooks/useFirestore';
import { createPlayerInvite, inviteUrl } from '../../utils/invites';
import { sendEmail } from '../../utils/notify';
import { buildParentInviteEmail } from '../../utils/inviteEmails';

// Shared bulk add-player + invite-parent form. Used by:
//   - /onboarding wizard's roster step
//   - /people/add standalone page
//
// Multi-row form: First Name / Last Name / Parent Email. Each row
// with at least a first OR last name creates a Player doc. If the
// row also has a valid parent email, a per-player invite is
// generated and emailed to the parent.

export interface BulkAddResult {
  created: number;
  invitesSent: number;
}

interface Props {
  teamId: string;
  teamName: string;
  onComplete: (result: BulkAddResult) => void;
  onSkip?: () => void;
  primaryLabel?: string;
  skipLabel?: string;
  initialRowCount?: number;
}

interface RosterRow {
  firstName: string;
  lastName: string;
  parentEmail: string;
}

const BLANK_ROW: RosterRow = { firstName: '', lastName: '', parentEmail: '' };

const BulkAddPlayersForm: React.FC<Props> = ({
  teamId,
  teamName,
  onComplete,
  onSkip,
  primaryLabel = 'Add players + send parent invites',
  skipLabel = 'Skip for now',
  initialRowCount = 6,
}) => {
  const { userData, currentUser } = useAuth();
  const { addPlayer } = useFirestore();

  const [rows, setRows] = useState<RosterRow[]>(
    Array.from({ length: initialRowCount }, () => ({ ...BLANK_ROW }))
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateRow = (i: number, patch: Partial<RosterRow>) => {
    setRows(prev => {
      const next = [...prev];
      next[i] = { ...next[i], ...patch };
      return next;
    });
  };

  const removeRow = (i: number) => {
    setRows(prev => prev.filter((_, idx) => idx !== i));
  };

  const handleSubmit = async () => {
    if (!userData || !teamId) {
      setError('No team yet — please refresh and try again.');
      return;
    }
    setError(null);
    const valid = rows.filter(r => r.firstName.trim() || r.lastName.trim());
    if (valid.length === 0) {
      onComplete({ created: 0, invitesSent: 0 });
      return;
    }
    setBusy(true);
    let created = 0;
    let invitesSent = 0;
    try {
      const coachName = userData.name || 'Your coach';
      const coachFirstName = coachName.split(' ')[0] || 'Coach';

      for (const row of valid) {
        const name = `${row.firstName.trim()} ${row.lastName.trim()}`.trim();
        if (!name) continue;

        const playerId = await addPlayer({
          name,
          teamId,
          teamIds: [teamId],
          parentIds: [],
          parentEmails: row.parentEmail.trim() ? [row.parentEmail.trim().toLowerCase()] : [],
          isActive: true,
        });
        if (!playerId) continue;
        created++;

        const email = row.parentEmail.trim();
        if (email && /^\S+@\S+\.\S+$/.test(email)) {
          try {
            const inv = await createPlayerInvite({
              teamId,
              playerId,
              createdBy: userData.uid,
              ttlDays: 30,
              note: `Bulk roster invite for ${name}`,
            });
            const link = inviteUrl(inv.id);
            const { subject, html, text } = buildParentInviteEmail({
              to: email,
              playerName: name,
              teamName,
              coachName,
              coachFirstName,
              inviteLink: link,
            });
            const ok = await sendEmail({ to: email, subject, html, text });
            if (ok) invitesSent++;
          } catch (e) {
            console.warn('roster invite failed for', email, e);
          }
        }
      }
      onComplete({ created, invitesSent });
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  };

  // Helper for the email status icon shown to the right of each
  // row — a quick visual signal of "this row will email the parent"
  // vs "this row will just create the player and you'll share a link
  // yourself later."
  const emailLooksValid = (e: string) => /^\S+@\S+\.\S+$/.test(e.trim());

  return (
    <div>
      {/* Explainer banner so the coach knows what each row will do.
          Patrick: "why is the email optional? they need to be
          invited, or will it share a link, or what?" */}
      <div className="rounded-md bg-charcoal-950 ring-1 ring-white/10 px-3 py-2.5 mb-4 text-charcoal-300 text-xs leading-relaxed">
        <span className="text-bone font-bold">With a parent email:</span> they get a branded GoalKickr invite immediately.
        <br />
        <span className="text-bone font-bold">Without:</span> we&apos;ll still add the player — you can grab a join link from the Team page and share it however you like.
      </div>

      <div className="space-y-3">
        {rows.map((row, i) => {
          const hasEmail = emailLooksValid(row.parentEmail);
          const hasName = !!(row.firstName.trim() || row.lastName.trim());
          return (
            <div key={i} className="relative rounded-lg bg-charcoal-950 ring-1 ring-white/10 p-3 space-y-2">
              {rows.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeRow(i)}
                  aria-label="Remove row"
                  className="absolute top-2 right-2 w-6 h-6 rounded-full text-bone/40 hover:text-bone hover:bg-white/5 flex items-center justify-center transition"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                </button>
              )}
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="text"
                  value={row.firstName}
                  onChange={e => updateRow(i, { firstName: e.target.value })}
                  className="w-full rounded-md bg-charcoal-900 ring-1 ring-white/10 focus:ring-crimson-500 focus:outline-none px-3 py-2.5 text-bone placeholder-charcoal-500 text-sm"
                  placeholder="First name"
                  autoComplete="off"
                />
                <input
                  type="text"
                  value={row.lastName}
                  onChange={e => updateRow(i, { lastName: e.target.value })}
                  className="w-full rounded-md bg-charcoal-900 ring-1 ring-white/10 focus:ring-crimson-500 focus:outline-none px-3 py-2.5 text-bone placeholder-charcoal-500 text-sm"
                  placeholder="Last name"
                  autoComplete="off"
                />
              </div>
              <input
                type="email"
                value={row.parentEmail}
                onChange={e => updateRow(i, { parentEmail: e.target.value })}
                className="w-full rounded-md bg-charcoal-900 ring-1 ring-white/10 focus:ring-crimson-500 focus:outline-none px-3 py-2.5 text-bone placeholder-charcoal-500 text-sm"
                placeholder="Parent email"
                autoComplete="off"
              />
              {hasName && (
                <p className={`text-[11px] font-bold flex items-center gap-1.5 ${hasEmail ? 'text-emerald-400' : 'text-amber-400/80'}`}>
                  {hasEmail ? (
                    <>
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12" /></svg>
                      Parent will get an emailed invite
                    </>
                  ) : (
                    <>
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
                      Player created without an emailed invite
                    </>
                  )}
                </p>
              )}
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={() => setRows(rs => [...rs, { ...BLANK_ROW }])}
        className="mt-3 w-full px-4 py-2 rounded-md text-bone/75 text-sm font-bold ring-1 ring-white/10 hover:bg-white/5 transition"
      >
        + Add another player
      </button>

      {error && (
        <div className="mt-4 rounded-md bg-crimson-950/40 ring-1 ring-crimson-700/40 px-3 py-2 text-crimson-100 text-sm">
          {error}
        </div>
      )}

      <button
        type="button"
        onClick={handleSubmit}
        disabled={busy}
        className="mt-6 w-full px-5 py-3 rounded-md font-bold text-sm bg-crimson-600 hover:bg-crimson-500 text-white shadow-lg shadow-crimson-900/40 ring-1 ring-crimson-400/20 transition disabled:opacity-60 disabled:cursor-wait"
      >
        {busy ? 'Adding players…' : primaryLabel}
      </button>

      {onSkip && (
        <button
          type="button"
          onClick={onSkip}
          className="mt-3 w-full px-5 py-3 rounded-md font-bold text-sm ring-1 ring-white/15 text-bone hover:bg-white/5 transition"
        >
          {skipLabel}
        </button>
      )}
    </div>
  );
};

export default BulkAddPlayersForm;

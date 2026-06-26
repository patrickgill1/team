// @ts-nocheck
import React, { useState } from 'react';
import { Sheet, Button } from '../ui';
import { useAuth } from '../../hooks/useAuth';
import { useTeam } from '../../contexts/TeamContext';
import { openTicket } from '../../utils/tickets';
import type { SupportTicketScope as TicketScope } from '../../types';

/**
 * Bottom-sheet form to open a new support ticket. Two scopes:
 *   'club'     — parent or coach asking THEIR club for help
 *   'platform' — anyone asking GoalKickr for help
 *
 * Patrick's rationale: clubs wanted a unified ticketing system for
 * their parents (replaces messy text/email threads). GoalKickr
 * itself needs a way to surface coach/admin issues so support
 * emails stop slipping through the cracks.
 */

interface Props {
  open: boolean;
  onClose: () => void;
  /** When set, locks the scope picker. Used from the dedicated
   *  'Contact GoalKickr' button so the user can't accidentally file
   *  to their own club instead. */
  forceScope?: TicketScope;
  onCreated?: (ticketId: string) => void;
}

const NewTicketSheet: React.FC<Props> = ({ open, onClose, forceScope, onCreated }) => {
  const { userData, currentUser } = useAuth();
  const { selectedTeam } = useTeam();
  const [scope, setScope] = useState<TicketScope>(forceScope || 'club');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clubId = (selectedTeam as any)?.clubId || null;
  const canFileClub = !!clubId;

  // If forceScope wants 'club' but the user has no clubId, fall back
  // to platform so they're never stuck staring at a disabled form.
  React.useEffect(() => {
    if (forceScope) setScope(forceScope);
    else if (scope === 'club' && !canFileClub) setScope('platform');
  }, [forceScope, canFileClub, scope]);

  const handleSubmit = async () => {
    if (busy) return;
    if (!subject.trim() || !body.trim()) {
      setError('Subject and message are both required.');
      return;
    }
    const uid = userData?.uid || currentUser?.uid;
    if (!uid) { setError('You need to be signed in.'); return; }
    setBusy(true); setError(null);
    try {
      const id = await openTicket({
        scope,
        subject,
        body,
        clubId: scope === 'club' ? clubId : undefined,
        teamId: (selectedTeam as any)?.id,
        authorUid: uid,
        authorName: userData?.name || 'Member',
        authorEmail: userData?.email || currentUser?.email || '',
      });
      setSubject(''); setBody('');
      onCreated?.(id);
      onClose();
    } catch (e: any) {
      setError(e?.message || 'Could not submit the ticket. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="New support ticket">
      <div className="space-y-4">
        {!forceScope && (
          <div>
            <p className="text-[11px] font-extrabold tracking-widest uppercase text-bone/55 mb-2">Who should see this?</p>
            <div className="grid grid-cols-2 gap-2">
              <ScopeCard
                active={scope === 'club'}
                disabled={!canFileClub}
                title="My club"
                hint={canFileClub ? 'Coaches and club admins respond.' : 'Join a club first.'}
                onClick={() => canFileClub && setScope('club')}
              />
              <ScopeCard
                active={scope === 'platform'}
                title="GoalKickr support"
                hint="App bugs, billing, accounts."
                onClick={() => setScope('platform')}
              />
            </div>
          </div>
        )}

        <label className="block">
          <span className="text-[11px] font-extrabold tracking-widest uppercase text-bone/55 mb-1.5 block">Subject</span>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            maxLength={200}
            placeholder="Short summary"
            className="w-full bg-charcoal-900 border border-white/10 rounded-lg px-3 py-3 text-bone placeholder:text-bone/30 focus:outline-none focus:border-brand-primary"
          />
        </label>
        <label className="block">
          <span className="text-[11px] font-extrabold tracking-widest uppercase text-bone/55 mb-1.5 block">Details</span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={6}
            maxLength={4000}
            placeholder="Tell us what's going on. The more detail, the faster the fix."
            className="w-full bg-charcoal-900 border border-white/10 rounded-lg px-3 py-3 text-bone placeholder:text-bone/30 focus:outline-none focus:border-brand-primary resize-none"
          />
          <p className="text-right text-bone/30 text-[10px] mt-1">{body.length}/4000</p>
        </label>
        {error && <p className="text-rose-300 text-xs bg-rose-500/10 border border-rose-500/30 rounded-lg p-2">{error}</p>}
        <Button variant="primary" onClick={handleSubmit} disabled={busy || !subject.trim() || !body.trim()} fullWidth>
          {busy ? 'Sending...' : 'Submit ticket'}
        </Button>
      </div>
    </Sheet>
  );
};

const ScopeCard: React.FC<{ active: boolean; disabled?: boolean; title: string; hint: string; onClick: () => void }> = ({ active, disabled, title, hint, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={`text-left p-3 rounded-lg border transition-colors disabled:opacity-40 ${
      active
        ? 'border-brand-primary bg-brand-primary/10'
        : 'border-white/10 bg-charcoal-900 hover:border-white/20'
    }`}
  >
    <p className={`font-bold text-sm ${active ? 'text-bone' : 'text-bone/85'}`}>{title}</p>
    <p className="text-[11px] text-bone/55 mt-0.5 leading-snug">{hint}</p>
  </button>
);

export default NewTicketSheet;

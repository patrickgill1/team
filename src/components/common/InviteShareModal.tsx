import React, { useState } from 'react';
import { addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { useAuth } from '../../hooks/useAuth';
import { inviteUrl, smsShareLink, type FetchedInvite } from '../../utils/invites';
import { PLAY_STORE_LIVE, ANDROID_BETA_OPEN, ANDROID_BETA_OPTIN_URL } from '../../utils/appAvailability';
import { debugWarn } from '../../utils/debug';
import type { Invite } from '../../types';

// Monoline glyphs — replaced the emoji labels that the modal used
// through v3.9.246 to comply with the no-emojis-in-UI rule
// (feedback_no_emojis.md). Stroke-based so they inherit currentColor
// and stay crisp at any size.
const CopyGlyph: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </svg>
);
const CheckGlyph: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d="M5 12l5 5L20 7" />
  </svg>
);
const MessageGlyph: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10l-4 4v-4H6a2 2 0 0 1-2-2V5z" />
  </svg>
);
const ShareGlyph: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d="M12 3v12" />
    <path d="M7 8l5-5 5 5" />
    <path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" />
  </svg>
);

/**
 * Shared modal for any flow that has just created an invite. Renders the
 * shareable link with Copy / SMS / Done buttons. Caller is responsible for
 * actually creating the invite — this is presentational.
 */

interface Props {
  invite: Invite | FetchedInvite | null;
  open: boolean;
  onClose: () => void;
  // Optional context to personalize the share copy.
  playerName?: string;
}

const InviteShareModal: React.FC<Props> = ({ invite, open, onClose, playerName }) => {
  const { userData } = useAuth();
  const [copied, setCopied] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  // Fast-track state — coach types the parent's email so Patrick
  // can batch-paste them into Play Console. Progressive disclosure:
  // form is hidden until the "Fast-track this parent..." link is
  // tapped, so the primary share flow stays clean.
  const [fastTrackOpen, setFastTrackOpen] = useState(false);
  const [fastTrackEmail, setFastTrackEmail] = useState('');
  const [fastTrackNote, setFastTrackNote] = useState('');
  const [fastTrackBusy, setFastTrackBusy] = useState(false);
  const [fastTrackSubmitted, setFastTrackSubmitted] = useState(false);

  if (!open || !invite) return null;

  const url = inviteUrl(invite.id);
  const code = invite.id;
  // Player invites carry playerId + teamId — use those for context on
  // the fast-track queue row. Staff invites don't, so the section
  // hides for coach/manager invites (fast-track is a parent flow).
  const inviteAsAny: any = invite;
  const invitePlayerId: string | undefined = inviteAsAny.playerId;
  const inviteTeamId: string | undefined = inviteAsAny.teamId;
  const showFastTrackSection = invite.type === 'player'
    && !PLAY_STORE_LIVE
    && !!userData
    && !!invitePlayerId;
  const subject = invite.type === 'player' && playerName ? `${playerName}'s GoalKickr profile` : 'Join GoalKickr';
  const smsBody =
    invite.type === 'player' && playerName
      ? `Join ${playerName} on GoalKickr: ${url}`
      : invite.type === 'coach'
        ? `Coach invite for GoalKickr: ${url}`
        : invite.type === 'team_manager'
          ? `Team manager invite for GoalKickr: ${url}`
          : `Join GoalKickr: ${url}`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback prompt
      window.prompt('Copy this link:', url);
    }
  };

  const handleCopyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 2000);
    } catch {
      window.prompt('Copy this code:', code);
    }
  };

  const submitFastTrack = async () => {
    if (fastTrackBusy) return;
    const email = fastTrackEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      alert('Please enter a valid email address.');
      return;
    }
    if (!userData || !invitePlayerId) return;
    setFastTrackBusy(true);
    try {
      const doc: any = {
        email,
        playerId: invitePlayerId,
        playerName: playerName || null,
        teamId: inviteTeamId || null,
        requestedByUid: (userData as any).uid,
        requestedByName: (userData as any).name || 'Coach',
        requestedAt: serverTimestamp(),
        status: 'pending',
      };
      if (fastTrackNote.trim()) doc.note = fastTrackNote.trim().slice(0, 200);
      await addDoc(collection(db, 'beta_requests'), doc);
      setFastTrackSubmitted(true);
      setFastTrackEmail('');
      setFastTrackNote('');
      setTimeout(() => setFastTrackSubmitted(false), 4000);
    } catch (err) {
      debugWarn('[fast-track] submit failed', err);
      alert('Could not submit. Try again.');
    } finally {
      setFastTrackBusy(false);
    }
  };

  const handleSms = () => {
    const link = `sms:&body=${encodeURIComponent(smsBody)}`;
    window.location.href = link;
  };

  const handleNativeShare = async () => {
    if (typeof navigator.share === 'function') {
      try {
        // Share only the URL. Picking Copy from the sheet then puts
        // just the link on the clipboard — no explainer text getting
        // pasted into wherever the recipient goes next. The dedicated
        // Text button below still uses smsBody when the intent IS to
        // send a full message.
        await navigator.share({ title: subject, url });
      } catch (err: any) {
        if (err?.name !== 'AbortError') console.warn('share failed', err);
      }
    } else {
      handleCopy();
    }
  };

  const labelByType: Record<string, string> = {
    player: playerName ? `Invite a parent for ${playerName}` : 'Player invite',
    coach: invite.role === 'head_coach' ? 'Head coach invite' : 'Assistant coach invite',
    team_manager: 'Team manager invite',
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-gradient-to-br from-surface-elevated via-surface-base to-vignette-deep ring-1 ring-brand-primary/15 rounded-3xl shadow-2xl max-w-md w-full overflow-hidden text-white"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative overflow-hidden p-6 border-b border-brand-primary/15">
          <div className="absolute -top-12 -right-12 w-48 h-48 bg-brand-primary/15 rounded-full blur-3xl pointer-events-none" />
          <div className="relative">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-line-default/10 ring-1 ring-line-default/20 text-[10px] font-bold uppercase tracking-wider mb-3 backdrop-blur">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              Invite ready
            </div>
            <h2 className="text-2xl font-black leading-tight">{labelByType[invite.type] || 'Invite'}</h2>
            <p className="text-white/70 text-sm mt-1">
              {invite.type === 'player'
                ? "Text or AirDrop this link. The first parent that taps it gets auto-linked. No email collection on your end."
                : 'Anyone with this link can join the team in the named role. Reusable up to the limit shown below.'}
            </p>
            {!PLAY_STORE_LIVE && (
              <div className="mt-3 rounded-xl bg-amber-500/8 ring-1 ring-amber-400/25 p-3 space-y-1.5 text-white/80 text-[12px] leading-snug">
                <p><b className="text-amber-200">iPhone parents:</b> tap the link. Opens the App Store, then completes the join.</p>
                {ANDROID_BETA_OPEN ? (
                  <p><b className="text-amber-200">Android parents:</b> tap the link on their phone (opens goalkickr.com in Chrome, works the same as the app), OR install the app in one tap via <a href={ANDROID_BETA_OPTIN_URL} target="_blank" rel="noopener noreferrer" className="underline decoration-amber-400/60 hover:text-white">early access</a>. Either path works, no email allowlist step on either.</p>
                ) : (
                  <p><b className="text-amber-200">Android parents:</b> tap the link on their phone. Opens goalkickr.com in Chrome and works the same. Do not point them at the Play Store; the Android app is still closed beta and I have to add each email by hand.</p>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="p-6 space-y-4">
          <div className="rounded-2xl bg-line-default/5 ring-1 ring-line-default/10 p-3">
            <p className="text-[10px] uppercase tracking-widest font-bold text-white/50 mb-1">Share link</p>
            <p className="text-sm font-mono break-all text-ink-primary">{url}</p>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={handleCopy}
              className="inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-white text-charcoal-800 font-bold text-sm shadow hover:scale-[1.02] transition"
            >
              {copied ? <CheckGlyph className="w-4 h-4" /> : <CopyGlyph className="w-4 h-4" />}
              <span>{copied ? 'Copied' : 'Copy link'}</span>
            </button>
            <button
              onClick={handleSms}
              className="inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-line-default/15 ring-1 ring-line-default/20 text-white font-semibold text-sm hover:bg-line-default/25 transition backdrop-blur"
            >
              <MessageGlyph className="w-4 h-4" />
              <span>Text</span>
            </button>
          </div>

          {/* Bare-code panel. Some channels (verbal, printed rosters,
              Discord announcements, invite cards) work better with a
              short code than a URL. Parent enters it via the "Have
              an invite code?" affordance on the sign-in screen and
              lands on the same /join/{code} route the URL uses. */}
          <div className="rounded-2xl bg-brand-primary/8 ring-1 ring-brand-primary/25 p-3">
            <p className="text-[10px] uppercase tracking-widest font-bold text-brand-primary-soft mb-1">Or share just the code</p>
            <div className="flex items-center gap-2">
              <p className="flex-1 text-lg font-black font-mono tracking-[0.15em] text-ink-primary break-all">{code}</p>
              <button
                onClick={handleCopyCode}
                className="shrink-0 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-brand-primary/20 ring-1 ring-brand-primary/40 text-brand-primary-soft font-bold text-[12px] hover:bg-brand-primary/30 transition"
              >
                {codeCopied ? <CheckGlyph className="w-3.5 h-3.5" /> : <CopyGlyph className="w-3.5 h-3.5" />}
                <span>{codeCopied ? 'Copied' : 'Copy'}</span>
              </button>
            </div>
            <p className="text-[11px] text-white/55 mt-1.5 leading-snug">
              Parents type this into the sign-in screen after tapping "Have an invite code?"
            </p>
          </div>

          {typeof navigator !== 'undefined' && typeof navigator.share === 'function' && (
            <button
              onClick={handleNativeShare}
              className="w-full px-4 py-3 rounded-xl bg-line-default/10 ring-1 ring-line-default/15 text-white font-semibold text-sm hover:bg-line-default/20 transition inline-flex items-center justify-center gap-2"
            >
              <ShareGlyph className="w-4 h-4" />
              <span>Share</span>
            </button>
          )}

          {/* Fast-track for the Android app. Progressive disclosure —
              the link is quiet until tapped so the primary share flow
              stays visually clean. Submits to beta_requests where the
              platform admin batch-processes them into Play Console.
              Auto-hides when PLAY_STORE_LIVE is true (open testing +
              production launch = no allowlist gate). */}
          {showFastTrackSection && (
            <div className="pt-2 border-t border-line-default/10">
              {!fastTrackOpen ? (
                <button
                  type="button"
                  onClick={() => setFastTrackOpen(true)}
                  className="w-full text-center text-[12px] font-semibold text-brand-primary-soft hover:text-white transition py-1"
                >
                  Fast-track this parent for the Android app
                </button>
              ) : (
                <div className="rounded-xl bg-brand-primary/8 ring-1 ring-brand-primary/25 p-3 space-y-2">
                  <p className="text-[11px] text-white/70 leading-snug">
                    Send Patrick this parent's email so he can add them to the Play Store tester list. They will not be able to install the Android app until he does.
                  </p>
                  {fastTrackSubmitted ? (
                    <p className="text-[13px] font-bold text-emerald-300 flex items-center gap-2">
                      <CheckGlyph className="w-4 h-4" />
                      Submitted. Patrick will add them within a day or so.
                    </p>
                  ) : (
                    <>
                      <input
                        type="email"
                        inputMode="email"
                        autoComplete="off"
                        placeholder="parent@example.com"
                        value={fastTrackEmail}
                        onChange={(e) => setFastTrackEmail(e.target.value)}
                        disabled={fastTrackBusy}
                        className="w-full rounded-lg bg-surface-base/60 ring-1 ring-line-default/20 px-3 py-2 text-sm text-ink-primary placeholder:text-ink-primary/40 outline-none focus:ring-brand-primary disabled:opacity-60"
                      />
                      <input
                        type="text"
                        placeholder="Optional note (e.g. Hunter's dad)"
                        value={fastTrackNote}
                        onChange={(e) => setFastTrackNote(e.target.value.slice(0, 200))}
                        disabled={fastTrackBusy}
                        className="w-full rounded-lg bg-surface-base/60 ring-1 ring-line-default/20 px-3 py-2 text-[13px] text-ink-primary placeholder:text-ink-primary/40 outline-none focus:ring-brand-primary disabled:opacity-60"
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={submitFastTrack}
                          disabled={fastTrackBusy || !fastTrackEmail.trim()}
                          className="flex-1 px-3 py-2 rounded-lg bg-brand-primary text-white font-black text-[12px] hover:brightness-110 transition disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {fastTrackBusy ? 'Sending...' : 'Send to Patrick'}
                        </button>
                        <button
                          type="button"
                          onClick={() => { setFastTrackOpen(false); setFastTrackEmail(''); setFastTrackNote(''); }}
                          disabled={fastTrackBusy}
                          className="px-3 py-2 rounded-lg text-white/60 hover:text-white text-[12px] font-semibold transition disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="pt-2 border-t border-line-default/10 text-xs text-white/55 space-y-0.5">
            <p>Expires {invite.expiresAt instanceof Date ? invite.expiresAt.toLocaleDateString() : new Date(invite.expiresAt).toLocaleDateString()}</p>
            <p>{invite.maxUses == null ? 'Unlimited uses' : `${(invite as any).usedCount || 0} of ${invite.maxUses} uses`}</p>
          </div>

          <button
            onClick={onClose}
            className="w-full py-2.5 rounded-xl text-white/70 hover:text-white text-sm font-semibold transition"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};

export default InviteShareModal;

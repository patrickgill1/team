import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { doc, getDoc, serverTimestamp, updateDoc, addDoc, collection, setDoc } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { logActivity } from '../utils/activityLog';
import { sendEmail, sendPushToParentEmails, tplWelcomeAfterOffer } from '../utils/notify';
import CloudflareStreamIframe from '../components/common/CloudflareStreamIframe';
import Logo from '../components/common/Logo';
import type { FormDefinition, OfferLetter, Registration } from '../types';

// Public, no-auth offer page. Parent lands here from a unique link in
// the offer email and accepts or declines. Acceptance promotes the
// Registration to a real Player document on the offering team and
// flips the Offer to `accepted`. Decline is captured with an optional
// reason. Either way we log to the CRM timeline.

const Offer: React.FC = () => {
  const { offerId } = useParams<{ offerId: string }>();
  const [offer, setOffer] = useState<OfferLetter | null>(null);
  const [registration, setRegistration] = useState<Registration | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const [showingDecline, setShowingDecline] = useState(false);
  // Bundled waiver flow — loaded the moment the offer is fetched, then
  // surfaced as an inline signing step the first time the family taps
  // Accept. handleAccept proceeds only once every required waiver has
  // a signature.
  const [waivers, setWaivers] = useState<FormDefinition[]>([]);
  const [showingWaivers, setShowingWaivers] = useState(false);
  const [signedByName, setSignedByName] = useState('');
  const [waiverAck, setWaiverAck] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!offerId) { setLoading(false); return; }
      try {
        const oSnap = await getDoc(doc(db, 'offers', offerId));
        if (!oSnap.exists()) { if (!cancelled) setLoading(false); return; }
        const o = { id: oSnap.id, ...(oSnap.data() as any) } as OfferLetter;
        if (!cancelled) setOffer(o);
        // Pull the original Registration for the player snapshot.
        const rSnap = await getDoc(doc(db, 'registrations', o.registrationId));
        if (rSnap.exists() && !cancelled) {
          setRegistration({ id: rSnap.id, ...(rSnap.data() as any) } as Registration);
        }
        // Bundled waivers — load the FormDefinition docs the coach
        // pinned to this offer's template. Missing entries (form was
        // deleted) are silently dropped; the parent only sees waivers
        // that still exist.
        const ids = Array.isArray(o.requiredWaiverIds) ? o.requiredWaiverIds : [];
        if (ids.length > 0) {
          const snaps = await Promise.all(ids.map(id => getDoc(doc(db, 'form_definitions', id))));
          const list = snaps.filter(s => s.exists()).map(s => ({ id: s.id, ...(s.data() as any) }) as FormDefinition);
          if (!cancelled) setWaivers(list);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [offerId]);

  const handleAccept = async () => {
    if (!offer || !registration) return;
    setSubmitting(true);
    try {
      // Whole accept flow lives on the worker now (2026-07-10). The
      // previous client updateDoc that stamped teamId + position on
      // the player fired FIRST and always 403'd — Firestore rules
      // block parents from writing teamId on player docs, so every
      // real family tapping Accept got a red error toast while the
      // worker call never even ran. Worker /claim/offer-accept:
      //   - flips offer → accepted
      //   - patches player (teamId, teamIds arrayUnion, position,
      //     jerseyNumber, rosteredFromOfferId, rosteredAt)
      //   - grants the accepting parent team membership via
      //     applyMembership (parentIds + user.teamIds + children +
      //     role=parent + stampStage).
      const playerId = registration.promotedToPlayerId || registration.playerId;

      // Persist a form_signatures doc per bundled waiver before the
      // offer flips to accepted. We key each doc as ${playerId}_${formId}
      // so PersonAdmin's existing checklist reads them the same way it
      // reads admin-recorded signatures.
      if (waivers.length > 0 && signedByName.trim() && playerId) {
        for (const w of waivers) {
          try {
            const sigId = `${playerId}_${w.id}`;
            await setDoc(doc(db, 'form_signatures', sigId), {
              clubId: offer.clubId,
              playerId,
              formDefinitionId: w.id,
              formName: w.name,
              signedByName: signedByName.trim(),
              signedBy: 'parent',
              signedAt: serverTimestamp(),
              source: 'offer_accept',
              offerId: offer.id,
            } as any);
            await logActivity({
              clubId: offer.clubId,
              kind: 'form_signed',
              playerId,
              parentEmail: offer.parentEmail,
              seasonId: registration.seasonId,
              actorUid: 'public',
              actorName: signedByName.trim(),
              payload: { formName: w.name, signedByName: signedByName.trim(), source: 'offer_accept' },
            });
          } catch (err) {
            console.warn('waiver signature write failed', w.id, err);
          }
        }
      }

      // Offer status flip through the worker so it can verify the
      // caller's email matches the offer's parentEmail before
      // accepting — the audit flagged this as an unauthenticated
      // status-mutation vector. Then patch the promotion metadata
      // client-side (non-security-critical bookkeeping).
      const { workerFetch } = await import('../utils/workerFetch');
      const acceptRes = await workerFetch('/claim/offer-accept', {
        method: 'POST',
        body: JSON.stringify({
          offerId: offer.id,
          // Explicitly pass playerId — handleClaimOfferAccept prefers
          // offer.playerId, falls back to registration lookup, and finally
          // takes this payload value. Belt-and-suspenders for legacy
          // offers that don't have playerId stamped.
          playerId,
          player: {
            position: offer.offerPosition,
            jerseyNumber: offer.offerJerseyNumber,
          },
        }),
      });
      const acceptData: any = await acceptRes.json().catch(() => ({}));
      if (!acceptRes.ok || !acceptData?.ok) {
        throw new Error(acceptData?.error || `accept-${acceptRes.status}`);
      }

      // Stamp promoted-fields on offer + registration for admin
      // reporting. These are the fields in the offers rule allowlist
      // (status | respondedAt | declineReason | promotedToPlayerId |
      // promotedAt | updatedAt) so the client can write them; the
      // registration side is currently any-authed writable and will
      // move to a worker-endpoint-owned write once the registrations
      // rule tightens.
      try {
        await updateDoc(doc(db, 'offers', offer.id), {
          promotedToPlayerId: playerId,
          promotedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        console.warn('offer promoted-fields update failed (non-fatal)', err);
      }
      try {
        await updateDoc(doc(db, 'registrations', registration.id), {
          status: 'accepted',
          promotedToPlayerId: playerId,
          promotedToTeamId: offer.teamId,
          promotedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        console.warn('registration promoted-fields update failed (non-fatal)', err);
      }

      // Activities.
      await logActivity({
        clubId: offer.clubId,
        kind: 'offer_accepted',
        registrationId: registration.id,
        teamId: offer.teamId,
        parentEmail: offer.parentEmail,
        seasonId: registration.seasonId,
        actorUid: 'public',
        actorName: registration.parents?.[0]?.firstName + ' ' + registration.parents?.[0]?.lastName,
        payload: { offerId: offer.id, playerId, teamName: offer.teamName },
      });
      await logActivity({
        clubId: offer.clubId,
        kind: 'player_promoted',
        registrationId: registration.id,
        playerId,
        teamId: offer.teamId,
        seasonId: registration.seasonId,
        actorUid: 'system',
        payload: { fromOfferId: offer.id, teamName: offer.teamName },
      });

      // Funnel stage 4 — offer accepted. Sibling stamp to offer_sent
      // upstream in SendOfferModal. The fifth stage (external league
      // registration) stays manual; the sixth (club dues) fires from
      // the Stripe payment confirmation webhook.
      try {
        await updateDoc(doc(db, 'players', playerId), {
          'funnelProgress.offer_accept': {
            completedAt: serverTimestamp(),
            by: 'public',
            meta: {
              offerId: offer.id,
              teamId: offer.teamId,
              teamName: offer.teamName,
              signedWaiverIds: waivers.map(w => w.id),
            },
          },
        } as any);
      } catch (err) {
        console.warn('funnel.offer_accept write failed', err);
      }

      // Welcome email — fire-and-forget. Parent will get it within
      // seconds. Failure doesn't roll back the acceptance.
      try {
        const { subject, html } = tplWelcomeAfterOffer({
          playerName: offer.playerName,
          teamName: offer.teamName,
          coachName: offer.coachName,
        });
        void sendEmail({ to: offer.parentEmail, subject, html });
        // Welcome push — celebrates the moment + nudges them back into
        // the app, which now flips from "in the pool" to the rostered
        // team view.
        void sendPushToParentEmails([offer.parentEmail], {
          title: `Welcome to ${offer.teamName}!`,
          body: `${offer.playerName} is officially on the team. Tap to open GoalKickr.`,
          url: '/dashboard',
        });
        await logActivity({
          clubId: offer.clubId,
          kind: 'email_sent',
          registrationId: registration.id,
          playerId,
          parentEmail: offer.parentEmail,
          seasonId: registration.seasonId,
          actorUid: 'system',
          payload: { subject, channel: 'welcome_after_offer' },
        });
      } catch (err) {
        console.warn('welcome email failed', err);
      }

      setOffer({ ...offer, status: 'accepted', promotedToPlayerId: playerId });
    } catch (err: any) {
      console.error('accept failed', err);
      alert(err?.message || 'Accept failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDecline = async () => {
    if (!offer || !registration) return;
    setSubmitting(true);
    try {
      // Decline via worker (email-match gate); notes/reason patch
      // stays client-side.
      const { workerFetch } = await import('../utils/workerFetch');
      const declineRes = await workerFetch('/claim/offer-decline', {
        method: 'POST',
        body: JSON.stringify({ offerId: offer.id, reason: declineReason.trim() || undefined }),
      });
      const declineData: any = await declineRes.json().catch(() => ({}));
      if (!declineRes.ok || !declineData?.ok) {
        throw new Error(declineData?.error || `decline-${declineRes.status}`);
      }
      // Registration status + notes get flipped inside the worker
      // handler (parent-branch hasOnly on registrations.update doesn't
      // allow 'notes', so a client updateDoc here 403'd).
      await logActivity({
        clubId: offer.clubId,
        kind: 'offer_declined',
        registrationId: registration.id,
        teamId: offer.teamId,
        parentEmail: offer.parentEmail,
        seasonId: registration.seasonId,
        actorUid: 'public',
        payload: { offerId: offer.id, reason: declineReason.trim() || undefined, teamName: offer.teamName },
      });
      setOffer({ ...offer, status: 'declined' });
    } catch (err: any) {
      console.error('decline failed', err);
      alert(err?.message || 'Decline failed.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <Frame title="Loading offer…" />;
  if (!offer) return <Frame title="Offer not found" body="The link may be invalid or the offer was rescinded." />;

  const expired = offer.status === 'expired' || (offer.expiresAt && new Date(toDate(offer.expiresAt)).getTime() < Date.now());

  if (offer.status === 'accepted') {
    return (
      <Frame
        tone="success"
        title="Offer accepted"
        body={`Welcome to ${offer.teamName}. ${offer.coachName} will reach out with first-practice details.`}
      />
    );
  }
  if (offer.status === 'declined') {
    return (
      <Frame
        tone="warning"
        title="Offer declined"
        body="Thanks for letting us know. The club will be in touch about next steps."
      />
    );
  }
  if (offer.status === 'rescinded') {
    return <Frame title="Offer rescinded" body="This offer was withdrawn by the club. Contact the coach with any questions." />;
  }
  if (expired) {
    return <Frame title="Offer expired" body="This offer's response window has passed. Reach out to the coach if you still want to accept." />;
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-surface-base via-surface-elevated to-vignette-deep px-4 py-10">
      <div className="max-w-2xl mx-auto">
        <div className="text-center mb-6">
          <div className="inline-flex p-3 rounded-2xl bg-line-default/5 ring-1 ring-line-default/10 backdrop-blur mb-4">
            <Logo size="lg" variant="full" />
          </div>
          <h1 className="text-3xl sm:text-4xl font-black text-ink-primary">{offer.teamName}</h1>
          <p className="text-ink-secondary mt-1">offers <b className="text-ink-primary">{offer.playerName}</b> a roster spot</p>
        </div>

        <div className="bg-line-default/[0.04] backdrop-blur-2xl ring-1 ring-line-default/10 rounded-3xl p-6 sm:p-8 space-y-5">
          {offer.videoStreamUid && (
            <div className="rounded-2xl overflow-hidden ring-1 ring-line-default/10 bg-black aspect-video">
              {/* Anonymous parent viewer; readiness poll would 401.
                  SendOfferModal stamps videoStreamReady:true on the
                  offer at upload time (see its handleSend), so we
                  short-circuit the poll and trust the flag. */}
              <CloudflareStreamIframe
                uid={offer.videoStreamUid}
                streamReady={(offer as any).videoStreamReady === true}
                title="Welcome from coach"
                allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture"
                iframeClassName="w-full h-full block border-0"
              />
            </div>
          )}
          <div className="whitespace-pre-wrap text-ink-primary leading-relaxed text-[15px]">
            {offer.message}
          </div>

          <div className="rounded-2xl bg-line-default/5 ring-1 ring-line-default/10 p-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
            <Detail label="Team" value={offer.teamName} />
            {offer.offerPosition && <Detail label="Position" value={offer.offerPosition} />}
            {typeof offer.offerJerseyNumber === 'number' && <Detail label="Jersey" value={`#${offer.offerJerseyNumber}`} />}
            {typeof offer.feeCents === 'number' && offer.feeCents > 0 && <Detail label="Fee" value={`$${(offer.feeCents / 100).toFixed(2)}`} />}
          </div>

          <div className="text-[11px] text-slate-500 text-center">
            From {offer.coachName} · expires {toDate(offer.expiresAt).toLocaleDateString()}
          </div>

          {/* Waiver signing step — only renders when the coach attached
              required waivers AND the parent has tapped Accept. Each
              waiver gets a check + an "I agree" toggle; the typed-name
              signature is one input shared across all of them, so a
              parent who's signing three releases types their name once. */}
          {showingWaivers && !showingDecline ? (
            <div className="space-y-4">
              <div>
                <div className="text-[10px] font-extrabold tracking-widest uppercase text-brand-primary-soft mb-1">Sign to finish</div>
                <h2 className="text-lg font-black text-ink-primary">{waivers.length === 1 ? 'One quick release' : `${waivers.length} releases`} before {offer.playerName} is rostered</h2>
                <p className="text-[12px] text-ink-primary/60 mt-1">Tap each to read, then type your name to sign.</p>
              </div>

              <ul className="space-y-2">
                {waivers.map(w => {
                  const ack = !!waiverAck[w.id];
                  return (
                    <li key={w.id} className={`rounded-2xl ring-1 transition px-4 py-3 ${
                      ack ? 'bg-emerald-500/10 ring-emerald-400/40' : 'bg-surface-base ring-line-default/10'
                    }`}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-bold text-ink-primary">{w.name}</div>
                          {w.description && (
                            <p className="text-[12px] text-ink-primary/60 mt-1 leading-snug">{w.description}</p>
                          )}
                          {w.body && (
                            <details className="mt-2">
                              <summary className="text-[11px] font-bold uppercase tracking-widest text-brand-primary-soft cursor-pointer">Read full text</summary>
                              <div className="mt-2 max-h-48 overflow-y-auto rounded-lg bg-black/40 ring-1 ring-line-default/10 px-3 py-2 text-[12px] text-ink-primary/80 whitespace-pre-wrap leading-relaxed">
                                {w.body}
                              </div>
                            </details>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => setWaiverAck(prev => ({ ...prev, [w.id]: !prev[w.id] }))}
                          className={`shrink-0 w-7 h-7 rounded-full ring-1 flex items-center justify-center ${
                            ack
                              ? 'bg-emerald-500 ring-emerald-400 text-white'
                              : 'bg-surface-elevated ring-line-default/20 text-ink-primary/40 hover:ring-emerald-400/60'
                          }`}
                          aria-pressed={ack}
                          title={ack ? 'Acknowledged' : 'Mark as acknowledged'}
                        >
                          {ack && <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>

              <label className="block">
                <span className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1">
                  Type your full name to sign <span className="text-rose-300 ml-0.5">*</span>
                </span>
                <input
                  type="text"
                  value={signedByName}
                  onChange={(e) => setSignedByName(e.target.value)}
                  placeholder="First Last"
                  className="w-full px-3 py-2.5 rounded-lg bg-surface-base text-ink-primary placeholder-bone/40 ring-1 ring-line-default/10 focus:outline-none focus:ring-2 focus:ring-brand-primary-soft/60 text-sm"
                  style={{ fontSize: '16px' }}
                />
                <p className="text-[10px] text-ink-primary/45 mt-1">This name is bound to each release as your e-signature.</p>
              </label>

              <div className="flex gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => { setShowingWaivers(false); setWaiverAck({}); setSignedByName(''); }}
                  disabled={submitting}
                  className="flex-1 py-3 rounded-xl text-sm font-bold ring-1 ring-line-default/15 text-ink-secondary hover:text-ink-primary hover:ring-line-default/30 disabled:opacity-50"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={handleAccept}
                  disabled={
                    submitting
                    || !signedByName.trim()
                    || waivers.some(w => !waiverAck[w.id])
                  }
                  className="flex-[2] py-3 rounded-xl text-base font-bold text-white bg-brand-primary hover:bg-brand-primary disabled:opacity-50 shadow-lg"
                >
                  {submitting ? 'Working…' : 'Sign & accept'}
                </button>
              </div>
            </div>
          ) : !showingDecline ? (
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setShowingDecline(true)}
                disabled={submitting}
                className="flex-1 py-3 rounded-xl text-sm font-bold ring-1 ring-line-default/15 text-ink-secondary hover:text-ink-primary hover:ring-line-default/30 disabled:opacity-50"
              >
                Decline
              </button>
              <button
                type="button"
                onClick={() => waivers.length > 0 ? setShowingWaivers(true) : handleAccept()}
                disabled={submitting}
                className="flex-[2] py-3 rounded-xl text-base font-bold text-white bg-brand-primary hover:bg-brand-primary disabled:opacity-50 shadow-lg"
              >
                {submitting ? 'Working…' : waivers.length > 0 ? `Accept · sign ${waivers.length} release${waivers.length === 1 ? '' : 's'}` : 'Accept the offer'}
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <textarea
                value={declineReason}
                onChange={(e) => setDeclineReason(e.target.value)}
                rows={3}
                placeholder="Optional — anything you'd like the coach to know."
                className="w-full px-3 py-2.5 rounded-lg bg-surface-input text-ink-primary placeholder:text-ink-primary/45 ring-1 ring-line-default/10 focus:outline-none focus:ring-2 focus:ring-rose-400/60 text-sm"
                style={{ fontSize: '16px' }}
              />
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setShowingDecline(false)}
                  disabled={submitting}
                  className="flex-1 py-3 rounded-xl text-sm font-bold ring-1 ring-line-default/15 text-ink-secondary hover:text-ink-primary hover:ring-line-default/30"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={handleDecline}
                  disabled={submitting}
                  className="flex-1 py-3 rounded-xl text-sm font-bold text-white bg-rose-500 hover:bg-rose-400 disabled:opacity-50"
                >
                  {submitting ? 'Working…' : 'Confirm decline'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const Detail: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div>
    <div className="text-[10px] font-extrabold tracking-widest uppercase text-brand-primary-soft/80">{label}</div>
    <div className="text-ink-primary font-bold mt-0.5">{value}</div>
  </div>
);

const Frame: React.FC<{ tone?: 'success' | 'warning'; title: string; body?: string }> = ({ tone, title, body }) => (
  <div className="min-h-screen bg-gradient-to-br from-surface-base via-surface-elevated to-vignette-deep flex items-center justify-center p-6">
    <div className="max-w-md w-full bg-line-default/[0.04] backdrop-blur ring-1 ring-line-default/10 rounded-3xl p-8 text-center">
      <div className="inline-flex p-3 rounded-2xl bg-line-default/5 ring-1 ring-line-default/10 backdrop-blur mb-4">
        <Logo size="lg" variant="full" />
      </div>
      <div className={`w-14 h-14 mx-auto rounded-full flex items-center justify-center mb-4 ${
        tone === 'success' ? 'bg-emerald-500/20 ring-1 ring-emerald-400/40' : tone === 'warning' ? 'bg-amber-500/20 ring-1 ring-amber-400/40' : 'bg-line-default/5 ring-1 ring-line-default/10'
      }`}>
        {tone === 'success' ? (
          <svg className="w-6 h-6 text-emerald-300" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
        ) : tone === 'warning' ? (
          <svg className="w-6 h-6 text-amber-300" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>
        ) : (
          <svg className="w-6 h-6 text-brand-primary-soft" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        )}
      </div>
      <h1 className="text-xl font-black text-ink-primary mb-2">{title}</h1>
      {body && <p className="text-sm text-slate-400 leading-relaxed">{body}</p>}
      <Link to="/" className="block mt-4 text-brand-primary-soft hover:text-ink-primary text-xs font-bold">Home</Link>
    </div>
  </div>
);

function toDate(v: any): Date {
  if (!v) return new Date();
  if (v instanceof Date) return v;
  if (typeof v?.toDate === 'function') return v.toDate();
  return new Date(v);
}

export default Offer;

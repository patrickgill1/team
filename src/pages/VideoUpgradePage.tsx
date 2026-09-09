import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { isCoachOfTeam, isStaffOfTeam } from '../utils/helpers';
import { startVideoCheckout, openCustomerPortal } from '../utils/subscriptionApi';
import { getShareOrigin } from '../utils/origin';

// Marketing-style "why upgrade video?" page. Linked from the Upgrade
// pill on PlayerMediaPage / FullGames and from the Video Storage card
// in Settings. Role-gated to coaches, assistant coaches, and team
// managers — the people who actually buy team subscriptions.

const VideoUpgradePage: React.FC = () => {
  const { userData, currentUser } = useAuth();
  const { teams, selectedTeamId } = useTeam();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<'addon' | 'pro' | 'portal' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const team = teams.find(t => t.id === selectedTeamId);
  const tier = (team?.videoTier || 'free') as 'free' | 'addon' | 'pro';
  // 2026-09-06: was isTeamStaff(userData.role) — a global-role check.
  // Per coach-role-model memory, whether someone coaches is per-team
  // on team.coachIds, not on the global user.role. Same bug pattern
  // that killed the Coach mode picker on adult teams. Use the
  // per-team check so a coach whose global role is 'parent' still
  // hits the upgrade flow when they're actually a coach on this team.
  const allowed = !!userData && isStaffOfTeam(userData, team);
  const proSkuConfigured = !!process.env.REACT_APP_STRIPE_PRICE_VIDEO_PRO;
  const addonSkuConfigured = !!process.env.REACT_APP_STRIPE_PRICE_VIDEO_ADDON;

  // Existing-sub attach: if the coach already has a Video plan on
  // their Stripe account but it isn't attached to any team yet
  // (portal purchase, cancelled + resubscribed), let them attach it
  // to THIS team instead of buying another. Prevents duplicate
  // charges + solves the "I bought Video Pro and still can't
  // upload" case Patrick 2026-09-06 hit.
  const [unattachedSubs, setUnattachedSubs] = useState<Array<{
    id: string; videoTier?: string; status?: string; productName?: string;
  }>>([]);
  const [attachBusy, setAttachBusy] = useState<string | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [attachMessage, setAttachMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!allowed || !team?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const { workerFetch } = await import('../utils/workerFetch');
        const res = await workerFetch('/subscriptions/resync', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        const data: any = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.ok && data?.ok) {
          setUnattachedSubs(data.unattachedVideoSubs || []);
        }
      } catch { /* silent — page still works without this */ }
    })();
    return () => { cancelled = true; };
    // Only fire once per team switch; not per re-render.
  }, [allowed, team?.id]);

  const handleAttach = async (subscriptionId: string) => {
    if (!team?.id || attachBusy) return;
    setAttachBusy(subscriptionId);
    setAttachError(null);
    setAttachMessage(null);
    try {
      const { workerFetch } = await import('../utils/workerFetch');
      const res = await workerFetch('/video-subscriptions/attach-team', {
        method: 'POST',
        body: JSON.stringify({ subscriptionId, teamId: team.id }),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        setAttachError(String(data?.hint || data?.error || 'Attach failed'));
        return;
      }
      setUnattachedSubs(prev => prev.filter(s => s.id !== subscriptionId));
      setAttachMessage('Attached. Force-close and reopen the app to unlock uploads on this team.');
    } catch (err) {
      setAttachError(String((err as any)?.message || err));
    } finally {
      setAttachBusy(null);
    }
  };

  if (!allowed) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-12 text-center">
        <h1 className="text-2xl font-black text-ink-primary mb-2">Coach only</h1>
        <p className="text-ink-primary/55 text-sm">
          Video tier upgrades are managed by the team's coach or team manager.
        </p>
        <button
          onClick={() => navigate(-1)}
          className="mt-6 text-[11px] font-extrabold tracking-widest uppercase px-3 py-1.5 rounded-md border bg-surface-elevated text-ink-primary/65 border-line-default/10"
        >
          Go back
        </button>
      </div>
    );
  }

  const handleUpgrade = async (which: 'addon' | 'pro') => {
    if (!team?.id) {
      setError('Pick a team first.');
      return;
    }
    setError(null);
    setBusy(which);
    const err = await startVideoCheckout({
      tier: which,
      teamId: team.id,
      uid: currentUser?.uid,
      customerEmail: currentUser?.email || undefined,
    });
    setBusy(null);
    if (err) setError(err === 'price-not-configured'
      ? 'Upgrades aren\'t available yet.'
      : `Couldn\'t open checkout (${err}).`);
  };

  const handleManage = async () => {
    if (!team?.videoCustomerId) return;
    setError(null);
    setBusy('portal');
    const err = await openCustomerPortal({
      customerId: team.videoCustomerId,
      returnUrl: `${getShareOrigin()}/upgrade/video`,
    });
    setBusy(null);
    if (err) setError(`Couldn't open billing portal (${err}).`);
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 pb-32">
      <div className="mb-6">
        <button
          onClick={() => navigate(-1)}
          className="text-[11px] font-extrabold tracking-widest uppercase text-ink-primary/55 hover:text-ink-primary"
        >
          ← Back
        </button>
      </div>

      <div className="bg-gradient-to-br from-amber-500/15 via-surface-elevated to-surface-elevated rounded-2xl border border-amber-500/30 p-6 sm:p-8 mb-6">
        <p className="text-[11px] font-extrabold tracking-widest uppercase text-amber-300 mb-2">Full Game Film</p>
        <h1 className="text-3xl sm:text-4xl font-black text-ink-primary leading-tight">
          Upload full matches. Share clips. No 60-second cap.
        </h1>
        <p className="text-ink-primary/70 mt-3 leading-relaxed">
          Free teams get 20 highlight clips of up to 60 seconds each — perfect for game moments. Upgrade {team?.name ? <span className="text-ink-primary font-bold">{team.name}</span> : 'your team'} when you want to host full games, run a film room, and skip the YouTube grind.
        </p>
      </div>

      {/* Existing-video-sub attach — surfaces when the coach already
          has a Stripe video plan that isn't tied to this team yet.
          Prevents duplicate charges: attach the existing sub instead
          of buying another. */}
      {unattachedSubs.length > 0 && (
        <div className="bg-emerald-500/10 rounded-2xl border border-emerald-500/30 p-5 mb-6">
          <p className="text-[11px] font-extrabold tracking-widest uppercase text-emerald-300 mb-2">
            You already have a Video plan
          </p>
          <p className="text-sm text-ink-primary/85 leading-snug mb-4">
            Looks like {unattachedSubs.length === 1 ? 'a Video subscription is' : `${unattachedSubs.length} Video subscriptions are`} on your account but not attached to a team yet. Attach {unattachedSubs.length === 1 ? 'it' : 'one'} to {team?.name || 'this team'} to unlock uploads without buying another plan.
          </p>
          <div className="space-y-2">
            {unattachedSubs.map((sub) => (
              <div key={sub.id} className="rounded-lg bg-surface-elevated ring-1 ring-line-default/15 p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-ink-primary truncate">
                    {sub.productName || (sub.videoTier === 'pro' ? 'Full Game Film' : 'Video plan')}
                  </p>
                  {sub.status && (
                    <p className="text-[11px] text-ink-primary/55">Status: {sub.status}</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => handleAttach(sub.id)}
                  disabled={attachBusy === sub.id || !!attachBusy}
                  className="px-3 py-1.5 rounded-full bg-brand-primary text-white text-[11px] font-black uppercase tracking-widest hover:bg-brand-primary/90 disabled:opacity-40 transition" /* theme-ok: brand CTA */
                >
                  {attachBusy === sub.id ? 'Attaching…' : 'Attach to this team'}
                </button>
              </div>
            ))}
          </div>
          {attachMessage && (
            <p className="mt-3 text-[11px] text-emerald-300 bg-emerald-500/15 border border-emerald-500/40 rounded-lg px-3 py-2 leading-snug">
              {attachMessage}
            </p>
          )}
          {attachError && (
            <p className="mt-3 text-[11px] text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2 leading-snug">
              {attachError}
            </p>
          )}
        </div>
      )}

      <div className="space-y-3 mb-6">
        <TierCard
          label="Free"
          price="$0"
          perks={['20 clips, up to 60 seconds each', '720p HD playback', 'Share to parents inside the app']}
          current={tier === 'free'}
        />
        <TierCard
          label="Highlights+"
          price="$10/mo per team"
          perks={['Unlimited 60-second clips', '720p, still capped at one minute', 'Skip the 20-clip ceiling without paying for full games']}
          current={tier === 'addon'}
          comingSoon={!addonSkuConfigured}
          ctaLabel={tier === 'free' && addonSkuConfigured ? 'Upgrade to Highlights+' : undefined}
          onCta={() => handleUpgrade('addon')}
          busy={busy === 'addon'}
          disabled={!!busy}
        />
        <TierCard
          label="Full Game Film"
          price="$29.99/mo per team"
          perks={['Full-length match uploads, no time cap', 'Up to 100 hours stored per team', '720p HD playback', 'Cancel anytime, no contract']}
          current={tier === 'pro'}
          highlight
          comingSoon={!proSkuConfigured}
          ctaLabel={tier !== 'pro' && proSkuConfigured ? 'Upgrade to Full Game Film' : undefined}
          onCta={() => handleUpgrade('pro')}
          busy={busy === 'pro'}
          disabled={!!busy}
        />
      </div>

      <div className="bg-surface-elevated rounded-xl border border-line-default/10 p-6">
        <h2 className="text-lg font-black text-ink-primary mb-3">Why not just YouTube?</h2>
        <ul className="text-sm text-ink-primary/70 space-y-2 leading-relaxed">
          <li>· One-tap upload right from the same screen as your highlights — no separate channel to manage.</li>
          <li>· Clips share via the same parent / player links the rest of the app uses.</li>
          <li>· No ads on playback, no copyright strikes, no algorithmic recommendations playing other teams' content after yours.</li>
          <li>· Bills per team, not per club, so you only pay for the squads that actually upload film.</li>
        </ul>
      </div>

      {tier !== 'free' && team?.videoCustomerId && (
        <button
          type="button"
          onClick={handleManage}
          disabled={busy === 'portal'}
          className="mt-6 w-full px-5 py-3.5 rounded-xl bg-surface-elevated ring-1 ring-line-default/15 hover:bg-line-default/[0.06] text-ink-primary text-sm font-extrabold tracking-widest uppercase disabled:opacity-60"
        >
          {busy === 'portal' ? 'Opening portal…' : 'Manage subscription'}
        </button>
      )}
      {tier === 'free' && !proSkuConfigured && !addonSkuConfigured && (
        <p className="mt-6 text-ink-primary/55 text-xs text-center">
          Upgrades aren't live yet — email <a className="text-brand-primary-soft" href="mailto:patrick.gill@goalkickr.com">patrick.gill@goalkickr.com</a> for early access.
        </p>
      )}

      {error && (
        <p className="mt-3 text-xs text-rose-300 bg-rose-500/10 ring-1 ring-rose-500/30 rounded-lg px-3 py-2">
          {error}
        </p>
      )}
    </div>
  );
};

const TierCard: React.FC<{
  label: string;
  price: string;
  perks: string[];
  current?: boolean;
  comingSoon?: boolean;
  highlight?: boolean;
  ctaLabel?: string;
  onCta?: () => void;
  busy?: boolean;
  disabled?: boolean;
}> = ({ label, price, perks, current, comingSoon, highlight, ctaLabel, onCta, busy, disabled }) => (
  <div className={`rounded-xl p-4 ring-1 ${
    current
      ? 'bg-brand-primary/10 ring-brand-primary/40'
      : highlight
        ? 'bg-amber-500/5 ring-amber-500/30'
        : 'bg-surface-elevated ring-line-default/10'
  }`}>
    <div className="flex items-center justify-between gap-3 mb-2">
      <div className="flex items-center gap-2">
        <span className="text-ink-primary font-bold">{label}</span>
        {current && (
          <span className="text-[10px] font-extrabold tracking-widest uppercase px-1.5 py-0.5 rounded bg-brand-primary/20 text-brand-primary-soft">
            Your tier
          </span>
        )}
        {comingSoon && !current && (
          <span className="text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/40">
            Coming soon
          </span>
        )}
      </div>
      <span className="text-ink-primary/85 font-bold text-sm tabular-nums">{price}</span>
    </div>
    <ul className="text-xs text-ink-primary/65 space-y-1 leading-relaxed">
      {perks.map((p, i) => <li key={i}>· {p}</li>)}
    </ul>
    {ctaLabel && onCta && !current && (
      <button
        type="button"
        onClick={onCta}
        disabled={!!busy || !!disabled}
        className={`mt-3 w-full px-4 py-2.5 rounded-lg text-xs font-extrabold tracking-widest uppercase disabled:opacity-60 disabled:cursor-wait ${
          highlight
            ? 'bg-amber-500 hover:bg-amber-400 text-ink-primary'
            : 'bg-brand-primary hover:bg-brand-primary/90 text-white'  // theme-ok: legacy hardcoded color, pending per-line audit
        }`}
      >
        {busy ? 'Opening checkout…' : ctaLabel}
      </button>
    )}
  </div>
);

export default VideoUpgradePage;

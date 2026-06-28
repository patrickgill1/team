import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { isTeamStaff } from '../utils/helpers';
import { startVideoCheckout, openCustomerPortal } from '../utils/subscriptionApi';

// Marketing-style "why upgrade video?" page. Linked from the Upgrade
// pill on PlayerMediaPage / FullGames and from the Video Storage card
// in Settings. Role-gated to coaches, assistant coaches, and team
// managers — the people who actually buy team subscriptions.

const VideoUpgradePage: React.FC = () => {
  const { userData, currentUser } = useAuth();
  const { teams, selectedTeamId } = useTeam();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<'upgrade' | 'portal' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const team = teams.find(t => t.id === selectedTeamId);
  const tier = (team?.videoTier || 'free') as 'free' | 'addon' | 'pro';
  const allowed = !!userData && isTeamStaff(userData.role);
  const proSkuConfigured = !!process.env.REACT_APP_STRIPE_PRICE_VIDEO_PRO;

  if (!allowed) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-12 text-center">
        <h1 className="text-2xl font-black text-bone mb-2">Coach only</h1>
        <p className="text-bone/55 text-sm">
          Video tier upgrades are managed by the team's coach or team manager.
        </p>
        <button
          onClick={() => navigate(-1)}
          className="mt-6 text-[11px] font-extrabold tracking-widest uppercase px-3 py-1.5 rounded-md border bg-charcoal-900 text-bone/65 border-white/10"
        >
          Go back
        </button>
      </div>
    );
  }

  const handleUpgrade = async () => {
    if (!team?.id) {
      setError('Pick a team first.');
      return;
    }
    setError(null);
    setBusy('upgrade');
    const err = await startVideoCheckout({
      tier: 'pro',
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
      returnUrl: `${window.location.origin}/upgrade/video`,
    });
    setBusy(null);
    if (err) setError(`Couldn't open billing portal (${err}).`);
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 pb-32">
      <div className="mb-6">
        <button
          onClick={() => navigate(-1)}
          className="text-[11px] font-extrabold tracking-widest uppercase text-bone/55 hover:text-bone"
        >
          ← Back
        </button>
      </div>

      <div className="bg-gradient-to-br from-amber-500/15 via-charcoal-900 to-charcoal-900 rounded-2xl border border-amber-500/30 p-6 sm:p-8 mb-6">
        <p className="text-[11px] font-extrabold tracking-widest uppercase text-amber-300 mb-2">Full Game Film</p>
        <h1 className="text-3xl sm:text-4xl font-black text-bone leading-tight">
          Upload full matches. Share clips. No 60-second cap.
        </h1>
        <p className="text-bone/70 mt-3 leading-relaxed">
          Free teams get 20 highlight clips of up to 60 seconds each — perfect for game moments. Upgrade {team?.name ? <span className="text-bone font-bold">{team.name}</span> : 'your team'} when you want to host full games, run a film room, and skip the YouTube grind.
        </p>
      </div>

      <div className="space-y-3 mb-6">
        <TierCard
          label="Free"
          price="$0"
          perks={['20 clips, up to 60 seconds each', '720p, hosted on Cloudflare Stream', 'Share to parents inside the app']}
          current={tier === 'free'}
        />
        <TierCard
          label="Highlights+"
          price="$10/mo per team"
          perks={['Unlimited 60-second clips', '720p, still capped at one minute', 'Best for steady-clip teams']}
          current={tier === 'addon'}
          comingSoon
        />
        <TierCard
          label="Full Game Film"
          price="$29.99/mo per team"
          perks={['Full-length match uploads, no time cap', 'Up to 100 hours stored per team', '720p, Cloudflare Stream playback', 'Cancel anytime, no contract']}
          current={tier === 'pro'}
          highlight
        />
      </div>

      <div className="bg-charcoal-900 rounded-xl border border-white/10 p-6">
        <h2 className="text-lg font-black text-bone mb-3">Why not just YouTube?</h2>
        <ul className="text-sm text-bone/70 space-y-2 leading-relaxed">
          <li>· One-tap upload right from the same screen as your highlights — no separate channel to manage.</li>
          <li>· Clips share via the same parent / player links the rest of the app uses.</li>
          <li>· No ads on playback, no copyright strikes, no algorithmic recommendations playing other teams' content after yours.</li>
          <li>· Bills per team, not per club, so you only pay for the squads that actually upload film.</li>
        </ul>
      </div>

      {tier === 'free' && proSkuConfigured && (
        <button
          type="button"
          onClick={handleUpgrade}
          disabled={busy === 'upgrade'}
          className="mt-6 w-full px-5 py-3.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-charcoal-950 text-sm font-extrabold tracking-widest uppercase shadow-lg disabled:opacity-60 disabled:cursor-wait"
        >
          {busy === 'upgrade' ? 'Opening checkout…' : 'Upgrade to Full Game Film · $29.99/mo'}
        </button>
      )}
      {tier !== 'free' && team?.videoCustomerId && (
        <button
          type="button"
          onClick={handleManage}
          disabled={busy === 'portal'}
          className="mt-6 w-full px-5 py-3.5 rounded-xl bg-charcoal-900 ring-1 ring-white/15 hover:bg-white/[0.06] text-bone text-sm font-extrabold tracking-widest uppercase disabled:opacity-60"
        >
          {busy === 'portal' ? 'Opening portal…' : 'Manage subscription'}
        </button>
      )}
      {tier === 'free' && !proSkuConfigured && (
        <p className="mt-6 text-bone/55 text-xs text-center">
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
}> = ({ label, price, perks, current, comingSoon, highlight }) => (
  <div className={`rounded-xl p-4 ring-1 ${
    current
      ? 'bg-brand-primary/10 ring-brand-primary/40'
      : highlight
        ? 'bg-amber-500/5 ring-amber-500/30'
        : 'bg-charcoal-900 ring-white/10'
  }`}>
    <div className="flex items-center justify-between gap-3 mb-2">
      <div className="flex items-center gap-2">
        <span className="text-bone font-bold">{label}</span>
        {current && (
          <span className="text-[10px] font-extrabold tracking-widest uppercase px-1.5 py-0.5 rounded bg-brand-primary/20 text-brand-primary-soft">
            Your tier
          </span>
        )}
        {comingSoon && !current && (
          <span className="text-[10px] font-extrabold tracking-widest uppercase text-bone/40">
            Coming soon
          </span>
        )}
      </div>
      <span className="text-bone/85 font-bold text-sm tabular-nums">{price}</span>
    </div>
    <ul className="text-xs text-bone/65 space-y-1 leading-relaxed">
      {perks.map((p, i) => <li key={i}>· {p}</li>)}
    </ul>
  </div>
);

export default VideoUpgradePage;

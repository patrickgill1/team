import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useTeam } from '../../contexts/TeamContext';
import { isTeamStaff } from '../../utils/helpers';
import { openCustomerPortal } from '../../utils/subscriptionApi';

// Compact tier + usage card. Lives in Settings (under Video) and
// surfaces the same data the Upgrade page shows in long form, plus
// a "Manage subscription" button for paid teams. Role-gated to
// coaches, assistant coaches, and team managers — `null` for others.

const VIDEO_TIER_LABEL: Record<'free' | 'addon' | 'pro', string> = {
  free: 'Free',
  addon: 'Highlights+',
  pro: 'Full Game Film',
};

const VIDEO_TIER_PRICE: Record<'free' | 'addon' | 'pro', string> = {
  free: '$0',
  addon: '$10/mo per team',
  pro: '$29.99/mo per team',
};

const VideoStorageCard: React.FC = () => {
  const { userData } = useAuth();
  const { teams, selectedTeamId } = useTeam();
  const location = useLocation();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<'portal' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const team = teams.find(t => t.id === selectedTeamId);
  const allowed = !!userData && isTeamStaff(userData.role);

  // Surface the post-checkout success/cancel banner once, then strip
  // the query so a refresh doesn't keep showing it.
  const search = new URLSearchParams(location.search);
  const upgradeStatus = search.get('video_upgrade');
  useEffect(() => {
    if (upgradeStatus) {
      const t = window.setTimeout(() => {
        const next = new URLSearchParams(location.search);
        next.delete('video_upgrade');
        next.delete('team');
        navigate({ pathname: location.pathname, search: next.toString() }, { replace: true });
      }, 8000);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [upgradeStatus, location.pathname, location.search, navigate]);

  if (!allowed || !team) return null;

  const tier = (team.videoTier || 'free') as 'free' | 'addon' | 'pro';
  const clipCount = team.videoClipCount || 0;
  const minutesStored = team.videoMinutesStored || 0;

  const handleManage = async () => {
    if (!team.videoCustomerId) return;
    setError(null);
    setBusy('portal');
    const err = await openCustomerPortal({
      customerId: team.videoCustomerId,
      returnUrl: `${window.location.origin}/settings`,
    });
    setBusy(null);
    if (err) setError(`Couldn't open billing portal (${err}).`);
  };

  return (
    <div className="bg-charcoal-900 rounded-xl shadow-sm border border-white/10 overflow-hidden">
      <div className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-bone font-bold">{VIDEO_TIER_LABEL[tier]}</p>
            <p className="text-sm text-bone/55 mt-0.5">{VIDEO_TIER_PRICE[tier]}</p>
          </div>
          <span className={`text-[10px] font-extrabold tracking-widest uppercase px-2 py-1 rounded-md ${tier === 'free' ? 'bg-white/[0.06] text-bone/55' : 'bg-brand-primary/15 text-brand-primary-soft'}`}>
            {VIDEO_TIER_LABEL[tier]}
          </span>
        </div>

        {upgradeStatus === 'ok' && (
          <div className="mt-3 rounded-lg bg-emerald-500/10 ring-1 ring-emerald-500/30 px-3 py-2 text-sm text-emerald-200">
            Subscription active. Upload window unlocked.
          </div>
        )}
        {upgradeStatus === 'cancel' && (
          <div className="mt-3 rounded-lg bg-white/[0.04] ring-1 ring-white/10 px-3 py-2 text-sm text-bone/65">
            Checkout cancelled. The team is still on the {VIDEO_TIER_LABEL[tier]} tier.
          </div>
        )}

        <div className="mt-4 grid grid-cols-2 gap-3">
          <div className="bg-white/[0.04] rounded-lg px-3 py-2">
            <div className="text-[10px] font-extrabold tracking-widest uppercase text-bone/40">Clips stored</div>
            <div className="text-base font-bold text-bone tabular-nums mt-0.5">
              {clipCount}{tier === 'free' ? <span className="text-bone/40 text-sm font-normal"> / 20</span> : null}
            </div>
          </div>
          <div className="bg-white/[0.04] rounded-lg px-3 py-2">
            <div className="text-[10px] font-extrabold tracking-widest uppercase text-bone/40">Minutes stored</div>
            <div className="text-base font-bold text-bone tabular-nums mt-0.5">
              {minutesStored.toFixed(1)}{tier === 'pro' ? <span className="text-bone/40 text-sm font-normal"> / 6000</span> : null}
            </div>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-2 flex-wrap">
          {tier === 'free' && (
            <button
              type="button"
              onClick={() => navigate('/upgrade/video')}
              className="text-[11px] font-extrabold tracking-widest uppercase px-3 py-1.5 rounded-md bg-amber-500 hover:bg-amber-400 text-charcoal-950"
            >
              See what Pro unlocks
            </button>
          )}
          {tier !== 'free' && team.videoCustomerId && (
            <button
              type="button"
              onClick={handleManage}
              disabled={busy === 'portal'}
              className="text-[11px] font-extrabold tracking-widest uppercase px-3 py-1.5 rounded-md border bg-charcoal-900 text-bone/65 border-white/10 hover:text-bone hover:border-white/20 disabled:opacity-50"
            >
              {busy === 'portal' ? 'Opening portal…' : 'Manage subscription'}
            </button>
          )}
        </div>

        {error && (
          <p className="mt-3 text-xs text-rose-300 bg-rose-500/10 ring-1 ring-rose-500/30 rounded-lg px-3 py-2">
            {error}
          </p>
        )}
      </div>
    </div>
  );
};

export default VideoStorageCard;

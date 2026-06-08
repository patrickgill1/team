import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, getDocs, orderBy, query, where } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import type { Registration } from '../../types';

// Hero shown to parents who've registered through the new auth-gated
// /register flow but haven't been rostered onto a team yet. Replaces
// the team-scoped dashboard hero (which would render mostly empty for
// these families). Sets expectations + shows where their kid is in
// the funnel + links to the family timeline so they can see the full
// audit trail of everything that's happened.
//
// "Unrostered" detection at the call site: userData.role === 'parent'
// AND (userData.teamIds || []).length === 0.

interface KidStatus {
  registrationId: string;
  playerName: string;
  ageGroup?: string;
  status: Registration['status'];
}

const STATUS_TONE: Record<Registration['status'], { label: string; bg: string; text: string; ring: string; subtitle: string }> = {
  pending_payment: {
    label: 'Pending payment',
    bg: 'bg-amber-50', text: 'text-amber-900', ring: 'ring-amber-300',
    subtitle: "We've got the registration. Once payment lands, you're in the pool.",
  },
  paid: {
    label: 'In the pool',
    bg: 'bg-emerald-50', text: 'text-emerald-900', ring: 'ring-emerald-300',
    subtitle: 'Your registration is reviewed weekly. Coaches reach out when they want to chat.',
  },
  tryout_invited: {
    label: 'Tryout invited',
    bg: 'bg-cyan-50', text: 'text-cyan-900', ring: 'ring-cyan-300',
    subtitle: 'Check your email for tryout details.',
  },
  offer_sent: {
    label: 'Offer waiting!',
    bg: 'bg-violet-50', text: 'text-violet-900', ring: 'ring-violet-300',
    subtitle: 'A coach offered your kid a spot. Open your email to accept or decline.',
  },
  accepted: {
    label: 'Rostered',
    bg: 'bg-emerald-100', text: 'text-emerald-900', ring: 'ring-emerald-400',
    subtitle: 'You\'re on the team. Reload the app to see your dashboard.',
  },
  declined: {
    label: 'Declined',
    bg: 'bg-slate-100', text: 'text-slate-700', ring: 'ring-slate-300',
    subtitle: 'You declined the offer. The club will be in touch about other options.',
  },
  withdrawn: {
    label: 'Withdrawn',
    bg: 'bg-slate-100', text: 'text-slate-700', ring: 'ring-slate-300',
    subtitle: 'Registration withdrawn. Reply to your club email if this was a mistake.',
  },
};

interface Props {
  firstName: string;
  email?: string;
}

const InThePoolHero: React.FC<Props> = ({ firstName, email }) => {
  const [kids, setKids] = useState<KidStatus[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!email) { setLoading(false); return; }
      try {
        // Query every registration this parent's email shows up on.
        const snap = await getDocs(query(
          collection(db, 'registrations'),
          orderBy('createdAt', 'desc'),
        ));
        const matching: KidStatus[] = snap.docs
          .map(d => ({ id: d.id, ...(d.data() as any) } as Registration))
          .filter(r => (r.parents || []).some(p => p.email?.toLowerCase() === email.toLowerCase()))
          .map(r => ({
            registrationId: r.id,
            playerName: `${r.player?.firstName || ''} ${r.player?.lastName || ''}`.trim() || 'Your kid',
            ageGroup: r.player?.ageGroup,
            status: r.status,
          }));
        if (!cancelled) setKids(matching);
      } catch (err) {
        console.warn('InThePoolHero load failed', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [email]);

  const overallVibe = useMemo(() => {
    if (kids.length === 0) return 'just_registered';
    if (kids.every(k => k.status === 'accepted')) return 'all_rostered';
    if (kids.some(k => k.status === 'offer_sent')) return 'offer_action';
    return 'in_pool';
  }, [kids]);

  return (
    <div className="relative bg-gradient-to-br from-slate-950 via-slate-900 to-black px-4 py-10 sm:py-14">
      <div className="max-w-3xl mx-auto">
        <div className="text-center mb-6">
          <h1 className="text-3xl sm:text-5xl font-black text-white leading-tight">
            {overallVibe === 'offer_action' ? (
              <>You've got an <span className="bg-gradient-to-r from-violet-300 to-fuchsia-300 bg-clip-text text-transparent">offer</span> waiting, {firstName}.</>
            ) : overallVibe === 'all_rostered' ? (
              <>You're <span className="bg-gradient-to-r from-emerald-300 to-cyan-300 bg-clip-text text-transparent">in</span>, {firstName}.</>
            ) : (
              <>You're in the <span className="bg-gradient-to-r from-cyan-300 via-violet-300 to-fuchsia-300 bg-clip-text text-transparent">Fire FC pool</span>, {firstName}.</>
            )}
          </h1>
          <p className="text-slate-300 mt-3 text-sm sm:text-base leading-relaxed max-w-xl mx-auto">
            {overallVibe === 'offer_action'
              ? 'Check your email and tap the link to accept. We hope you say yes.'
              : overallVibe === 'all_rostered'
                ? 'Reload the app to see your team dashboard, your roster, and the season ahead.'
                : 'Coaches review the pool weekly. When they want to talk, you\'ll hear from us. While you wait, keep an eye on this card — your status will change in real time.'
            }
          </p>
        </div>

        {loading ? (
          <div className="bg-white/[0.04] ring-1 ring-white/10 rounded-2xl p-6 text-center text-sm text-slate-300">Loading your registrations…</div>
        ) : kids.length === 0 ? (
          <div className="bg-white/[0.04] ring-1 ring-white/10 rounded-2xl p-6 text-center">
            <p className="text-sm text-slate-300 mb-4">We don't see a registration on file under <b className="text-white">{email}</b> yet.</p>
            <Link to="/register" className="inline-block px-5 py-2.5 rounded-xl bg-gradient-to-r from-cyan-500 via-violet-500 to-fuchsia-500 text-white text-sm font-bold hover:from-cyan-400 hover:via-violet-400 hover:to-fuchsia-400">
              Start registration
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            {kids.map(k => {
              const tone = STATUS_TONE[k.status];
              return (
                <div key={k.registrationId} className={`rounded-2xl p-4 ring-1 ${tone.bg} ${tone.ring}`}>
                  <div className="flex items-center justify-between gap-3 mb-2">
                    <div className="min-w-0">
                      <div className={`font-black text-lg ${tone.text}`}>{k.playerName}</div>
                      {k.ageGroup && <div className="text-[11px] font-bold uppercase tracking-widest text-slate-500">{k.ageGroup}</div>}
                    </div>
                    <span className={`text-[11px] font-extrabold uppercase tracking-widest px-2.5 py-1 rounded-full ring-1 ${tone.bg} ${tone.text} ${tone.ring}`}>
                      {tone.label}
                    </span>
                  </div>
                  <p className={`text-sm ${tone.text} opacity-90`}>{tone.subtitle}</p>
                </div>
              );
            })}

            {email && (
              <div className="text-center pt-2">
                <Link
                  to={`/club/family/${encodeURIComponent(email.toLowerCase())}`}
                  className="text-xs font-bold text-cyan-300 hover:text-cyan-200"
                >
                  See the full timeline →
                </Link>
              </div>
            )}
          </div>
        )}

        {/* What's next card — only shows while waiting */}
        {(overallVibe === 'in_pool' || overallVibe === 'just_registered') && (
          <div className="mt-6 bg-white/[0.03] ring-1 ring-white/10 rounded-2xl p-5">
            <div className="text-[10px] font-extrabold uppercase tracking-widest text-cyan-300 mb-2">What happens next</div>
            <ul className="space-y-2 text-sm text-slate-300">
              <li className="flex items-start gap-2"><span className="text-cyan-400 mt-0.5">①</span> Coaches review the pool every Sunday.</li>
              <li className="flex items-start gap-2"><span className="text-cyan-400 mt-0.5">②</span> If a team wants your kid, you'll get an email with an offer link.</li>
              <li className="flex items-start gap-2"><span className="text-cyan-400 mt-0.5">③</span> You tap Accept — your kid is on the team and this dashboard becomes their team home.</li>
            </ul>
            <p className="text-[11px] text-slate-500 mt-3 italic">Hang tight. You can close this app and we'll email you when something changes.</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default InThePoolHero;

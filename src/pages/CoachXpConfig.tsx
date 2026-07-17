import React, { useEffect, useMemo, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { collection, doc, getDocs, query, updateDoc, where } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { isCoachOfTeam } from '../utils/helpers';
import Header from '../components/common/Header';
import AppIcon from '../components/common/AppIcon';
import type { Player } from '../types';
import { computeXpLevel } from '../utils/xpLevel';

/**
 * Coach XP Config — /coach/xp
 *
 * One page, three controls, warm explainer copy:
 *
 *  1. Master enable: team.xpConfig.enabled — the whole system on/off.
 *  2. Reward showing up: team.xpConfig.sources.participation — practice
 *     log ticks, RSVP flips, kid chat +2.
 *  3. Award badges: team.xpConfig.sources.badges — first goals, streaks,
 *     POTM, perfect attendance milestone badges.
 *
 * Coach manual paths (whisper +50, live grant, kudos convert) are NOT
 * exposed here — those stay always-on whenever master is on. If the
 * coach chose to grant, we don't second-guess.
 *
 * Below the toggles: a lightweight "Team XP status" summary so the coach
 * can feel how their config is landing (total XP paid out this season +
 * top 3 highest-leveled kids).
 */

type PendingSources = {
  participation: boolean;
  badges: boolean;
};

const CoachXpConfig: React.FC = () => {
  const { userData } = useAuth();
  const { selectedTeam, selectedTeamId } = useTeam();

  // Hooks BEFORE any conditional return — react hook rules.
  const initialEnabled = (selectedTeam as any)?.xpConfig?.enabled === true;
  const initialSources: PendingSources = useMemo(() => {
    const src = (selectedTeam as any)?.xpConfig?.sources || {};
    return {
      participation: src.participation !== false,
      badges: src.badges !== false,
    };
  }, [selectedTeam]);

  const [enabled, setEnabled] = useState<boolean>(initialEnabled);
  const [sources, setSources] = useState<PendingSources>(initialSources);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);

  // Reset local state whenever the coach switches teams.
  useEffect(() => {
    setEnabled(initialEnabled);
    setSources(initialSources);
  }, [selectedTeamId, initialEnabled, initialSources]);

  // Toast auto-dismiss.
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 2500);
    return () => window.clearTimeout(id);
  }, [toast]);

  // Load roster so we can show "Team XP status." Non-fatal.
  useEffect(() => {
    if (!selectedTeamId) { setPlayers([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const q = query(collection(db, 'players'), where('teamId', '==', selectedTeamId));
        const snap = await getDocs(q);
        const rows: Player[] = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
        if (!cancelled) setPlayers(rows);
      } catch (err) {
        console.warn('CoachXpConfig players read failed', err);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedTeamId]);

  const totalSeasonXp = useMemo(() => {
    return players.reduce((sum, p) => sum + (Number((p as any).xp) || 0), 0);
  }, [players]);

  const topPlayers = useMemo(() => {
    return [...players]
      .map(p => {
        const xp = Number((p as any).xp) || 0;
        return { id: p.id, name: p.name, xp, level: computeXpLevel(xp).level };
      })
      .sort((a, b) => b.xp - a.xp)
      .slice(0, 3);
  }, [players]);

  const dirty = enabled !== initialEnabled
    || sources.participation !== initialSources.participation
    || sources.badges !== initialSources.badges;

  const coachOnThisTeam = isCoachOfTeam(userData as any, selectedTeam as any);

  const save = async () => {
    if (!selectedTeamId || saving) return;
    setSaving(true);
    try {
      const patch: Record<string, any> = {
        'xpConfig.enabled': enabled,
        'xpConfig.sources': {
          participation: sources.participation,
          badges: sources.badges,
        },
      };
      // Stamp enabledAt on first-ever enable so downstream code that
      // treats "no enabledAt" as never-opted-in stays consistent.
      const priorEnabledAt = (selectedTeam as any)?.xpConfig?.enabledAt;
      if (enabled && !priorEnabledAt) {
        patch['xpConfig.enabledAt'] = new Date();
      }
      await updateDoc(doc(db, 'teams', selectedTeamId), patch);
      setToast('Saved');
    } catch (err) {
      console.error('CoachXpConfig save failed', err);
      setToast('Could not save. Try again.');
    } finally {
      setSaving(false);
    }
  };

  // NOW conditional returns — after all hooks.
  if (!userData) return <Navigate to="/login" replace />;
  if (!selectedTeam) {
    return (
      <div className="min-h-screen bg-surface-base text-ink-primary">
        <Header title="Player XP" />
        <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6">
          <p className="text-sm text-ink-primary/70">
            Pick a team from the header to configure XP.
          </p>
        </div>
      </div>
    );
  }
  if (!coachOnThisTeam) {
    return (
      <div className="min-h-screen bg-surface-base text-ink-primary">
        <Header title="Player XP" />
        <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6">
          <div className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 p-4 sm:p-5">
            <p className="text-sm text-ink-primary/70">
              Only this team's coach can change XP settings.
            </p>
            <Link to="/coach" className="mt-3 inline-block text-sm font-semibold text-brand-primary">
              Back to Coach
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface-base text-ink-primary">
      <Header title="Player XP" />
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 space-y-4">

        {/* Master toggle card */}
        <section className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-bold">Enable player XP for this team</h2>
              <p className="mt-1 text-sm text-ink-primary/70 leading-relaxed">
                XP is a private-first journey, not a leaderboard. Kids earn small
                points for showing up and milestone badges for big moments. Turn
                it off any time and existing progress stays put, just hidden.
              </p>
            </div>
            <ToggleSwitch
              checked={enabled}
              onChange={setEnabled}
              label="Master XP enabled"
            />
          </div>
        </section>

        {/* Source toggles — only meaningful when master is on */}
        {enabled && (
          <section className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 p-4 sm:p-5">
            <p className="text-[10px] uppercase tracking-widest font-bold text-ink-primary/55">
              What earns XP
            </p>
            <div className="mt-3 space-y-3">
              <ToggleRow
                title="Reward showing up"
                subtitle="Small XP for daily practice logs, RSVP flips, and kid chat. Turn off if your squad treats these as expected."
                checked={sources.participation}
                onChange={(v) => setSources(s => ({ ...s, participation: v }))}
              />
              <ToggleRow
                title="Award badges"
                subtitle="Milestone badges (first goal, streaks, POTM, perfect attendance) award XP when unlocked. Turn off if streak-chasing is getting anxious."
                checked={sources.badges}
                onChange={(v) => setSources(s => ({ ...s, badges: v }))}
              />
            </div>
            <p className="mt-4 text-[11px] text-ink-primary/50 leading-relaxed">
              Your own recognitions (whispers, live grants, converting a kudos to XP) always land.
              You chose to give them, we won't second-guess that.
            </p>
          </section>
        )}

        {/* Team XP status */}
        <section className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 p-4 sm:p-5">
          <p className="text-[10px] uppercase tracking-widest font-bold text-ink-primary/55">
            Team XP status
          </p>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-2xl font-black tabular-nums">{totalSeasonXp.toLocaleString()}</span>
            <span className="text-xs text-ink-primary/60">total XP across the squad</span>
          </div>
          {topPlayers.length === 0 ? (
            <p className="mt-3 text-sm text-ink-primary/55">
              No XP earned yet. Once kids start logging practice or RSVPing, points start landing here.
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {topPlayers.map((p, i) => (
                <li key={p.id} className="flex items-center gap-3">
                  <span className="w-6 text-xs font-bold text-ink-primary/45 tabular-nums">{i + 1}.</span>
                  <span className="flex-1 truncate text-sm font-semibold">{p.name}</span>
                  <span className="text-[11px] font-bold text-brand-primary/80 tabular-nums">Lv {p.level}</span>
                  <span className="text-[11px] text-ink-primary/55 tabular-nums">{p.xp.toLocaleString()} XP</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Save bar */}
        <div className="sticky bottom-4 flex items-center justify-between gap-3 rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 px-4 py-3">
          <span className="text-xs text-ink-primary/60">
            {dirty ? 'Unsaved changes' : 'All saved'}
          </span>
          <button
            type="button"
            onClick={save}
            disabled={!dirty || saving}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-brand-primary text-white text-sm font-bold disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving...' : 'Save'}
            <AppIcon name="arrow-right" className="w-3.5 h-3.5" />
          </button>
        </div>

        {toast && (
          <div className="fixed left-1/2 -translate-x-1/2 bottom-24 rounded-full bg-ink-primary text-surface-base text-xs font-bold px-4 py-2 shadow-lg">
            {toast}
          </div>
        )}
      </div>
    </div>
  );
};

const ToggleSwitch: React.FC<{
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}> = ({ checked, onChange, label }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    onClick={() => onChange(!checked)}
    className={`shrink-0 relative inline-flex h-7 w-12 items-center rounded-full transition ${
      checked ? 'bg-brand-primary' : 'bg-line-default/25'
    }`}
  >
    <span
      className={`inline-block h-5 w-5 rounded-full bg-white shadow transform transition ${
        checked ? 'translate-x-6' : 'translate-x-1'
      }`}
    />
  </button>
);

const ToggleRow: React.FC<{
  title: string;
  subtitle: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}> = ({ title, subtitle, checked, onChange }) => (
  <div className="rounded-xl bg-surface-base/50 ring-1 ring-line-default/10 p-3 flex items-start gap-3">
    <div className="min-w-0 flex-1">
      <p className="text-sm font-bold">{title}</p>
      <p className="mt-1 text-[12px] text-ink-primary/65 leading-snug">{subtitle}</p>
    </div>
    <ToggleSwitch checked={checked} onChange={onChange} label={title} />
  </div>
);

export default CoachXpConfig;

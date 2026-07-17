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
import { XP_SOURCE_LABELS, XpSourceKey } from '../utils/xpSource';

/**
 * Coach XP Config — /coach/xp
 *
 * Ship 2 (2026-07-17): per-source toggles. Master enable stays on top,
 * then four collapsible sections group the 11 per-source keys:
 *
 *  1. Participation      — practice, rsvp, kidChat
 *  2. Milestones         — firstGoal, firstAssist, firstSave,
 *                          firstCleanSheet, firstPotm
 *  3. Streaks & attendance — streaks, perfectAttendance
 *  4. Coach actions      — whisper
 *
 * Ship 1's coarse `participation` + `badges` keys stay on the team doc
 * as fallbacks. Teams that only ever flipped Ship 1's two toggles keep
 * the same behavior until the coach opens a section here and sets an
 * explicit per-source flag. Coach live grants + kudos->XP are NOT
 * exposed — those stay always-on when master is on (the coach chose
 * to grant, we don't second-guess).
 */

// Per-source toggle grouping. Order here drives the UI order.
type SectionKey = 'participation' | 'milestones' | 'streaksAttendance' | 'coachActions';

interface SectionSpec {
  key: SectionKey;
  title: string;
  keys: XpSourceKey[];
}

const SECTIONS: SectionSpec[] = [
  {
    key: 'participation',
    title: 'Participation',
    keys: ['practice', 'rsvp', 'kidChat'],
  },
  {
    key: 'milestones',
    title: 'Milestones',
    keys: ['firstGoal', 'firstAssist', 'firstSave', 'firstCleanSheet', 'firstPotm'],
  },
  {
    key: 'streaksAttendance',
    title: 'Streaks & attendance',
    keys: ['streaks', 'perfectAttendance'],
  },
  {
    key: 'coachActions',
    title: 'Coach actions',
    keys: ['whisper'],
  },
];

// Warm-voice subtitle for each per-source toggle. Kept here (not in
// xpSource.ts) so the resolver stays UI-agnostic.
const XP_SOURCE_SUBTITLES: Record<XpSourceKey, string> = {
  practice: '+5 XP when a kid taps "I did it today" on a practice log.',
  rsvp: '+5 XP when a kid flips their own RSVP to going.',
  kidChat: '+2 XP per kid chat message, daily cap 20.',
  firstGoal: '+100 XP the first time a kid scores.',
  firstAssist: '+100 XP the first time a kid picks up an assist.',
  firstSave: '+100 XP the first time a keeper makes a save.',
  firstCleanSheet: '+100 XP the first time a keeper holds a clean sheet.',
  firstPotm: '+150 XP the first time a kid wins Player of the Match.',
  streaks: '+50 to +400 XP as practice streaks hit 5, 10, 25, 50 days.',
  perfectAttendance: '+200 XP for perfect attendance across a run of team events.',
  whisper: '+50 XP each time you send a parent whisper.',
};

/** Resolve the initial per-source toggle state. Reads explicit per-source
 *  keys first; if missing, mirrors the Ship 1 coarse fallback so the
 *  displayed state matches what's actually granting. */
function initialSourceValue(
  key: XpSourceKey,
  sources: Record<string, unknown> | undefined | null,
): boolean {
  if (!sources) return true;
  const explicit = sources[key];
  if (explicit === true) return true;
  if (explicit === false) return false;
  // Fall back to coarse Ship 1 keys.
  if (key === 'practice' || key === 'rsvp' || key === 'kidChat') {
    return sources.participation !== false;
  }
  if (key === 'whisper') return true;
  // Everything else falls under Ship 1 'badges'.
  return sources.badges !== false;
}

type PendingSources = Partial<Record<XpSourceKey, boolean>>;

// Outer wrapper: keying on selectedTeamId forces a clean remount when the
// coach switches teams, so local toggle state never flashes stale values
// from the previous team.
const CoachXpConfig: React.FC = () => {
  const { selectedTeamId } = useTeam();
  return <CoachXpConfigInner key={selectedTeamId || 'no-team'} />;
};

const CoachXpConfigInner: React.FC = () => {
  const { userData } = useAuth();
  const { selectedTeam, selectedTeamId } = useTeam();

  // Hooks BEFORE any conditional return — react hook rules.
  const initialEnabled = (selectedTeam as any)?.xpConfig?.enabled === true;
  const initialSources: PendingSources = useMemo(() => {
    const src = (selectedTeam as any)?.xpConfig?.sources || {};
    const out: PendingSources = {};
    (Object.keys(XP_SOURCE_LABELS) as XpSourceKey[]).forEach((k) => {
      out[k] = initialSourceValue(k, src);
    });
    return out;
  }, [selectedTeam]);

  const [enabled, setEnabled] = useState<boolean>(initialEnabled);
  const [sources, setSources] = useState<PendingSources>(initialSources);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [openSections, setOpenSections] = useState<Record<SectionKey, boolean>>({
    participation: false,
    milestones: false,
    streaksAttendance: false,
    coachActions: false,
  });

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

  const dirty = useMemo(() => {
    if (enabled !== initialEnabled) return true;
    for (const k of Object.keys(XP_SOURCE_LABELS) as XpSourceKey[]) {
      if ((sources[k] ?? true) !== (initialSources[k] ?? true)) return true;
    }
    return false;
  }, [enabled, sources, initialEnabled, initialSources]);

  const coachOnThisTeam = isCoachOfTeam(userData as any, selectedTeam as any);

  const save = async () => {
    if (!selectedTeamId || saving) return;
    setSaving(true);
    try {
      // Write each per-source key with its own dot-notation path so
      // future keys on xpConfig.sources aren't wiped by an older client
      // that only knows a subset. Ship 1's coarse `participation` and
      // `badges` keys are preserved (never touched here) so a team that
      // only ever set those keeps its documented fallback behavior for
      // any per-source key the coach didn't override.
      const patch: Record<string, any> = {
        'xpConfig.enabled': enabled,
      };
      (Object.keys(XP_SOURCE_LABELS) as XpSourceKey[]).forEach((k) => {
        patch[`xpConfig.sources.${k}`] = sources[k] !== false;
      });
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

        {/* Per-source sections — dimmed but visible when master is off, so the
            coach can preview / stage source config before flipping master on. */}
        <section
          className={`rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 p-4 sm:p-5 transition ${
            enabled ? '' : 'opacity-50 pointer-events-none'
          }`}
          aria-disabled={!enabled}
        >
          <p className="text-[10px] uppercase tracking-widest font-bold text-ink-primary/55">
            What earns XP
          </p>
          {!enabled && (
            <p className="mt-2 text-[11px] text-ink-primary/55 leading-relaxed">
              Turn on Player XP above to configure sources.
            </p>
          )}
          <div className="mt-3 space-y-2">
            {SECTIONS.map((section) => {
              const on = section.keys.filter(k => sources[k] !== false).length;
              const total = section.keys.length;
              const isOpen = openSections[section.key];
              return (
                <div key={section.key} className="rounded-xl bg-surface-base/50 ring-1 ring-line-default/10 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setOpenSections(s => ({ ...s, [section.key]: !s[section.key] }))}
                    className="w-full flex items-center justify-between gap-3 p-3 text-left"
                    aria-expanded={isOpen}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-bold">{section.title}</p>
                      <p className="mt-0.5 text-[11px] text-ink-primary/55">
                        {on} of {total} on
                      </p>
                    </div>
                    <svg
                      className={`w-4 h-4 text-ink-primary/50 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      viewBox="0 0 24 24"
                    >
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>
                  {isOpen && (
                    <div className="border-t border-line-default/10 p-3 space-y-2.5">
                      {section.keys.map((k) => (
                        <ToggleRow
                          key={k}
                          title={XP_SOURCE_LABELS[k]}
                          subtitle={XP_SOURCE_SUBTITLES[k]}
                          checked={sources[k] !== false}
                          disabled={!enabled}
                          onChange={(v) => setSources(s => ({ ...s, [k]: v }))}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <p className="mt-4 text-[11px] text-ink-primary/50 leading-relaxed">
            Live grants and converting a kudos to XP always land. You chose to give
            them, we won't second-guess that.
          </p>
        </section>

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
  disabled?: boolean;
}> = ({ checked, onChange, label, disabled }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    aria-disabled={disabled}
    disabled={disabled}
    onClick={() => { if (!disabled) onChange(!checked); }}
    className={`shrink-0 relative inline-flex h-7 w-12 items-center rounded-full transition ${
      checked ? 'bg-brand-primary' : 'bg-line-default/25'
    } ${disabled ? 'cursor-not-allowed' : ''}`}
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
  disabled?: boolean;
}> = ({ title, subtitle, checked, onChange, disabled }) => (
  <div className="rounded-lg bg-surface-elevated ring-1 ring-line-default/10 p-3 flex items-start gap-3">
    <div className="min-w-0 flex-1">
      <p className="text-sm font-bold">{title}</p>
      <p className="mt-0.5 text-[11px] text-ink-primary/60 leading-snug">{subtitle}</p>
    </div>
    <ToggleSwitch checked={checked} onChange={onChange} label={title} disabled={disabled} />
  </div>
);

export default CoachXpConfig;

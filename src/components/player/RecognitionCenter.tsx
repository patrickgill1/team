import React, { useMemo, useState } from 'react';
import type { Player, Team, UserData, Season, PlayerMembership } from '../../types';
import { isCoachOfTeam, formatDate } from '../../utils/helpers';
import { buildSidelineShouts, SHOUT_TYPE_LABEL, shoutAccentClass, SidelineShoutType } from '../../utils/sidelineShouts';
import ProfileCard from './ProfileCard';

// RecognitionCenter — the unified Story-tab home for every positive
// moment on a kid's profile. Absorbs the old FeaturedShoutCard header,
// the SidelineShoutsSection feed + filter tabs, the Awards trophy
// tiles, and the Vote History drawer so the parent sees ONE card with
// a coherent story instead of four stacked shells.
//
// Scope model (This Season | Career):
//   - Season mode (default): every source is client-filtered to
//     selectedTeamId + activeSeason's date window. Matches the rest
//     of the Story tab so the numbers add up.
//   - Career mode: every source unfiltered, feed grouped by
//     "Season · Team" section headers using memberships to look up
//     labels. POTM tile flips to "POTM career". Reason-count tile
//     hides (career scan is expensive and reads noisy).
//
// See design contract in the 2026-07-15 refactor doc for the full
// props + copy + risk list.

export type RecognitionFilter = 'all' | SidelineShoutType;

type KudosEntry = {
  id: string;
  senderUid: string;
  senderName: string;
  senderAvatarUrl?: string | null;
  note: string;
  presetKind?: string | null;
  createdAt: Date;
  xpAwarded?: number;
  xpAwardedByName?: string;
  xpAwardedAt?: Date | null;
};

type WhisperEntry = {
  id: string;
  coachUid?: string;
  coachName: string;
  coachAvatarUrl?: string | null;
  message: string;
  createdAt: Date;
  teamId?: string;
};

type XpEventEntry = {
  id: string;
  xp: number;
  source: string;
  note?: string | null;
  awardedByName?: string | null;
  awardedBy?: string;
  createdAt: Date;
  teamId?: string;
};

type PlayerVoting = {
  voting: any;
  playerVotes: Array<{ voterName: string; reason?: string }>;
};

interface Props {
  playerId: string;
  player: Player;
  selectedTeamId: string;
  selectedTeam: Team | null;
  activeSeason: Season | null;
  availableSeasons: Season[];
  kudos: KudosEntry[];
  whispers: WhisperEntry[];
  xpEvents: XpEventEntry[];
  allPlayerVotings: PlayerVoting[];
  memberships: PlayerMembership[];
  teamNameById?: Record<string, string>;
  userData: UserData | null;
  canGiveKudos: boolean;
  isCoach: boolean;
  setKudosList: React.Dispatch<React.SetStateAction<KudosEntry[]>>;
  /** Ref forwarded so the legacy ?tab=whispers deep-link still lands
   *  on the recognition surface. */
  sectionRef?: React.Ref<HTMLElement>;
  /** Ref forwarded so the legacy ?tab=awards deep-link scrolls to
   *  the Vote History drawer inside this card. */
  awardsRef?: React.Ref<HTMLElement>;
}

const PAGE_SIZE = 20;

const FILTERS: Array<{ key: RecognitionFilter; label: string }> = [
  { key: 'all',          label: 'All' },
  { key: 'kudos',        label: 'Kudos' },
  { key: 'whisper',      label: 'Whispers' },
  { key: 'xp_note',      label: 'XP notes' },
  { key: 'potm_comment', label: 'POTM comments' },
  { key: 'badge',        label: 'Badges' },
];

// Season window helpers — used to filter every source in Season mode.
// A null season legitimately means "team has no active season doc"
// (brand-new team, between-season gap, or the fetch racing loadProfile).
// Fail closed: return false so Season mode reads as empty instead of
// silently promoting itself to Career-mode. The wall renders its empty
// state and the parent isn't tricked into thinking cross-season history
// happened "this season."
function inSeasonWindow(t: Date | undefined, season: Season | null): boolean {
  if (!season) return false;
  if (!t) return false;
  const ms = t instanceof Date ? t.getTime() : new Date(t as any).getTime();
  const start = season.startDate ? new Date(season.startDate).getTime() : -Infinity;
  const end = season.endDate ? new Date(season.endDate).getTime() : Infinity;
  return ms >= start && ms <= end;
}

const RecognitionCenter: React.FC<Props> = ({
  playerId,
  player,
  selectedTeamId,
  selectedTeam,
  activeSeason,
  availableSeasons,
  kudos,
  whispers,
  xpEvents,
  allPlayerVotings,
  memberships,
  teamNameById,
  userData,
  canGiveKudos,
  isCoach,
  setKudosList,
  sectionRef,
  awardsRef,
}) => {
  const [scopeMode, setScopeMode] = useState<'season' | 'career'>('season');
  const [filterKey, setFilterKey] = useState<RecognitionFilter>('all');
  const [page, setPage] = useState(1);

  const first = player.name?.split(' ')[0] || 'this player';

  // ─── Season-scoped source arrays (memoized) ─────────────────────
  // Note: no early return when selectedTeamId is empty — the season
  // window is still the right cut and dropping the filter here would
  // leak career-scale history into "This Season" for adult-pickup
  // profiles (bug caught by verifier 2026-07-15). The truthy-guard on
  // teamId already handles the empty-selectedTeamId case correctly.
  const seasonKudos = useMemo(() => {
    return kudos.filter(k => {
      if ((k as any).teamId && (k as any).teamId !== selectedTeamId) return false;
      return inSeasonWindow(k.createdAt, activeSeason);
    });
  }, [kudos, selectedTeamId, activeSeason]);

  const seasonWhispers = useMemo(() => {
    return whispers.filter(w => {
      if (w.teamId && w.teamId !== selectedTeamId) return false;
      return inSeasonWindow(w.createdAt, activeSeason);
    });
  }, [whispers, selectedTeamId, activeSeason]);

  const seasonXpEvents = useMemo(() => {
    return xpEvents.filter(e => {
      if (e.teamId && e.teamId !== selectedTeamId) return false;
      return inSeasonWindow(e.createdAt, activeSeason);
    });
  }, [xpEvents, selectedTeamId, activeSeason]);

  const seasonPotmVotings = useMemo(() => {
    return allPlayerVotings.filter(pv => {
      const v: any = pv.voting;
      if (v?.teamId && v.teamId !== selectedTeamId) return false;
      const when: Date | undefined = (v?.gameDate instanceof Date ? v.gameDate : v?.gameDate?.toDate?.())
        || (v?.closedAt instanceof Date ? v.closedAt : v?.closedAt?.toDate?.());
      return inSeasonWindow(when, activeSeason);
    });
  }, [allPlayerVotings, selectedTeamId, activeSeason]);

  // ─── Shout stream ───────────────────────────────────────────────
  const allShouts = useMemo(() => {
    if (scopeMode === 'season') {
      return buildSidelineShouts({
        player,
        kudosList: seasonKudos,
        whispers: seasonWhispers,
        xpEvents: seasonXpEvents,
        potmVotes: seasonPotmVotings,
        activeSeasonId: activeSeason?.id,
      });
    }
    return buildSidelineShouts({
      player,
      kudosList: kudos,
      whispers,
      xpEvents,
      potmVotes: allPlayerVotings,
    });
  }, [scopeMode, player, seasonKudos, seasonWhispers, seasonXpEvents, seasonPotmVotings, activeSeason, kudos, whispers, xpEvents, allPlayerVotings]);

  const countByFilter = (t: RecognitionFilter) =>
    t === 'all' ? allShouts.length : allShouts.filter(s => s.type === t).length;
  const visibleFilters = useMemo(
    () => FILTERS.filter(f => f.key === 'all' || countByFilter(f.key) > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allShouts],
  );

  const filteredShouts = useMemo(() => (
    filterKey === 'all' ? allShouts : allShouts.filter(s => s.type === filterKey)
  ), [filterKey, allShouts]);

  // Client-side pagination — reset when scope/filter changes.
  React.useEffect(() => { setPage(1); }, [scopeMode, filterKey]);
  const pagedShouts = filteredShouts.slice(0, page * PAGE_SIZE);

  // ─── Featured POTM quote (rotating) ─────────────────────────────
  const featuredQuotes = useMemo(() => {
    const source = scopeMode === 'season' ? seasonPotmVotings : allPlayerVotings;
    const out: Array<{ voterName: string; reason: string; when: Date }> = [];
    for (const pv of source) {
      const v: any = pv.voting;
      const when: Date = v?.closedAt?.toDate?.()
        || (v?.closedAt instanceof Date ? v.closedAt : null)
        || v?.gameDate?.toDate?.()
        || (v?.gameDate instanceof Date ? v.gameDate : new Date());
      for (const pvote of pv.playerVotes || []) {
        const reason = (pvote.reason || '').trim();
        if (!reason) continue;
        out.push({ voterName: pvote.voterName || 'A voter', reason, when });
      }
    }
    return out.sort((a, b) => b.when.getTime() - a.when.getTime());
  }, [scopeMode, seasonPotmVotings, allPlayerVotings]);
  const [featuredIdx, setFeaturedIdx] = useState<number>(0);
  // Depend on the array identity (not just length) so a scope swap
  // that happens to produce the same-length array still resets the
  // index. Otherwise Career → Season with matching lengths keeps the
  // old career-sourced quote pointing at a season-source quote.
  React.useEffect(() => {
    setFeaturedIdx(featuredQuotes.length > 0 ? Math.floor(Math.random() * featuredQuotes.length) : 0);
  }, [featuredQuotes]);
  const featured = featuredQuotes[featuredIdx % Math.max(1, featuredQuotes.length)];

  // ─── Tile: POTM count ───────────────────────────────────────────
  const potmWins = useMemo(() => {
    const source = scopeMode === 'season' ? seasonPotmVotings : allPlayerVotings;
    return source.filter(({ voting: v }) => {
      const w = (Array.isArray(v?.winners) && v.winners.some((x: any) => x?.playerId === playerId))
        || v?.winner?.playerId === playerId;
      return !!w;
    }).length;
  }, [scopeMode, seasonPotmVotings, allPlayerVotings, playerId]);

  // ─── Tile: Recognized in N games (reason-bearing votes) ────────
  const reasonedGames = useMemo(() => {
    // Only meaningful in Season mode per the design contract.
    if (scopeMode !== 'season') return 0;
    return seasonPotmVotings.filter(pv => pv.playerVotes.some(v => v.reason && v.reason.trim())).length;
  }, [scopeMode, seasonPotmVotings]);

  // ─── Vote History rows (drawer) ─────────────────────────────────
  const voteHistoryRows = useMemo(() => {
    const source = scopeMode === 'season' ? seasonPotmVotings : allPlayerVotings;
    return source;
  }, [scopeMode, seasonPotmVotings, allPlayerVotings]);

  // ─── Career grouping: "Season · Team" section labels ────────────
  const seasonById = useMemo(() => {
    const m: Record<string, Season> = {};
    for (const s of availableSeasons) m[s.id] = s;
    return m;
  }, [availableSeasons]);
  const teamNameForMembership = (m: PlayerMembership | undefined): string | null => {
    if (!m) return null;
    if (m.teamId === selectedTeamId) return selectedTeam?.name || null;
    return teamNameById?.[m.teamId] || null;
  };
  const bucketLabelForShout = (t: Date): string => {
    // Career-mode section headers: find the first membership whose
    // season contains this timestamp. Unresolvable → "Earlier".
    const ms = t.getTime();
    for (const m of memberships) {
      const season = m.seasonId ? seasonById[m.seasonId] : null;
      if (!season) continue;
      const start = season.startDate ? new Date(season.startDate).getTime() : -Infinity;
      const end = season.endDate ? new Date(season.endDate).getTime() : Infinity;
      if (ms >= start && ms <= end) {
        const teamName = teamNameForMembership(m) || 'Team';
        return `${teamName} · ${season.name}`;
      }
    }
    return 'Earlier seasons';
  };

  // ─── Kudos convert-to-XP (reused from SidelineShoutsSection) ────
  const handleConvertKudos = async (kudosRaw: KudosEntry) => {
    const teamIdForConvert = (player as any).teamId
      || (Array.isArray((player as any).teamIds) ? (player as any).teamIds[0] : '')
      || selectedTeamId
      || '';
    if (!teamIdForConvert) { alert('Missing team context: cannot convert.'); return; }
    const raw = window.prompt(`Add XP for this Kudos from ${kudosRaw.senderName}? Enter amount 1 to 500.`, '25');
    if (!raw) return;
    const amount = parseInt(raw, 10);
    if (!Number.isFinite(amount) || amount < 1 || amount > 500) { alert('Amount must be 1 to 500.'); return; }
    try {
      const { workerFetch } = await import('../../utils/workerFetch');
      const res = await workerFetch('/xp/convert-kudos', {
        method: 'POST',
        body: JSON.stringify({ teamId: teamIdForConvert, playerId: player.id, kudosId: kudosRaw.id, amount }),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) { alert(`Could not convert: ${data?.error || res.status}`); return; }
      setKudosList(list => list.map(x => x.id === kudosRaw.id
        ? { ...x, xpAwarded: amount, xpAwardedByName: userData?.name || 'Coach', xpAwardedAt: new Date() }
        : x));
      try {
        const { tplKudosXpAwarded, sendEmailBatch, sendPushToPlayerParents, getParentEmailsForPlayer } = await import('../../utils/notify');
        sendPushToPlayerParents(player.id, {
          title: `+${amount} XP for ${first}`,
          body: `Coach agreed with ${kudosRaw.senderName}'s Kudos: "${kudosRaw.note.slice(0, 120)}"`,
          url: `/player/${player.id}?tab=xp`,
        }, 'devPlan').catch(() => {});
        const parents = await getParentEmailsForPlayer(player.id, 'devPlan');
        if (parents.length > 0) {
          const { subject, html } = tplKudosXpAwarded({
            playerName: player.name || 'the player',
            senderName: kudosRaw.senderName,
            coachName: userData?.name || 'Coach',
            amount,
            note: kudosRaw.note,
            playerId: player.id,
          });
          await sendEmailBatch(parents.map(p => ({ to: p.email, subject, html })));
        }
      } catch { /* non-fatal */ }
    } catch (err: any) {
      alert(`Convert failed: ${err?.message || 'network error'}`);
    }
  };

  return (
    <ProfileCard sectionRef={sectionRef} id="story-recognition">
      {/* ─── Header row: featured quote + scope toggle ───────────── */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div className="min-w-0 flex-1">
          {featured ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] font-black uppercase tracking-widest text-ink-primary/55">
                Player of the Match: Featured shout
              </span>
              <blockquote className="text-[15px] leading-snug text-ink-primary font-medium">
                <span className="text-ink-primary/40 mr-0.5">&ldquo;</span>
                {featured.reason}
                <span className="text-ink-primary/40 ml-0.5">&rdquo;</span>
              </blockquote>
              <div className="flex items-center gap-2 text-[11px]">
                <span className="text-ink-primary/85 font-bold">{featured.voterName}</span>
                <span className="text-ink-primary/25">·</span>
                <span className="text-ink-primary/50">on {first}</span>
                {featuredQuotes.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setFeaturedIdx(i => (i + 1) % featuredQuotes.length)}
                    className="ml-1 text-[10px] font-extrabold uppercase tracking-widest text-brand-primary-soft hover:text-brand-primary"
                    aria-label="Show another quote"
                  >
                    Next
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] font-black uppercase tracking-widest text-ink-primary/55">
                Recognition
              </span>
              <h3 className="text-base font-semibold text-ink-primary truncate">
                {first}&rsquo;s wall
              </h3>
            </div>
          )}
        </div>
        <div className="shrink-0 flex flex-col items-end gap-1">
          <div
            className="inline-flex rounded-full bg-line-default/[0.08] p-0.5"
            role="tablist"
            aria-label="Recognition scope"
          >
            {(['season', 'career'] as const).map(mode => {
              const isActive = scopeMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setScopeMode(mode)}
                  className={`px-3 py-1 rounded-full text-[11px] font-black uppercase tracking-widest transition ${
                    isActive
                      ? 'bg-ink-primary text-surface-base shadow'
                      : 'text-ink-primary/60 hover:text-ink-primary'
                  }`}
                >
                  {mode === 'season' ? 'This Season' : 'Career'}
                </button>
              );
            })}
          </div>
          {scopeMode === 'career' && (
            <span className="text-[10px] text-ink-primary/50">
              Every team, every season they have played.
            </span>
          )}
        </div>
      </div>

      {/* ─── Tile row: POTM + reasoned-games ─────────────────────── */}
      {(potmWins > 0 || reasonedGames > 0) && (
        <div className={reasonedGames > 0 && scopeMode === 'season' ? 'grid grid-cols-2 gap-3' : 'grid grid-cols-1 gap-3'}>
          {potmWins > 0 && (
            <div className="rounded-xl bg-surface-input/60 ring-1 ring-line-default/15 p-4">
              <div className="flex items-center gap-2 mb-2 text-amber-500">
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M5 4h14v2h2v4a4 4 0 0 1-4 4h-.55A6 6 0 0 1 13 18v2h2v2H9v-2h2v-2a6 6 0 0 1-3.45-4H7a4 4 0 0 1-4-4V6h2zm0 4v2a2 2 0 0 0 2 2V8zm14 0v4a2 2 0 0 0 2-2V8z" /></svg>
              </div>
              <div className="text-3xl sm:text-4xl font-black leading-none text-ink-primary tabular-nums">{potmWins}</div>
              <div className="text-[10px] uppercase tracking-widest font-bold text-ink-primary/60 mt-1">
                {scopeMode === 'season' ? 'POTM this season' : 'POTM (career)'}
              </div>
            </div>
          )}
          {reasonedGames > 0 && scopeMode === 'season' && (
            <div className="rounded-xl bg-surface-input/60 ring-1 ring-line-default/15 p-4">
              <div className="flex items-center gap-2 mb-2 text-brand-primary-soft">
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>
              </div>
              <div className="text-3xl sm:text-4xl font-black leading-none text-ink-primary tabular-nums">{reasonedGames}</div>
              <div className="text-[10px] uppercase tracking-widest font-bold text-ink-primary/60 mt-1">
                Recognized in {reasonedGames === 1 ? 'game' : 'games'} this season
              </div>
            </div>
          )}
        </div>
      )}
      {scopeMode === 'season' && potmWins === 0 && reasonedGames === 0 && (
        <div className="rounded-xl bg-surface-input/40 ring-1 ring-line-default/10 p-3 text-center">
          <p className="text-xs text-ink-primary/60">POTM votes open after the next match.</p>
        </div>
      )}

      {/* ─── Filter tabs (wrap, never scroll) ─────────────────────── */}
      {allShouts.length > 0 && (
        <div className="mt-2 border-b border-line-default/15" role="tablist" aria-label="Filter recognition">
          <div className="flex flex-wrap items-stretch gap-x-1 gap-y-0.5">
            {visibleFilters.map(f => {
              const c = countByFilter(f.key);
              const isActive = filterKey === f.key;
              return (
                <button
                  key={f.key}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setFilterKey(f.key)}
                  className={
                    'py-2 px-2.5 text-center transition-colors border-b-2 -mb-px whitespace-nowrap ' +
                    (isActive
                      ? 'border-brand-primary text-ink-primary'
                      : 'border-transparent text-ink-primary/50 hover:text-ink-primary/85')
                  }
                >
                  <span className="text-[11px] font-black uppercase">
                    {f.label}
                    <span className={'ml-1 tabular-nums font-bold text-[10px] ' + (isActive ? 'text-brand-primary' : 'text-ink-primary/40')}>
                      {c}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ─── Feed ────────────────────────────────────────────────── */}
      {filteredShouts.length === 0 ? (
        <div className="mt-2 rounded-xl bg-surface-input/40 ring-1 ring-line-default/10 p-6 text-center flex flex-col items-center gap-2">
          <div className="w-9 h-9 rounded-full bg-brand-primary/10 text-brand-primary flex items-center justify-center">
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2l2.39 4.84L19.8 7.6l-3.9 3.8.92 5.36L12 14.27 7.18 16.76 8.1 11.4 4.2 7.6l5.41-.76L12 2z" /></svg>
          </div>
          <p className="text-sm text-ink-primary/85 font-semibold">
            {scopeMode === 'season'
              ? 'Nothing on the wall yet this season. First kudos, first badge, first POTM comment: they all land here.'
              : 'The moments show up here as they happen. Nothing to look back on yet.'}
          </p>
          {canGiveKudos && (
            <p className="text-xs text-ink-primary/55">Tap Give Kudos above to send {first} the first shout.</p>
          )}
        </div>
      ) : (
        <ul className="mt-2 space-y-3">
          {(() => {
            // Career mode: emit "Season · Team" section headers when
            // the bucket label changes between adjacent shouts.
            const nodes: React.ReactNode[] = [];
            let lastBucket = '';
            for (const s of pagedShouts) {
              if (scopeMode === 'career') {
                const bucket = bucketLabelForShout(s.timestamp);
                if (bucket !== lastBucket) {
                  nodes.push(
                    <li key={`hdr-${bucket}-${s.id}`} className="pt-2 first:pt-0">
                      <div className="text-[10px] font-black uppercase tracking-widest text-ink-primary/45">
                        {bucket}
                      </div>
                    </li>
                  );
                  lastBucket = bucket;
                }
              }
              const isKudosShout = s.type === 'kudos';
              const kudosId = isKudosShout ? s.id.replace(/^kudos-/, '') : null;
              const kudosRaw = kudosId ? kudos.find(k => k.id === kudosId) : null;
              const kudosConverted = kudosRaw && typeof kudosRaw.xpAwarded === 'number' && kudosRaw.xpAwarded > 0;
              const canConvertKudos = isKudosShout
                && !!kudosRaw
                && !kudosConverted
                && !!userData
                && isCoachOfTeam(userData, selectedTeam)
                && (selectedTeam as any)?.xpConfig?.enabled === true;
              nodes.push(
                <li key={s.id} className={`py-3 sm:py-4 pr-3 sm:pr-4 pl-4 sm:pl-5 rounded-xl bg-surface-elevated ring-1 ring-line-default/15 border-l-4 ${shoutAccentClass(s.type)}`}>
                  <div className="flex items-start gap-3">
                    {s.type === 'badge' && s.badgeImage ? (
                      <img src={s.badgeImage} className="w-9 h-9 object-contain flex-shrink-0" alt="" />
                    ) : s.fromAvatarUrl ? (
                      <img src={s.fromAvatarUrl} alt="" className="w-9 h-9 rounded-full object-cover flex-shrink-0" />
                    ) : (
                      <div className="w-9 h-9 rounded-full bg-brand-primary/15 text-brand-primary flex items-center justify-center font-black text-sm flex-shrink-0">
                        {(s.fromName || '?').charAt(0)}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-bold text-ink-primary">{s.fromName}</span>
                        <span className="text-[9.5px] font-black uppercase tracking-[0.14em] text-ink-primary/50">
                          {SHOUT_TYPE_LABEL[s.type]}
                        </span>
                        {typeof s.xpAmount === 'number' && s.xpAmount > 0 && (
                          <span className="text-[10px] font-black uppercase tracking-widest text-amber-600 bg-amber-500/10 px-2 py-0.5 rounded-full">
                            +{s.xpAmount} XP
                          </span>
                        )}
                        <span className="text-[11px] text-ink-primary/50 ml-auto tabular-nums">
                          {s.timestamp.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                        </span>
                      </div>
                      <p className="text-[14px] text-ink-primary/90 mt-1 whitespace-pre-wrap leading-relaxed">{s.body}</p>
                      {canConvertKudos && kudosRaw && (
                        <button
                          type="button"
                          onClick={() => handleConvertKudos(kudosRaw)}
                          className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-black uppercase tracking-wider bg-brand-primary/10 text-brand-primary ring-1 ring-brand-primary/30 hover:bg-brand-primary/20 transition"
                        >
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>
                          Convert to XP
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              );
            }
            return nodes;
          })()}
        </ul>
      )}

      {filteredShouts.length > pagedShouts.length && (
        <div className="flex justify-center pt-1">
          <button
            type="button"
            onClick={() => setPage(p => p + 1)}
            className="text-xs font-black uppercase tracking-widest text-brand-primary hover:text-brand-primary-soft"
          >
            Show more ({filteredShouts.length - pagedShouts.length} left)
          </button>
        </div>
      )}

      {/* ─── Vote History drawer ─────────────────────────────────── */}
      {voteHistoryRows.length > 0 && (
        <details ref={awardsRef as any} id="story-awards" className="rounded-xl bg-surface-input/40 ring-1 ring-line-default/10">
          <summary className="group cursor-pointer list-none p-3 flex items-center justify-between gap-3">
            <span className="text-[11px] font-black uppercase tracking-widest text-ink-primary/60">
              Every game they were named ({voteHistoryRows.length})
            </span>
            <svg className="w-4 h-4 text-ink-primary/40 transition-transform group-open:rotate-180" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </summary>
          <div className="border-t border-line-default/10 p-3 flex flex-col gap-3">
            {voteHistoryRows.map(({ voting, playerVotes }) => {
              const isWin = voting.winners?.some((w: any) => w.playerId === playerId) || voting.winner?.playerId === playerId;
              const isCoWin = isWin && (voting.winners?.length || 0) > 1;
              const reasons = playerVotes.filter(v => v.reason);
              const when: Date | null = voting.gameDate instanceof Date ? voting.gameDate
                : (voting.gameDate?.toDate ? voting.gameDate.toDate() : null);
              return (
                <div
                  key={voting.id}
                  className={`rounded-xl overflow-hidden ${isWin ? 'bg-amber-500/[0.06] ring-1 ring-amber-400/40' : 'bg-surface-input/60 ring-1 ring-line-default/15'}`}
                >
                  <div className="p-3">
                    <div className="flex items-start gap-3">
                      <div className={`flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center ${isWin ? 'bg-amber-500 text-white' : 'bg-line-default/[0.1] text-ink-primary/70'}`}>
                        {isWin ? (
                          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M5 4h14v2h2v4a4 4 0 0 1-4 4h-.55A6 6 0 0 1 13 18v2h2v2H9v-2h2v-2a6 6 0 0 1-3.45-4H7a4 4 0 0 1-4-4V6h2zm0 4v2a2 2 0 0 0 2 2V8zm14 0v4a2 2 0 0 0 2-2V8z" /></svg>
                        ) : (
                          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-bold text-ink-primary truncate">{voting.gameTitle}</p>
                          {isWin && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-widest bg-amber-500 text-white">
                              {isCoWin ? `Co-Winner x${voting.winners!.length}` : 'Winner'}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-ink-primary/55 font-medium mt-0.5">
                          {when ? formatDate(when) : ''}
                          {' · '}
                          {playerVotes.length} vote{playerVotes.length !== 1 ? 's' : ''}
                        </p>
                      </div>
                    </div>
                    {reasons.length > 0 && (
                      <div className="mt-3 flex flex-col gap-2">
                        {reasons.map((v, i) => (
                          <div key={i} className="rounded-lg px-3 py-2 bg-surface-elevated ring-1 ring-line-default/10">
                            <p className="text-sm text-ink-primary/90 italic font-medium">&ldquo;{v.reason}&rdquo;</p>
                            <p className="text-[11px] text-ink-primary/50 mt-1 font-semibold">{v.voterName}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </details>
      )}
    </ProfileCard>
  );
};

export default RecognitionCenter;

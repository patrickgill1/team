import React from 'react';
import type { Player, Team, UserData } from '../../types';
import { isCoachOfTeam } from '../../utils/helpers';
import { buildSidelineShouts, SHOUT_TYPE_LABEL, shoutAccentClass } from '../../utils/sidelineShouts';
import EmptyState from '../common/EmptyState';
import ProfileCard from './ProfileCard';

// SidelineShoutsSection — the unified positive-moments feed for a
// player, extracted from PlayerProfile in the 2026-07-15 Direction B
// refactor so the same widget can live inside Story tab (and, if we
// ever need to, alongside other surfaces).
//
// Owns the filter chip row, the shout list render, and the coach
// "Convert to XP" affordance on Kudos-type shouts. Filter state stays
// local so the section can be dropped in without threading state up.
//
// Empty stream returns a friendly EmptyState; parent still renders
// the ProfileCard wrapper so the section header is visible.
//
// See project_sideline_shouts memory for the naming + intent.

export type ShoutFilter = 'all' | 'kudos' | 'whisper' | 'xp_note' | 'badge' | 'potm_comment';

interface Props {
  player: Player;
  selectedTeam: Team | null;
  userData: UserData | null;
  canGiveKudos: boolean;
  kudosList: Array<{
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
  }>;
  setKudosList: React.Dispatch<React.SetStateAction<Props['kudosList']>>;
  whispers: Array<{
    id: string;
    coachName: string;
    coachAvatarUrl?: string | null;
    message: string;
    createdAt: Date;
  }>;
  xpEvents: Array<{
    id: string;
    awardedByName?: string | null;
    awardedBy?: string;
    source: string;
    note?: string | null;
    xp: number;
    createdAt: Date;
  }>;
  allPlayerVotings: Array<{ voting: any; playerVotes: Array<{ voterName: string; reason?: string }> }>;
  /** Filter state — kept in parent so external prompts (legacy
   *  ?tab=whispers redirect + POTM "All N" chip) can pre-apply. */
  shoutFilter: ShoutFilter;
  onFilterChange: (f: ShoutFilter) => void;
  /** Ref forwarded so the parent can scrollIntoView from the legacy
   *  ?tab=whispers redirect. */
  sectionRef?: React.Ref<HTMLElement>;
}

// Tab labels — kept short so all 6 filters fit across the section at
// 375px width without wrapping OR horizontal scrolling ([[no-horizontal-pills]]).
// Long form ("From coach", "Whispers") collapsed to short form
// ("Coach", "Whisper") to survive the flex-1 divide at narrow widths.
const FILTERS: Array<{ key: ShoutFilter; label: string }> = [
  { key: 'all',           label: 'All' },
  { key: 'kudos',         label: 'Kudos' },
  { key: 'potm_comment',  label: 'POTM' },
  { key: 'xp_note',       label: 'Coach' },
  { key: 'whisper',       label: 'Whisper' },
  { key: 'badge',         label: 'Badges' },
];

const SidelineShoutsSection: React.FC<Props> = ({
  player,
  selectedTeam,
  userData,
  canGiveKudos,
  kudosList,
  setKudosList,
  whispers,
  xpEvents,
  allPlayerVotings,
  shoutFilter,
  onFilterChange,
  sectionRef,
}) => {
  const allShouts = buildSidelineShouts({
    player,
    kudosList,
    whispers,
    xpEvents,
    potmVotes: allPlayerVotings,
  });
  const first = player.name?.split(' ')[0] || 'this player';
  const countBy = (t: ShoutFilter) =>
    t === 'all' ? allShouts.length : allShouts.filter(s => s.type === t).length;
  const shouts = shoutFilter === 'all'
    ? allShouts
    : allShouts.filter(s => s.type === shoutFilter);

  return (
    <ProfileCard
      sectionRef={sectionRef}
      id="story-shouts"
      eyebrow="Sideline Shouts"
      title={`${allShouts.length} ${allShouts.length === 1 ? 'shout' : 'shouts'} from ${first}’s people`}
    >
      {allShouts.length > 0 && (() => {
        // 2026-07-15 (per Patrick): the wrapping pill row was reading
        // as "we ran out of room" when a kid had all 6 filter types
        // populated (Badges dropped to row 2). Rebuilt as a compact
        // segmented tab bar with a bottom underline on the active tab
        // — fits across the card width at 375px, never wraps, never
        // scrolls horizontally ([[no-horizontal-pills]]). Zero-count
        // filters are still hidden so the tab bar tightens for kids
        // with limited history.
        const visible = FILTERS.filter(f => f.key === 'all' || countBy(f.key) > 0);
        return (
          <div className="border-b border-line-default/15" role="tablist" aria-label="Filter shouts">
            <div className="flex items-stretch">
              {visible.map(f => {
                const c = countBy(f.key);
                const isActive = shoutFilter === f.key;
                return (
                  <button
                    key={f.key}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    onClick={() => onFilterChange(f.key)}
                    className={
                      'flex-1 min-w-0 py-2.5 px-1 text-center transition-colors border-b-2 -mb-px ' +
                      (isActive
                        ? 'border-brand-primary text-ink-primary'
                        : 'border-transparent text-ink-primary/50 hover:text-ink-primary/85')
                    }
                  >
                    {/* 2026-07-15: dropped `tracking-wider` and shrank
                        the count text so all 6 tabs + counts fit at
                        375px (iPhone SE) without truncating the
                        label. Verifier flagged the tight math:
                        "WHISPER 5" at 11px tracking-wider ate ~65px
                        of ~44px per-tab budget. This gives back
                        ~6-8px per tab. */}
                    <span className="block truncate text-[11px] font-black uppercase">
                      {f.label}
                      <span
                        className={
                          'ml-0.5 tabular-nums font-bold text-[10px] ' +
                          (isActive ? 'text-brand-primary' : 'text-ink-primary/40')
                        }
                      >
                        {c}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })()}

      {shouts.length === 0 ? (
        <EmptyState
          icon={<svg className="w-5 h-5 text-brand-primary" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2l2.39 4.84L19.8 7.6l-3.9 3.8.92 5.36L12 14.27 7.18 16.76 8.1 11.4 4.2 7.6l5.41-.76L12 2z" /></svg>}
          title={shoutFilter === 'all' ? 'No shouts yet' : `No ${(FILTERS.find(f => f.key === shoutFilter)?.label || '').toLowerCase()} yet`}
          description={shoutFilter !== 'all'
            ? `Nothing in this category yet. Try All to see the full stream.`
            : (canGiveKudos
              ? `Tap Give Kudos above to send ${first} the first shout.`
              : `When someone in ${first}'s Circle sends Kudos or Coach whispers a note, it'll show up here.`)}
        />
      ) : (
        <ul className="space-y-3">
          {shouts.map(s => {
            const isKudosShout = s.type === 'kudos';
            const kudosId = isKudosShout ? s.id.replace(/^kudos-/, '') : null;
            const kudosRaw = kudosId ? kudosList.find(k => k.id === kudosId) : null;
            const kudosConverted = kudosRaw && typeof kudosRaw.xpAwarded === 'number' && kudosRaw.xpAwarded > 0;
            const canConvertKudos = isKudosShout
              && !!kudosRaw
              && !kudosConverted
              && !!userData
              && isCoachOfTeam(userData, selectedTeam)
              && (selectedTeam as any)?.xpConfig?.enabled === true;
            const handleConvert = async () => {
              if (!kudosRaw) return;
              const teamIdForConvert = (player as any).teamId
                || (Array.isArray((player as any).teamIds) ? (player as any).teamIds[0] : '')
                || '';
              if (!teamIdForConvert) { alert('Missing team context — cannot convert.'); return; }
              const raw = window.prompt(`Add XP for this Kudos from ${kudosRaw.senderName}? Enter amount 1–500.`, '25');
              if (!raw) return;
              const amount = parseInt(raw, 10);
              if (!Number.isFinite(amount) || amount < 1 || amount > 500) { alert('Amount must be 1–500.'); return; }
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
              <li key={s.id} className={`p-3 sm:p-4 rounded-xl bg-surface-elevated ring-1 ring-line-default/15 border-l-4 ${shoutAccentClass(s.type)}`}>
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
                    {canConvertKudos && (
                      <button
                        type="button"
                        onClick={handleConvert}
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
          })}
        </ul>
      )}
    </ProfileCard>
  );
};

export default SidelineShoutsSection;

import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, doc, getDocs, onSnapshot, orderBy, query, where, documentId } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { useFirestore } from '../hooks/useFirestore';
import Header from '../components/common/Header';
import { createPlayerInvite } from '../utils/invites';
import InviteShareModal from '../components/common/InviteShareModal';
import KudosComposerModal from '../components/kudos/KudosComposerModal';
import { buildSidelineShouts, SHOUT_TYPE_LABEL, shoutAccentClass } from '../utils/sidelineShouts';
import type { Invite, Player } from '../types';

// PlayerCircle page — /circle. Patrick 2026-07-15:
//   "i think we should put player circle as its own page or button
//    as well, so people can truly understand what it is and not be
//    hidden. maybe that can be a cool hub for families to also
//    connect."
//
// Shape (MVP): one page, family-scoped. If the viewer has one kid,
// auto-select that kid's circle. If more, a chip-picker at top.
// For each kid the page renders:
//   - Kid hero (photo + name + jersey + team)
//   - Circle members grid (real avatars + names, tap to add more)
//   - "Add to circle" invite button that opens the same share modal
//     used elsewhere so grandparents/aunts/etc get the same paste-
//     into-text flow parents already know.
//   - Recent shouts feed scoped to THIS kid (top 12) with a "See on
//     profile" link into the full Sideline Shouts tab.
//
// Adult teams: don't show a "Circle" concept — players ARE the
// account. Redirect to Dashboard so nobody lands here on the wrong
// team context.

interface CircleMember {
  uid: string;
  name: string;
  photoURL?: string;
  isViewer: boolean;
  relationship?: string;
}

interface RawKudos {
  id: string;
  senderUid: string;
  senderName: string;
  senderAvatarUrl?: string | null;
  note: string;
  createdAt: any;
  xpAwarded?: number;
}
interface RawWhisper {
  id: string;
  coachName: string;
  coachAvatarUrl?: string | null;
  message: string;
  createdAt: any;
}

const relationshipLabel = (r?: string) => {
  // Only render a chip when the accepter has explicitly declared a
  // relationship. Missing OR the legacy 'parent' default is ambiguous, so
  // return empty and let the caller skip the chip entirely.
  if (!r || r === 'parent') return '';
  if (r === 'grandparent') return 'Grandparent';
  if (r === 'aunt_uncle') return 'Aunt/Uncle';
  if (r === 'guardian') return 'Guardian';
  if (r === 'sibling') return 'Sibling';
  return 'In circle';
};

const PlayerCircle: React.FC = () => {
  const { userData } = useAuth();
  const { selectedTeamId, selectedTeam } = useTeam();
  const { getPlayersByTeam } = useFirestore();

  const isAdultTeam = (selectedTeam as any)?.audienceType === 'adult';

  const [players, setPlayers] = useState<Player[]>([]);
  const [loadingPlayers, setLoadingPlayers] = useState(true);
  const [activePlayerId, setActivePlayerId] = useState<string | null>(null);

  // Load all team players once, then pick out linked kids for the viewer.
  useEffect(() => {
    if (!selectedTeamId || !userData?.uid) { setLoadingPlayers(false); return; }
    let cancelled = false;
    setLoadingPlayers(true);
    (async () => {
      try {
        const rows = await getPlayersByTeam(selectedTeamId);
        if (cancelled) return;
        setPlayers(rows as any[]);
      } catch (err) {
        console.warn('[circle] player load failed', err);
      } finally {
        if (!cancelled) setLoadingPlayers(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedTeamId, userData?.uid, getPlayersByTeam]);

  const myKids: Player[] = useMemo(() => {
    if (!userData?.uid) return [];
    return players.filter((p: any) => Array.isArray(p.parentIds) && p.parentIds.includes(userData.uid));
  }, [players, userData?.uid]);

  useEffect(() => {
    if (!activePlayerId && myKids.length > 0) {
      setActivePlayerId(myKids[0].id);
    } else if (activePlayerId && !myKids.find(k => k.id === activePlayerId) && myKids.length > 0) {
      setActivePlayerId(myKids[0].id);
    }
  }, [myKids, activePlayerId]);

  const activePlayer = useMemo(
    () => myKids.find(k => k.id === activePlayerId) || null,
    [myKids, activePlayerId],
  );

  // ── Circle members (live) ─────────────────────────────────────
  const [members, setMembers] = useState<CircleMember[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(false);
  useEffect(() => {
    if (!activePlayer || !userData?.uid) { setMembers([]); return; }
    const parentIds: string[] = Array.isArray((activePlayer as any).parentIds) ? (activePlayer as any).parentIds : [];
    if (parentIds.length === 0) { setMembers([]); return; }
    let cancelled = false;
    setLoadingMembers(true);
    (async () => {
      try {
        // Firestore `in` maxes at 30; batch just in case.
        const rows: CircleMember[] = [];
        for (let i = 0; i < parentIds.length; i += 30) {
          const chunk = parentIds.slice(i, i + 30);
          const snap = await getDocs(query(collection(db, 'users'), where(documentId(), 'in', chunk)));
          snap.forEach(d => {
            const u: any = d.data();
            rows.push({
              uid: d.id,
              name: (u?.name || u?.displayName || '').trim() || 'Family member',
              photoURL: u?.photoURL || u?.profilePhotoUrl || undefined,
              isViewer: d.id === userData.uid,
              relationship: u?.relationship,
            });
          });
        }
        if (!cancelled) {
          rows.sort((a, b) => (a.isViewer === b.isViewer ? a.name.localeCompare(b.name) : a.isViewer ? -1 : 1));
          setMembers(rows);
        }
      } catch (err) {
        console.warn('[circle] members load failed', err);
      } finally {
        if (!cancelled) setLoadingMembers(false);
      }
    })();
    return () => { cancelled = true; };
  }, [activePlayer, userData?.uid]);

  // ── Kudos + Whispers + XP notes + Badges + POTM comments ──────
  const [kudosList, setKudosList] = useState<RawKudos[]>([]);
  const [whispers, setWhispers] = useState<RawWhisper[]>([]);
  const [xpEvents, setXpEvents] = useState<any[]>([]);
  const [potmVotes, setPotmVotes] = useState<Array<{ voting: any; playerVotes: Array<{ voterName: string; reason?: string }> }>>([]);
  useEffect(() => {
    if (!activePlayer) { setKudosList([]); setWhispers([]); setXpEvents([]); setPotmVotes([]); return; }
    const playerId = activePlayer.id;
    let unsubs: Array<() => void> = [];
    // Kudos (live)
    unsubs.push(onSnapshot(
      query(collection(db, 'kudos'), where('playerId', '==', playerId), orderBy('createdAt', 'desc')),
      (snap) => {
        const rows: RawKudos[] = snap.docs.map(d => {
          const v: any = d.data();
          return {
            id: d.id,
            senderUid: v.senderUid || '',
            senderName: v.senderName || 'A Circle member',
            senderAvatarUrl: v.senderAvatarUrl || null,
            note: String(v.note || ''),
            createdAt: v.createdAt?.toDate?.() || (v.createdAt instanceof Date ? v.createdAt : new Date(v.createdAt || Date.now())),
            xpAwarded: v.xpAwarded,
          };
        });
        setKudosList(rows);
      },
      err => console.warn('[circle] kudos snapshot failed', err),
    ));
    // Whispers (one-shot — read rule allows parents in circle)
    (async () => {
      try {
        const snap = await getDocs(query(
          collection(db, 'parent_whispers'),
          where('playerId', '==', playerId),
          orderBy('createdAt', 'desc'),
        ));
        // Same kind filter as PlayerProfile: parent_whispers is a mixed
        // bag (dev-plan did_it/coach_verify, level_up broadcasts, real
        // whispers). Circle only wants coach whispers + recognitions +
        // legacy no-kind docs. Client-side filter avoids a new index.
        const whisperDocs = snap.docs.filter(d => {
          const k = (d.data() as any).kind;
          return k === 'whisper' || k === 'recognition' || k == null;
        });
        setWhispers(whisperDocs.map(d => {
          const v: any = d.data();
          return {
            id: d.id,
            coachName: v.coachName || 'Coach',
            coachAvatarUrl: v.coachAvatarUrl || null,
            message: String(v.message || ''),
            createdAt: v.createdAt?.toDate?.() || (v.createdAt instanceof Date ? v.createdAt : new Date(v.createdAt || Date.now())),
          };
        }));
      } catch (err) {
        // Silently skip if rules deny — Circle members may not always be allowed
        console.warn('[circle] whispers load skipped', err);
      }
    })();
    // XP events (one-shot, capped)
    (async () => {
      try {
        const snap = await getDocs(query(
          collection(db, 'player_xp_events'),
          where('playerId', '==', playerId),
          orderBy('createdAt', 'desc'),
        ));
        setXpEvents(snap.docs.slice(0, 40).map(d => {
          const v: any = d.data();
          return {
            id: d.id,
            xp: Number(v.xp) || 0,
            source: v.source || 'backfill',
            note: v.note || null,
            awardedByName: v.awardedByName || null,
            awardedBy: v.awardedBy || null,
            createdAt: v.createdAt?.toDate?.() || (v.createdAt instanceof Date ? v.createdAt : new Date(v.createdAt || Date.now())),
          };
        }));
      } catch (err) {
        console.warn('[circle] xp events load skipped', err);
      }
    })();
    // POTM votings — read all, filter to this team, extract this player's votes with reasons.
    (async () => {
      try {
        const snap = await getDocs(query(
          collection(db, 'match_votings'),
          where('teamId', '==', selectedTeamId || ''),
        ));
        const out: Array<{ voting: any; playerVotes: Array<{ voterName: string; reason?: string }> }> = [];
        snap.forEach(d => {
          const v: any = { id: d.id, ...d.data() };
          const votes: any[] = Array.isArray(v.votes) ? v.votes : [];
          const forThis = votes.filter(x => x?.playerId === playerId && (x?.reason || '').trim());
          if (forThis.length > 0) {
            out.push({
              voting: v,
              playerVotes: forThis.map(x => ({ voterName: x.voterName || 'A voter', reason: x.reason })),
            });
          }
        });
        setPotmVotes(out);
      } catch (err) {
        console.warn('[circle] potm votes load skipped', err);
      }
    })();
    return () => { unsubs.forEach(u => u()); };
  }, [activePlayer, selectedTeamId]);

  const shouts = useMemo(() => {
    if (!activePlayer) return [];
    return buildSidelineShouts({
      player: activePlayer,
      kudosList,
      whispers,
      xpEvents,
      potmVotes,
    });
  }, [activePlayer, kudosList, whispers, xpEvents, potmVotes]);

  // ── Invite + Kudos modals ─────────────────────────────────────
  const [generating, setGenerating] = useState(false);
  const [activeInvite, setActiveInvite] = useState<Invite | null>(null);
  const [showKudos, setShowKudos] = useState(false);
  // Kudos gate — 2026-07-16: any Circle member can cheer, except the
  // player themselves (adult-player self-praise guard). See PlayerProfile
  // for the full rationale.
  const canGiveKudos = !!userData
    && !!activePlayer
    && Array.isArray((activePlayer as any)?.parentIds)
    && (activePlayer as any).parentIds.includes(userData.uid)
    && (userData as any)?.selfPlayerId !== activePlayer.id;

  const handleInvite = async () => {
    if (!userData || !activePlayer || !selectedTeamId || generating) return;
    setGenerating(true);
    try {
      const invite = await createPlayerInvite({
        teamId: selectedTeamId,
        playerId: activePlayer.id,
        createdBy: userData.uid,
      });
      setActiveInvite(invite);
    } catch (err: any) {
      console.error('[circle] invite failed', err);
      alert(err?.message || 'Could not generate invite. Try again.');
    } finally {
      setGenerating(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────
  if (isAdultTeam) {
    return (
      <div className="min-h-screen bg-surface-base">
        <Header title="Circle" subtitle="Circle applies to youth teams. Adults use the Team Wall for the same." />
        <div className="max-w-3xl mx-auto px-4 py-10 text-center">
          <p className="text-ink-primary/70">This team is set as adult. Circle isn&apos;t used here. Head back to the Team Wall for the same crew energy.</p>
          <Link to="/wall" className="mt-4 inline-block text-brand-primary-soft font-bold hover:text-brand-primary">← Team Wall</Link>
        </div>
      </div>
    );
  }

  if (loadingPlayers) {
    return (
      <div className="min-h-screen bg-surface-base">
        <Header title="Circle" subtitle="Loading your family circle." />
      </div>
    );
  }

  if (myKids.length === 0) {
    return (
      <div className="min-h-screen bg-surface-base">
        <Header title="Circle" subtitle="Nobody in your family is on this team yet." />
        <div className="max-w-3xl mx-auto px-4 py-10 text-center space-y-3">
          <p className="text-ink-primary/70">Once your player is on the roster, their Circle lives here. Grandparents, aunts, uncles, guardians &mdash; anyone who wants to see the wins.</p>
          <Link to="/dashboard" className="text-brand-primary-soft font-bold hover:text-brand-primary">← Home</Link>
        </div>
      </div>
    );
  }

  const parentIds: string[] = Array.isArray((activePlayer as any)?.parentIds) ? (activePlayer as any).parentIds : [];
  const kidFirst = activePlayer?.name?.split(' ')[0] || 'this player';

  return (
    <div className="min-h-screen bg-surface-base">
      <Header title="Circle" subtitle="Everyone who cheers for your player, in one place." />

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-5 space-y-5">

        {/* Kid picker — only shown when the viewer has multiple linked kids */}
        {myKids.length > 1 && (
          <div className="flex flex-wrap gap-2">
            {myKids.map(k => {
              const active = k.id === activePlayerId;
              return (
                <button
                  key={k.id}
                  type="button"
                  onClick={() => setActivePlayerId(k.id)}
                  className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-bold transition ${
                    active
                      ? 'bg-ink-primary text-surface-base'
                      : 'bg-line-default/[0.08] text-ink-primary/70 hover:bg-line-default/[0.14]'
                  }`}
                >
                  {(k as any).photoUrl ? (
                    <img src={(k as any).photoUrl} alt="" className="w-5 h-5 rounded-full object-cover" />
                  ) : (
                    <span className={`w-5 h-5 rounded-full inline-flex items-center justify-center text-[10px] font-black ${
                      active ? 'bg-surface-base/20 text-surface-base' : 'bg-brand-primary/15 text-brand-primary'
                    }`}>
                      {(k.name || '?').charAt(0)}
                    </span>
                  )}
                  <span>{k.name.split(' ')[0]}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Kid hero — the room this Circle sits in */}
        {activePlayer && (
          <section className="rounded-2xl bg-line-default/[0.04] ring-1 ring-line-default/10 p-5 flex items-center gap-4">
            {(activePlayer as any).photoUrl ? (
              <img src={(activePlayer as any).photoUrl} alt="" className="w-16 h-16 rounded-full object-cover ring-1 ring-line-default/20" />
            ) : (
              <div className="w-16 h-16 rounded-full bg-brand-primary/15 flex items-center justify-center text-brand-primary text-2xl font-black ring-1 ring-brand-primary/25">
                {(activePlayer.name || '?').charAt(0)}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-black uppercase tracking-widest text-brand-primary-soft">Player Circle</p>
              <h1 className="text-xl sm:text-2xl font-black text-ink-primary leading-tight">{activePlayer.name}</h1>
              <p className="text-xs text-ink-primary/60 mt-0.5">
                {(activePlayer as any).jerseyNumber != null ? `#${(activePlayer as any).jerseyNumber} · ` : ''}
                {selectedTeam?.name || 'This team'}
              </p>
            </div>
            <Link
              to={`/player/${activePlayer.id}`}
              className="hidden sm:inline-flex items-center gap-1 text-[11px] font-black uppercase tracking-widest text-brand-primary-soft hover:text-brand-primary transition px-3 py-2 rounded-full hover:bg-line-default/[0.06]"
            >
              Profile →
            </Link>
          </section>
        )}

        {/* Circle members */}
        <section className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/10 p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[11px] font-black uppercase tracking-widest text-ink-primary/70">
              In the Circle · {parentIds.length}
            </h2>
            <button
              type="button"
              onClick={handleInvite}
              disabled={generating}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-black uppercase tracking-widest bg-brand-primary text-white hover:brightness-110 transition disabled:opacity-60"
            >
              {generating ? 'Working…' : 'Add to circle'}
            </button>
          </div>

          {loadingMembers ? (
            <p className="text-sm text-ink-primary/50">Loading…</p>
          ) : members.length === 0 ? (
            <div className="text-center py-6">
              <p className="text-sm text-ink-primary/70 mb-3">Nobody in the Circle yet.</p>
              <p className="text-xs text-ink-primary/50 max-w-sm mx-auto leading-relaxed">
                Tap <b>Add to circle</b> to share a private invite. Grandparents, aunts, uncles, guardians &mdash; anyone you want to see {kidFirst}&rsquo;s wins.
              </p>
            </div>
          ) : (
            <ul className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {members.map(m => (
                <li key={m.uid} className="flex items-center gap-3 p-2 rounded-xl bg-line-default/[0.04] ring-1 ring-line-default/8">
                  {m.photoURL ? (
                    <img src={m.photoURL} alt="" className="w-10 h-10 rounded-full object-cover" />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-brand-primary/15 text-brand-primary flex items-center justify-center font-black text-sm">
                      {(m.name || '?').charAt(0)}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-[13.5px] font-bold text-ink-primary truncate">
                      {m.isViewer ? `You (${m.name.split(' ')[0]})` : m.name}
                    </p>
                    {relationshipLabel(m.relationship) && (
                      <p className="text-[10.5px] uppercase tracking-widest text-ink-primary/50 font-black">
                        {relationshipLabel(m.relationship)}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Kudos composer entry — any Circle member except the player themselves */}
        {canGiveKudos && (
          <section className="rounded-2xl bg-brand-primary/[0.06] ring-1 ring-brand-primary/20 p-5">
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-brand-primary/15 text-brand-primary">
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2l2.39 4.84L19.8 7.6l-3.9 3.8.92 5.36L12 14.27 7.18 16.76 8.1 11.4 4.2 7.6l5.41-.76L12 2z" /></svg>
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-bold text-ink-primary">Give {kidFirst} some Kudos.</p>
                <p className="text-[11.5px] text-ink-primary/60 leading-snug">A short note about something you noticed. Coach can turn it into XP.</p>
              </div>
              <button
                type="button"
                onClick={() => setShowKudos(true)}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-full text-[11px] font-black uppercase tracking-widest bg-brand-primary text-white hover:brightness-110 transition"
              >
                Kudos
              </button>
            </div>
          </section>
        )}

        {/* Sideline Shouts feed — the room's activity */}
        <section className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/10 overflow-hidden">
          <header className="flex items-center justify-between px-5 pt-4 pb-2">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-brand-primary/15 text-brand-primary-soft">
                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2l2.39 4.84L19.8 7.6l-3.9 3.8.92 5.36L12 14.27 7.18 16.76 8.1 11.4 4.2 7.6l5.41-.76L12 2z" /></svg>
              </span>
              <span className="text-[10px] font-black uppercase tracking-widest text-brand-primary-soft">Sideline Shouts</span>
            </div>
            {activePlayer && (
              <Link
                to={`/player/${activePlayer.id}?tab=whispers`}
                className="text-[11px] font-black uppercase tracking-widest text-brand-primary-soft hover:text-brand-primary transition px-2 py-1 rounded-md hover:bg-line-default/[0.06]"
              >
                See all →
              </Link>
            )}
          </header>
          {shouts.length === 0 ? (
            <p className="px-5 py-6 text-sm text-ink-primary/60 text-center">
              No shouts yet. Kudos from the Circle and coach whispers show up here as they land.
            </p>
          ) : (
            <ul className="divide-y divide-line-default/8">
              {shouts.slice(0, 12).map(s => (
                <li key={s.id} className={`px-5 py-3.5 flex items-start gap-3 border-l-4 ${shoutAccentClass(s.type)}`}>
                  <div className="flex-shrink-0">
                    {s.type === 'badge' && s.badgeImage ? (
                      <img src={s.badgeImage} className="w-8 h-8 object-contain" alt="" />
                    ) : s.fromAvatarUrl ? (
                      <img src={s.fromAvatarUrl} alt="" className="w-8 h-8 rounded-full object-cover" />
                    ) : (
                      <div className="w-8 h-8 rounded-full bg-brand-primary/15 text-brand-primary flex items-center justify-center font-black text-xs">
                        {(s.fromName || '?').charAt(0)}
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[13px] font-bold text-ink-primary">{s.fromName}</span>
                      <span className="text-[10px] font-black uppercase tracking-widest text-ink-primary/40">
                        {SHOUT_TYPE_LABEL[s.type]}
                      </span>
                    </div>
                    <p className="text-[13.5px] text-ink-primary/85 leading-snug mt-0.5">
                      {s.body}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* Modals */}
      {activePlayer && (
        <InviteShareModal
          invite={activeInvite}
          open={!!activeInvite}
          playerName={activePlayer.name}
          onClose={() => setActiveInvite(null)}
        />
      )}
      {showKudos && activePlayer && (
        <KudosComposerModal
          isOpen={showKudos}
          onClose={() => setShowKudos(false)}
          player={activePlayer}
        />
      )}
    </div>
  );
};

export default PlayerCircle;

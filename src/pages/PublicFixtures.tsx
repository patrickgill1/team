import React, { useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';

// Public-facing fixtures + roster page for a team. Anyone with the
// link can view — no auth. Data comes from the worker's
// /public/team-fixtures/{teamId} endpoint, which enforces the
// team.publicFixturesEnabled gate.
//
// Adult / semi-pro teams flip this on so fans and scouts can see the
// upcoming schedule + roster. Youth teams that don't want their
// weekly game venues world-readable leave it off (default).

interface FixturesPayload {
  v: number;
  team: {
    id: string;
    name: string;
    logoUrl?: string | null;
    homeKitColor?: string | null;
    awayKitColor?: string | null;
    audienceType?: 'youth' | 'adult';
    season?: string | null;
    league?: string | null;
    homeField?: string | null;
  };
  upcoming: Array<{
    id: string;
    title: string;
    opponent: string;
    homeAway: 'home' | 'away' | null;
    location: string;
    fieldNumber: string;
    date: string;
    result: string;
  }>;
  recent: Array<{
    id: string;
    title: string;
    opponent: string;
    homeAway: 'home' | 'away' | null;
    location: string;
    fieldNumber: string;
    date: string;
    result: string;
  }>;
  roster: Array<{
    id: string;
    name: string;
    jerseyNumber: number | null;
    position: string | null;
    profilePhotoUrl: string | null;
    preferredFoot: 'Left' | 'Right' | 'Both' | null;
    secondaryPosition: string | null;
    heightCm: number | null;
    pastClubs: string[] | null;
  }>;
}

const workerOrigin = () => (process.env.REACT_APP_NOTIFY_URL || '').replace(/\/$/, '');

const fmtDate = (iso: string): { day: string; time: string } => {
  const d = new Date(iso);
  const day = d.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    timeZone: 'America/Denver',
  });
  const time = d.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: 'America/Denver',
  });
  return { day, time };
};

const PublicFixtures: React.FC = () => {
  const { teamId } = useParams<{ teamId: string }>();
  const [data, setData] = useState<FixturesPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'fixtures' | 'roster'>('fixtures');

  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${workerOrigin()}/public/team-fixtures/${encodeURIComponent(teamId)}`);
        const j: any = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok || !j?.v) {
          setError(j?.error || 'not-found');
          return;
        }
        setData(j as FixturesPayload);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'load-failed');
      }
    })();
    return () => { cancelled = true; };
  }, [teamId]);

  const kitDots = useMemo(() => {
    if (!data) return null;
    const home = data.team.homeKitColor;
    const away = data.team.awayKitColor;
    if (!home && !away) return null;
    return (
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest font-black text-ink-primary/60">
        {home && (
          <span className="inline-flex items-center gap-1">
            <span className="inline-block w-2.5 h-2.5 rounded-full ring-1 ring-line-default/25" style={{ backgroundColor: 'currentColor' }} />
            Home {home}
          </span>
        )}
        {away && (
          <span className="inline-flex items-center gap-1">
            <span className="inline-block w-2.5 h-2.5 rounded-full ring-1 ring-line-default/25" style={{ backgroundColor: 'currentColor' }} />
            Away {away}
          </span>
        )}
      </div>
    );
  }, [data]);

  if (error) {
    return (
      <div className="min-h-screen bg-surface-base flex flex-col items-center justify-center px-6 text-center">
        <div className="max-w-md">
          <p className="text-[10px] font-black tracking-widest uppercase text-ink-primary/45 mb-2">Team fixtures</p>
          <h1 className="text-2xl font-black text-ink-primary mb-2">Not available</h1>
          <p className="text-sm text-ink-primary/60">
            This team hasn't turned on a public fixture page, or the link is invalid.
          </p>
          <p className="text-xs text-ink-primary/45 mt-4">
            <Link to="/" className="underline">GoalKickr</Link>
          </p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen bg-surface-base flex items-center justify-center">
        <p className="text-sm text-ink-primary/50">Loading fixtures…</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface-base">
      {/* Header */}
      <header className="bg-surface-elevated border-b border-line-default/10">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 flex items-center gap-4">
          {data.team.logoUrl ? (
            <img src={data.team.logoUrl} alt="" className="w-16 h-16 rounded-2xl object-cover ring-1 ring-line-default/15" />
          ) : (
            <div className="w-16 h-16 rounded-2xl bg-brand-primary/20 flex items-center justify-center ring-1 ring-brand-primary/40">
              <span className="text-2xl font-black text-brand-primary-soft">
                {data.team.name.charAt(0).toUpperCase()}
              </span>
            </div>
          )}
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-black tracking-widest uppercase text-brand-primary-soft mb-1">
              {data.team.audienceType === 'adult' ? 'Semi-pro / Adult team' : 'Team'}
            </p>
            <h1 className="text-2xl sm:text-3xl font-black text-ink-primary leading-tight truncate">{data.team.name}</h1>
            <p className="text-xs text-ink-primary/55 mt-1 truncate">
              {[data.team.league, data.team.season, data.team.homeField].filter(Boolean).join(' · ') || 'Fixtures + roster'}
            </p>
            {kitDots && <div className="mt-2">{kitDots}</div>}
          </div>
        </div>
        <div className="max-w-4xl mx-auto px-4 sm:px-6 pb-3">
          <div className="inline-flex bg-line-default/[0.08] ring-1 ring-line-default/10 rounded-full p-0.5">
            {(['fixtures', 'roster'] as const).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-4 py-1.5 text-xs font-bold uppercase tracking-wider rounded-full transition ${
                  tab === t ? 'bg-brand-primary text-white shadow-sm' : 'text-ink-primary/70 hover:text-ink-primary'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-6">
        {tab === 'fixtures' ? (
          <div className="space-y-8">
            <section>
              <h2 className="text-[11px] font-black tracking-widest uppercase text-ink-primary/60 mb-3">Upcoming</h2>
              {data.upcoming.length === 0 ? (
                <div className="p-8 rounded-2xl bg-surface-elevated ring-1 ring-line-default/10 text-center">
                  <p className="text-sm text-ink-primary/60">No games scheduled.</p>
                </div>
              ) : (
                <ul className="space-y-2">
                  {data.upcoming.map(g => {
                    const { day, time } = fmtDate(g.date);
                    return (
                      <li key={g.id} className="p-4 rounded-2xl bg-surface-elevated ring-1 ring-line-default/10">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <p className="text-xs uppercase tracking-widest font-black text-brand-primary-soft mb-1">
                              {g.homeAway === 'home' ? 'Home' : g.homeAway === 'away' ? 'Away' : 'Match'}
                            </p>
                            <p className="text-base font-bold text-ink-primary truncate">
                              {g.opponent ? `vs ${g.opponent}` : g.title}
                            </p>
                            {g.location && (
                              <p className="text-xs text-ink-primary/55 mt-0.5 truncate">
                                {g.location}{g.fieldNumber ? ` · Field ${g.fieldNumber}` : ''}
                              </p>
                            )}
                          </div>
                          <div className="text-right flex-shrink-0">
                            <p className="text-xs uppercase tracking-wider font-bold text-ink-primary/55">{day}</p>
                            <p className="text-lg font-black text-ink-primary tabular-nums">{time}</p>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {data.recent.length > 0 && (
              <section>
                <h2 className="text-[11px] font-black tracking-widest uppercase text-ink-primary/60 mb-3">Recent results</h2>
                <ul className="space-y-2">
                  {data.recent.map(g => {
                    const { day } = fmtDate(g.date);
                    return (
                      <li key={g.id} className="p-4 rounded-2xl bg-surface-elevated ring-1 ring-line-default/10">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <p className="text-xs uppercase tracking-widest font-black text-ink-primary/55 mb-1">
                              {g.homeAway === 'home' ? 'Home' : g.homeAway === 'away' ? 'Away' : 'Match'}
                              <span className="text-ink-primary/30 mx-1">·</span>
                              <span className="normal-case tracking-normal font-bold text-ink-primary/55">{day}</span>
                            </p>
                            <p className="text-base font-bold text-ink-primary truncate">
                              {g.opponent ? `vs ${g.opponent}` : g.title}
                            </p>
                          </div>
                          {g.result && (
                            <p className="text-lg font-black tabular-nums text-ink-primary flex-shrink-0">{g.result}</p>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
          </div>
        ) : (
          <section>
            <h2 className="text-[11px] font-black tracking-widest uppercase text-ink-primary/60 mb-3">Squad</h2>
            {data.roster.length === 0 ? (
              <div className="p-8 rounded-2xl bg-surface-elevated ring-1 ring-line-default/10 text-center">
                <p className="text-sm text-ink-primary/60">No players are sharing publicly yet.</p>
                <p className="text-xs text-ink-primary/40 mt-1">Each player controls what appears here.</p>
              </div>
            ) : (
              <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {data.roster.map(p => (
                  <li key={p.id} className="p-4 rounded-2xl bg-surface-elevated ring-1 ring-line-default/10 flex items-center gap-3">
                    {p.profilePhotoUrl ? (
                      <img src={p.profilePhotoUrl} alt="" className="w-14 h-14 rounded-full object-cover ring-1 ring-line-default/15" />
                    ) : (
                      <div className="w-14 h-14 rounded-full bg-line-default/10 flex items-center justify-center">
                        <span className="text-lg font-black text-ink-primary/60">
                          {p.jerseyNumber != null ? `#${p.jerseyNumber}` : p.name.charAt(0)}
                        </span>
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-ink-primary truncate">{p.name}</p>
                      <p className="text-[10px] uppercase tracking-widest font-black text-ink-primary/50 truncate">
                        {[
                          p.jerseyNumber != null ? `#${p.jerseyNumber}` : null,
                          p.position,
                          p.secondaryPosition && p.secondaryPosition !== p.position ? p.secondaryPosition : null,
                        ].filter(Boolean).join(' · ')}
                      </p>
                      <p className="text-[10px] text-ink-primary/45 mt-0.5 truncate">
                        {[
                          p.preferredFoot ? `${p.preferredFoot} footed` : null,
                          p.heightCm ? `${p.heightCm} cm` : null,
                          p.pastClubs && p.pastClubs.length > 0 ? `Ex: ${p.pastClubs.join(', ')}` : null,
                        ].filter(Boolean).join(' · ') || ' '}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </main>

      <footer className="max-w-4xl mx-auto px-4 sm:px-6 py-6 mt-4 border-t border-line-default/10 text-center">
        <p className="text-[10px] uppercase tracking-widest font-black text-ink-primary/40">
          Powered by <Link to="/" className="text-brand-primary-soft hover:text-brand-primary">GoalKickr</Link>
        </p>
      </footer>
    </div>
  );
};

export default PublicFixtures;

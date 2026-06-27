import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useTeam } from '../contexts/TeamContext';
import { useFirestore } from '../hooks/useFirestore';
import { Drill } from '../types';
import { isCoach } from '../utils/helpers';
import { uploadToStream, streamIframeUrl, streamThumbnailUrl } from '../utils/streamUpload';
import {
  loadLibraryDrills, rateDrill, saveDrillFromLibrary, toggleShareToLibrary,
  isAutoHidden, isFeatured,
} from '../utils/drillLibrary';

const TOPICS: { value: Drill['topic']; label: string }[] = [
  { value: 'dribbling', label: 'Dribbling' },
  { value: 'passing', label: 'Passing' },
  { value: 'shooting', label: 'Shooting' },
  { value: 'first-touch', label: 'First touch' },
  { value: 'defending', label: 'Defending' },
  { value: 'goalkeeping', label: 'Goalkeeping' },
  { value: 'fitness', label: 'Fitness' },
  { value: 'agility', label: 'Agility' },
  { value: 'tactical', label: 'Tactical' },
  { value: 'other', label: 'Other' },
];

const AGE_BANDS: { value: Drill['ageBand']; label: string }[] = [
  { value: 'all', label: 'All ages' },
  { value: 'U6-U8', label: 'U6–U8' },
  { value: 'U9-U10', label: 'U9–U10' },
  { value: 'U11-U12', label: 'U11–U12' },
  { value: 'U13-U14', label: 'U13–U14' },
  { value: 'U15-U17', label: 'U15–U17' },
];

const Drills: React.FC = () => {
  const { userData } = useAuth();
  const { selectedTeamId } = useTeam();
  const { getDocuments, addDocument, updateDocument } = useFirestore();
  const allowed = userData ? isCoach(userData.role) : false;
  const [drills, setDrills] = useState<Drill[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterTopic, setFilterTopic] = useState<Drill['topic'] | 'all'>('all');
  const [filterAge, setFilterAge] = useState<Drill['ageBand'] | 'all'>('all');
  // Higher-level use-case split: team practice vs solo at-home work.
  // Drives the headline filter pill row above the topic / age dropdowns
  // so a coach building a Pathway sees "Extra Reps" content first.
  const [filterUseCase, setFilterUseCase] = useState<'all' | 'team' | 'solo'>('all');
  // Free-text search across title + focus + description. The single
  // biggest discovery win — beats filtering by topic when you know
  // the drill name but can't remember the topic tag.
  const [searchQuery, setSearchQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Drill | null>(null);

  // Tab + library state. The library tab pulls shareToLibrary==true
  // drills from across every club. Default-on per user pref
  // (browseDrillLibrary). When the user flips that pref off the
  // tab disappears entirely.
  const browseLibrary = (userData as any)?.browseDrillLibrary !== false;
  const [tab, setTab] = useState<'mine' | 'library'>('mine');
  const [libraryDrills, setLibraryDrills] = useState<Drill[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [librarySort, setLibrarySort] = useState<'top' | 'recent' | 'featured'>('top');
  const [saveTarget, setSaveTarget] = useState<{ drill: Drill; busy: boolean } | null>(null);

  const reload = async () => {
    if (!selectedTeamId) { setLoading(false); return; }
    try {
      setLoading(true);
      const all = await getDocuments('drills', []);
      const visible = (all as any[])
        .filter(d => d.isActive !== false)
        .filter(d => d.teamId === selectedTeamId || (userData && d.clubId && (userData as any).clubId === d.clubId))
        .map(d => ({
          ...d,
          createdAt: d.createdAt?.toDate ? d.createdAt.toDate() : new Date(d.createdAt || Date.now()),
        })) as Drill[];
      setDrills(visible);
    } catch (err) {
      console.warn('drills load failed', err);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void reload(); }, [selectedTeamId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pull the public catalog whenever the user switches to the Library
  // tab. Filtered in memory by the current topic / age / featured-only.
  useEffect(() => {
    if (tab !== 'library' || !userData) return;
    let cancelled = false;
    (async () => {
      setLibraryLoading(true);
      try {
        const rows = await loadLibraryDrills({
          topic: filterTopic === 'all' ? undefined : filterTopic,
          ageBand: filterAge === 'all' ? undefined : filterAge,
          featuredOnly: librarySort === 'featured',
          excludeCreatorUid: userData.uid,  // don't show my own drills back to me
        });
        if (cancelled) return;
        const sorted = rows.slice().sort((a, b) => {
          if (librarySort === 'recent') {
            const at = (a as any).sharedAt?.toDate?.()?.getTime?.() ?? 0;
            const bt = (b as any).sharedAt?.toDate?.()?.getTime?.() ?? 0;
            return bt - at;
          }
          // 'top' and 'featured' both prefer rating, then saves
          return (b.averageRating || 0) - (a.averageRating || 0)
            || (b.saveCount || 0) - (a.saveCount || 0);
        });
        setLibraryDrills(sorted);
      } catch (e) {
        console.warn('library load failed', e);
        setLibraryDrills([]);
      } finally {
        if (!cancelled) setLibraryLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [tab, filterTopic, filterAge, librarySort, userData]);

  const handleSaveFromLibrary = async (drill: Drill) => {
    if (!userData) return;
    setSaveTarget({ drill, busy: true });
    try {
      const target: { clubId?: string; teamId?: string } = {};
      const userClubId = (userData as any).clubIds?.[0] || (userData as any).clubId;
      if (userClubId) target.clubId = userClubId;
      else if (selectedTeamId) target.teamId = selectedTeamId;
      else throw new Error('No team or club to save into');
      await saveDrillFromLibrary({
        sourceDrillId: drill.id,
        sourceClubName: (drill as any).importedFromClubName,
        newOwnerUid: userData.uid,
        newOwnerName: userData.name || 'Coach',
        destination: target,
      });
      // Reload my drills so the new copy shows up.
      void reload();
      setSaveTarget(null);
      // Bump local saveCount so the UI updates without a full reload
      setLibraryDrills(prev => prev.map(d => d.id === drill.id ? { ...d, saveCount: (d.saveCount || 0) + 1 } : d));
    } catch (e: any) {
      setSaveTarget({ drill, busy: false });
      window.alert(e?.message || 'Save failed');
    }
  };

  const handleRate = async (drillId: string, stars: 1 | 2 | 3 | 4 | 5) => {
    if (!userData) return;
    try {
      await rateDrill(drillId, userData.uid, stars);
      // Local optimistic update: recompute avg in the rows
      setLibraryDrills(prev => prev.map(d => {
        if (d.id !== drillId) return d;
        const prevVote = d.ratedBy?.[userData.uid];
        let sum = d.ratingSum || 0;
        let count = d.ratingCount || 0;
        if (prevVote) sum -= prevVote;
        else count += 1;
        sum += stars;
        const avg = count > 0 ? sum / count : 0;
        return {
          ...d,
          ratingCount: count,
          ratingSum: sum,
          averageRating: avg,
          ratedBy: { ...(d.ratedBy || {}), [userData.uid]: stars },
        };
      }));
    } catch (e: any) {
      window.alert(e?.message || 'Rate failed');
    }
  };

  const visible = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return drills.filter(d => {
      if (filterTopic !== 'all' && d.topic !== filterTopic) return false;
      if (filterAge !== 'all' && d.ageBand !== filterAge && d.ageBand !== 'all') return false;
      // useCase filter: 'all' shows everything; 'team' shows team+both;
      // 'solo' shows solo+both. Drills with no useCase default to team
      // (the historical assumption) so legacy data still surfaces.
      const uc = d.useCase || 'team';
      if (filterUseCase === 'team' && uc === 'solo') return false;
      if (filterUseCase === 'solo' && uc === 'team') return false;
      if (q) {
        const hay = `${d.title || ''} ${d.focus || ''} ${d.description || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    }).sort((a, b) => (b.assignmentCount || 0) - (a.assignmentCount || 0) || (b.createdAt.getTime() - a.createdAt.getTime()));
  }, [drills, filterTopic, filterAge, filterUseCase, searchQuery]);

  if (!allowed) {
    return (
      <div className="min-h-screen bg-charcoal-950 flex items-center justify-center p-6 text-center">
        <div className="max-w-md">
          <p className="text-sm font-bold text-bone/85">Coach access only</p>
          <p className="text-xs text-bone/50 mt-1">Drills are coach-side. Parents see drills assigned via a player's plan.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-charcoal-950">
      {/* Tight one-line header. No breadcrumb (bottom nav handles
          movement), no marketing subtitle. Title left + primary action
          right is enough. */}
      <section className="bg-charcoal-900 px-4 sm:px-6 py-3 border-b border-white/5">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-3">
          <h1 className="text-lg sm:text-xl font-black text-white leading-tight">Training Ground</h1>
          <button
            onClick={() => { setEditing(null); setCreateOpen(true); }}
            className="px-4 py-2 rounded-lg bg-brand-primary hover:bg-brand-primary/90 text-white text-xs font-extrabold tracking-widest uppercase whitespace-nowrap shadow-sm"
          >
            + Add Drill
          </button>
        </div>
      </section>

      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 space-y-3">
        {/* Segmented control for the primary view toggle (My vs
            Library). Two equal halves so it's obviously a binary
            switch, not the same visual category as the sort/filter
            chips below. Sort options for Library live on their own
            row underneath so the two concerns don't fight for the
            same line. */}
        {browseLibrary && (
          <>
            <div className="inline-flex p-1 bg-charcoal-900 ring-1 ring-white/10 rounded-lg w-full">
              {([
                { k: 'mine' as const,    label: 'My drills' },
                { k: 'library' as const, label: 'Library' },
              ]).map(t => (
                <button
                  key={t.k}
                  onClick={() => setTab(t.k)}
                  className={`flex-1 px-3 py-1.5 rounded-md text-xs font-extrabold tracking-widest uppercase whitespace-nowrap transition ${
                    tab === t.k
                      ? 'bg-brand-primary text-white shadow-sm'
                      : 'text-bone/55 hover:text-bone'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {tab === 'library' && (
              <div className="flex items-center justify-end gap-3 text-[10px] font-extrabold tracking-widest uppercase">
                <span className="text-bone/40">Sort</span>
                {([
                  { k: 'top' as const,      label: 'Top' },
                  { k: 'featured' as const, label: 'Featured' },
                  { k: 'recent' as const,   label: 'Recent' },
                ]).map(s => (
                  <button
                    key={s.k}
                    onClick={() => setLibrarySort(s.k)}
                    className={`whitespace-nowrap transition ${
                      librarySort === s.k
                        ? 'text-brand-primary-soft'
                        : 'text-bone/45 hover:text-bone'
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {/* Search — the single biggest discovery win. */}
        <div className="relative">
          <svg className="absolute inset-y-0 left-3 my-auto w-4 h-4 text-bone/40" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by name or focus…"
            className="w-full bg-charcoal-900 text-bone placeholder:text-bone/40 border border-white/15 rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary/40"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute inset-y-0 right-2 my-auto w-6 h-6 rounded-full text-bone/40 hover:text-bone hover:bg-white/5 flex items-center justify-center"
              aria-label="Clear search"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          )}
        </div>

        {/* Use-case pill row — Team vs Extra Reps. Wrapping flex so it
            never scrolls sideways. */}
        <div className="flex flex-wrap gap-1.5">
          {([
            { k: 'all' as const,  label: 'All' },
            { k: 'team' as const, label: 'Team' },
            { k: 'solo' as const, label: 'Extra Reps' },
          ]).map(c => (
            <button
              key={c.k}
              type="button"
              onClick={() => setFilterUseCase(c.k)}
              className={`px-3 py-1.5 rounded-full text-[11px] font-extrabold tracking-widest uppercase transition ${
                filterUseCase === c.k
                  ? 'bg-brand-primary text-white shadow-sm'
                  : 'bg-charcoal-900 text-bone/55 ring-1 ring-white/10 hover:text-bone'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>

        {/* Topic + Age dropdowns — too many options for pill rows
            (10 topics, 6 age bands). Selects are the right control here. */}
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={filterTopic}
            onChange={(e) => setFilterTopic(e.target.value as any)}
            className="bg-charcoal-900 text-bone [color-scheme:dark] border border-white/15 rounded-lg px-3 py-2 text-sm"
          >
            <option value="all">All topics</option>
            {TOPICS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          <select
            value={filterAge as string}
            onChange={(e) => setFilterAge(e.target.value as any)}
            className="bg-charcoal-900 text-bone [color-scheme:dark] border border-white/15 rounded-lg px-3 py-2 text-sm"
          >
            {AGE_BANDS.map(a => <option key={a.value as string} value={a.value as string}>{a.label}</option>)}
          </select>
          <span className="ml-auto text-xs text-bone/50">
            {tab === 'library' ? libraryDrills.length : visible.length} drill{(tab === 'library' ? libraryDrills.length : visible.length) === 1 ? '' : 's'}
          </span>
        </div>

        {/* Library tab grid */}
        {tab === 'library' && (
          libraryLoading ? (
            <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 p-8 text-center text-sm text-bone/50">Loading library…</div>
          ) : libraryDrills.length === 0 ? (
            <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 p-10 text-center">
              <p className="text-sm font-bold text-bone/85">No shared drills match these filters.</p>
              <p className="text-xs text-bone/50 mt-1">Loosen the filters or be the first to share one — flip a drill in My drills.</p>
            </div>
          ) : (
            <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {libraryDrills.map(d => (
                <LibraryCard
                  key={d.id}
                  drill={d}
                  voterUid={userData?.uid}
                  voterName={userData?.name}
                  voterEmail={(userData as any)?.email}
                  onRate={(stars) => handleRate(d.id, stars)}
                  onSave={() => handleSaveFromLibrary(d)}
                  saving={!!(saveTarget && saveTarget.drill.id === d.id && saveTarget.busy)}
                />
              ))}
            </ul>
          )
        )}

        {/* My drills grid (existing) */}
        {tab === 'mine' && (loading ? (
          <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 p-8 text-center text-sm text-bone/50">Loading…</div>
        ) : visible.length === 0 ? (
          <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 p-10 text-center">
            <p className="text-sm font-bold text-bone/85">Library's empty.</p>
            <p className="text-xs text-bone/50 mt-1 mb-4">Build one yourself, or have AI draft one from a topic.</p>
            <button
              onClick={() => { setEditing(null); setCreateOpen(true); }}
              className="px-4 py-2 rounded-lg bg-brand-primary hover:bg-brand-primary/90 text-white text-xs font-extrabold tracking-widest uppercase shadow-sm"
            >
              + Add your first drill
            </button>
          </div>
        ) : (
          <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {visible.map(d => (
              <li key={d.id} className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 hover:ring-brand-primary-soft overflow-hidden transition-shadow hover:shadow-md flex flex-col">
                {/* Card body opens the editor — clickable surface for
                    reviewing / editing the drill. */}
                <button
                  type="button"
                  onClick={() => { setEditing(d); setCreateOpen(true); }}
                  className="w-full text-left flex-1"
                >
                  {d.streamUid && (
                    <div className="aspect-video w-full bg-white/15 relative">
                      <img
                        src={streamThumbnailUrl(d.streamUid, { height: 240 })}
                        alt=""
                        loading="lazy"
                        className="w-full h-full object-cover"
                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                      />
                      <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                        <span className="w-10 h-10 rounded-full bg-black/50 flex items-center justify-center">
                          <svg className="w-4 h-4 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                        </span>
                      </span>
                    </div>
                  )}
                  <div className="p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-[10px] font-extrabold tracking-widest uppercase text-brand-primary-soft bg-brand-primary/15 ring-1 ring-brand-primary-soft/30 px-1.5 py-0.5 rounded">
                      {TOPICS.find(t => t.value === d.topic)?.label || d.topic}
                    </span>
                    {d.useCase === 'solo' && (
                      <span className="text-[10px] font-extrabold tracking-widest uppercase text-amber-300 bg-amber-500/15 ring-1 ring-amber-400/30 px-1.5 py-0.5 rounded">Extra Reps</span>
                    )}
                    {d.source === 'ai' && (
                      <span className="text-[10px] font-extrabold tracking-widest uppercase text-violet-300 bg-violet-500/15 ring-1 ring-violet-200 px-1.5 py-0.5 rounded">AI</span>
                    )}
                    {d.ageBand && d.ageBand !== 'all' && (
                      <span className="text-[10px] font-bold text-bone/50 ml-auto">{d.ageBand}</span>
                    )}
                  </div>
                  <h3 className="text-base font-bold text-bone mb-1 line-clamp-2">{d.title}</h3>
                  {d.focus && <p className="text-xs text-bone/65 line-clamp-2">{d.focus}</p>}
                  <div className="mt-3 flex items-center gap-2 text-[11px] text-bone/50">
                    {d.durationMinutes != null && <span>{d.durationMinutes} min</span>}
                    {d.videoLinks && d.videoLinks.length > 0 && <span>· {d.videoLinks.length} video{d.videoLinks.length === 1 ? '' : 's'}</span>}
                    {d.streamUid && <span>· video</span>}
                    {d.assignmentCount != null && d.assignmentCount > 0 && <span>· assigned {d.assignmentCount}×</span>}
                  </div>
                  </div>
                </button>
                {/* Footer action — send the drill to a kid's Pathway as
                    a goal. PlayerDevelopment reads ?seedDrill=<id> on
                    mount, fetches the drill, opens its new-plan modal
                    with the drill pre-seeded as the first goal. */}
                <div className="px-4 pb-4">
                  <Link
                    to={`/development?seedDrill=${d.id}`}
                    className="block w-full text-center px-3 py-2 rounded-lg bg-white/5 hover:bg-brand-primary/20 ring-1 ring-white/10 hover:ring-brand-primary-soft/40 text-[11px] font-extrabold tracking-widest uppercase text-bone/85 hover:text-brand-primary-soft transition"
                  >
                    Set a Challenge
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        ))}
      </div>

      {createOpen && (
        <DrillEditor
          drill={editing}
          onClose={() => { setCreateOpen(false); setEditing(null); }}
          onSave={async (payload, isNew) => {
            try {
              if (isNew) {
                await addDocument('drills', {
                  ...payload,
                  teamId: selectedTeamId,
                  createdBy: userData?.uid || null,
                  createdByName: userData?.name || 'Coach',
                  createdAt: new Date(),
                  isActive: true,
                  assignmentCount: 0,
                });
              } else if (editing) {
                await updateDocument('drills', editing.id, { ...payload, updatedAt: new Date() });
              }
              setCreateOpen(false);
              setEditing(null);
              await reload();
            } catch (err) {
              console.error('save drill failed', err);
              alert('Save failed — try again.');
            }
          }}
        />
      )}
    </div>
  );
};

interface DrillEditorProps {
  drill: Drill | null;
  onClose: () => void;
  onSave: (payload: Partial<Drill>, isNew: boolean) => Promise<void>;
}

const DrillEditor: React.FC<DrillEditorProps> = ({ drill, onClose, onSave }) => {
  const [title, setTitle] = useState(drill?.title || '');
  const [topic, setTopic] = useState<Drill['topic']>(drill?.topic || 'dribbling');
  const [category, setCategory] = useState<Drill['category']>(drill?.category || 'technical');
  const [ageBand, setAgeBand] = useState<Drill['ageBand']>(drill?.ageBand || 'all');
  const [useCase, setUseCase] = useState<Drill['useCase']>(drill?.useCase || 'team');
  const [description, setDescription] = useState(drill?.description || '');
  const [setup, setSetup] = useState(drill?.setup || '');
  const [instructions, setInstructions] = useState(drill?.instructions || '');
  const [focus, setFocus] = useState(drill?.focus || '');
  const [durationMinutes, setDurationMinutes] = useState<number | ''>(drill?.durationMinutes ?? '');
  const [videoUrl, setVideoUrl] = useState('');
  const [aiPrompt, setAiPrompt] = useState('');
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  // Coach-uploaded reference video (e.g., a TikTok exported to camera
  // roll). Lives on Cloudflare Stream — same path Player Media uses.
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [uploadPct, setUploadPct] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [stagedStreamUid, setStagedStreamUid] = useState<string | null>(null);

  const isNew = !drill;

  const runAI = async () => {
    if (!aiPrompt.trim()) {
      alert('Type what you want a drill for, e.g. "first touch under pressure, 10 min, U10".');
      return;
    }
    setGenerating(true);
    try {
      const NOTIFY_URL = process.env.REACT_APP_NOTIFY_URL || '';
      const NOTIFY_SECRET = process.env.REACT_APP_NOTIFY_SECRET || '';
      if (!NOTIFY_URL || !NOTIFY_SECRET) throw new Error('Notify worker not configured');
      const res = await fetch(`${NOTIFY_URL}/generate-drill`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${NOTIFY_SECRET}` },
        body: JSON.stringify({ prompt: aiPrompt, topic, ageBand }),
      });
      if (!res.ok) throw new Error(`Generator returned ${res.status}`);
      const data: any = await res.json();
      if (data.title) setTitle(data.title);
      if (data.setup) setSetup(data.setup);
      if (data.instructions) setInstructions(data.instructions);
      if (data.focus) setFocus(data.focus);
      if (data.durationMinutes) setDurationMinutes(data.durationMinutes);
      if (data.topic) setTopic(data.topic);
      if (data.category) setCategory(data.category);
    } catch (err: any) {
      alert(err?.message || 'Generation failed. Check the worker logs.');
    } finally {
      setGenerating(false);
    }
  };

  const handleUploadFile = async (file: File) => {
    if (!file) return;
    setPendingFile(file);
    setUploading(true);
    setUploadPct(0);
    try {
      const result = await uploadToStream(
        file,
        { name: title || file.name },
        (pct) => setUploadPct(pct)
      );
      setStagedStreamUid(result.uid);
    } catch (err) {
      console.error('Stream upload failed', err);
      alert('Upload failed — try again.');
      setPendingFile(null);
    } finally {
      setUploading(false);
    }
  };

  const handleSave = async () => {
    if (!title.trim()) { alert('Drill needs a title.'); return; }
    setSaving(true);
    const payload: Partial<Drill> = {
      title: title.trim(),
      topic,
      category,
      ageBand,
      useCase,
      description: description.trim() || undefined,
      setup: setup.trim() || undefined,
      instructions: instructions.trim() || undefined,
      focus: focus.trim() || undefined,
      durationMinutes: typeof durationMinutes === 'number' ? durationMinutes : undefined,
      source: drill?.source || (aiPrompt ? 'ai' : 'manual'),
      aiPrompt: aiPrompt || drill?.aiPrompt,
      videoLinks: drill?.videoLinks || [],
    };
    // Append a new video link if the coach pasted one.
    if (videoUrl.trim()) {
      const links = [...(payload.videoLinks || []), {
        id: `vl_${Date.now()}`,
        url: videoUrl.trim(),
        addedAt: new Date(),
      } as any];
      payload.videoLinks = links;
    }
    // Attach freshly uploaded Stream video if there is one.
    if (stagedStreamUid) {
      payload.streamUid = stagedStreamUid;
      payload.streamReady = true;
    }
    await onSave(payload, isNew);
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-charcoal-900 w-full max-w-2xl rounded-2xl shadow-2xl max-h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
          <h3 className="text-lg font-bold text-bone">{isNew ? 'New drill' : 'Edit drill'}</h3>
          <button onClick={onClose} className="text-bone/40 hover:text-bone/85">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* AI generate */}
          <div className="bg-violet-500/15 ring-1 ring-violet-200 rounded-xl p-3">
            <label className="block text-[10px] font-extrabold uppercase tracking-widest text-violet-300 mb-1.5">Generate with AI</label>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="text"
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value)}
                placeholder='e.g. "first touch under pressure, 10 min, U10"'
                className="flex-1 px-3 py-2 text-sm border border-violet-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500/40 bg-charcoal-900"
              />
              <button
                type="button"
                onClick={runAI}
                disabled={generating}
                className="px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500/150 disabled:opacity-60 text-white text-sm font-bold whitespace-nowrap"
              >
                {generating ? 'Generating…' : 'Generate'}
              </button>
            </div>
            <p className="text-[10px] text-violet-300 mt-1.5">Claude drafts the title, setup, instructions, focus, and duration. You review + edit before saving.</p>
          </div>

          {/* Core fields */}
          <Field label="Drill title">
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Half-turn receive"
              className="w-full px-3 py-2 text-sm border border-white/15 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary/40"
            />
          </Field>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <Field label="Topic">
              <select value={topic} onChange={(e) => setTopic(e.target.value as any)} className="w-full px-3 py-2 text-sm bg-charcoal-950 text-bone [color-scheme:dark] border border-white/15 rounded-lg">
                {TOPICS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </Field>
            <Field label="Category">
              <select value={category} onChange={(e) => setCategory(e.target.value as any)} className="w-full px-3 py-2 text-sm bg-charcoal-950 text-bone [color-scheme:dark] border border-white/15 rounded-lg">
                <option value="technical">Technical</option>
                <option value="tactical">Tactical</option>
                <option value="physical">Physical</option>
                <option value="mental">Mental</option>
              </select>
            </Field>
            <Field label="Age band">
              <select value={ageBand as string} onChange={(e) => setAgeBand(e.target.value as any)} className="w-full px-3 py-2 text-sm bg-charcoal-950 text-bone [color-scheme:dark] border border-white/15 rounded-lg">
                {AGE_BANDS.map(a => <option key={a.value as string} value={a.value as string}>{a.label}</option>)}
              </select>
            </Field>
          </div>
          {/* Use case — drives the headline Team / Extra Reps filter on
              the library so a coach building a Pathway sees the right
              content first. */}
          <Field label="Use case">
            <div className="flex flex-wrap gap-1.5">
              {([
                { k: 'team' as const, label: 'Team practice', hint: 'Group drill, needs multiple players' },
                { k: 'solo' as const, label: 'Extra Reps', hint: 'Solo / at-home work for one kid' },
                { k: 'both' as const, label: 'Both', hint: 'Works either way' },
              ]).map(c => (
                <button
                  key={c.k}
                  type="button"
                  onClick={() => setUseCase(c.k)}
                  title={c.hint}
                  className={`px-3 py-1.5 rounded-full text-[11px] font-extrabold tracking-widest uppercase transition ${
                    useCase === c.k
                      ? 'bg-brand-primary text-white shadow-sm'
                      : 'bg-charcoal-900 text-bone/55 ring-1 ring-white/10 hover:text-bone'
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Setup">
            <textarea
              value={setup}
              onChange={(e) => setSetup(e.target.value)}
              rows={2}
              placeholder="2 cones 5 yds apart, 1 ball per player."
              className="w-full px-3 py-2 text-sm border border-white/15 rounded-lg"
            />
          </Field>
          <Field label="Instructions (step-by-step)">
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={4}
              placeholder="Player checks shoulder, opens hips to the side they want to receive, first touch into space."
              className="w-full px-3 py-2 text-sm border border-white/15 rounded-lg"
            />
          </Field>
          <Field label="Coaching focus / key point">
            <input
              type="text"
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
              placeholder="Check shoulder BEFORE the ball arrives."
              className="w-full px-3 py-2 text-sm border border-white/15 rounded-lg"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Duration (min)">
              <input
                type="number"
                value={durationMinutes}
                onChange={(e) => setDurationMinutes(e.target.value === '' ? '' : parseInt(e.target.value, 10))}
                min={1}
                className="w-full px-3 py-2 text-sm border border-white/15 rounded-lg"
              />
            </Field>
            <Field label="Add YouTube link">
              <input
                type="url"
                value={videoUrl}
                onChange={(e) => setVideoUrl(e.target.value)}
                placeholder="https://youtu.be/…"
                className="w-full px-3 py-2 text-sm border border-white/15 rounded-lg"
              />
            </Field>
          </div>
          {/* Coach-uploaded video — works with any file (TikTok export,
              phone recording, downloaded clip, etc.). Lands in
              Cloudflare Stream same as Player Media uploads. */}
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-bone/65 mb-1">
              Upload a reference video {drill?.streamUid && '(replace)'}
            </label>
            {stagedStreamUid ? (
              <div className="rounded-lg border border-emerald-300 bg-emerald-500/15 p-3 text-xs text-emerald-200 flex items-center justify-between">
                <span className="font-semibold">Video uploaded — will attach on save.</span>
                <button
                  type="button"
                  onClick={() => { setStagedStreamUid(null); setPendingFile(null); setUploadPct(0); }}
                  className="text-emerald-300 hover:text-emerald-100 font-bold"
                >
                  Undo
                </button>
              </div>
            ) : uploading ? (
              <div className="rounded-lg border border-brand-primary-soft/40 bg-brand-primary/15 p-3">
                <div className="text-xs font-semibold text-brand-primary-soft mb-1.5">
                  Uploading {pendingFile?.name || 'video'}… {uploadPct}%
                </div>
                <div className="w-full bg-brand-primary/20 rounded h-1.5 overflow-hidden">
                  <div className="bg-brand-primary h-full transition-all" style={{ width: `${uploadPct}%` }} />
                </div>
              </div>
            ) : (
              <label className="block rounded-lg border-2 border-dashed border-white/15 p-3 text-center cursor-pointer hover:bg-white/[0.05]">
                <span className="text-xs text-bone/65">
                  Tap to pick a video from camera roll (works with downloaded TikToks)
                </span>
                <input
                  type="file"
                  accept="video/*"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleUploadFile(f); }}
                />
              </label>
            )}
            {drill?.streamUid && !stagedStreamUid && !uploading && (
              <div className="mt-2 aspect-video w-full rounded-lg overflow-hidden bg-black">
                <iframe
                  src={streamIframeUrl(drill.streamUid)}
                  title="Drill reference video"
                  loading="lazy"
                  allow="accelerometer; gyroscope; encrypted-media; picture-in-picture; fullscreen"
                  allowFullScreen
                  className="w-full h-full block border-0"
                />
              </div>
            )}
          </div>

          {drill?.videoLinks && drill.videoLinks.length > 0 && (
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-widest text-bone/65 mb-1">Existing videos</label>
              <ul className="text-xs text-bone/65 space-y-1">
                {drill.videoLinks.map(v => (
                  <li key={v.id} className="truncate">{v.title || v.url}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Share to library — only on existing drills, not during
              create. Flipping this triggers an immediate Firestore
              write (via toggleShareToLibrary) so the state is
              visible to other coaches the moment the toggle moves;
              we don't wait for the parent 'Save drill' click. */}
          {!isNew && drill && drill.id && (
            <ShareToLibraryRow drill={drill} />
          )}
        </div>

        <div className="px-5 py-3 border-t border-white/10 flex items-center justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm font-bold text-bone/85 hover:bg-white/[0.08] rounded-lg">Cancel</button>
          <button
            onClick={handleSave}
            disabled={saving || uploading || !title.trim()}
            className="px-4 py-2 text-sm font-bold text-white bg-brand-primary hover:bg-brand-primary/150 disabled:opacity-50 rounded-lg"
            title={uploading ? 'Wait for the video upload to finish' : undefined}
          >
            {saving ? 'Saving…' : uploading ? `Uploading video · ${uploadPct}%` : 'Save drill'}
          </button>
        </div>
      </div>
    </div>
  );
};

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <label className="block text-[10px] font-bold uppercase tracking-widest text-bone/65 mb-1">{label}</label>
    {children}
  </div>
);

// ─────────────────────────────────────────────────────────────
// ShareToLibraryRow — toggle inside the DrillEditor for putting
// the drill into the public catalog. Writes immediately on flip;
// the parent 'Save drill' button doesn't need to know about it.
// ─────────────────────────────────────────────────────────────
const ShareToLibraryRow: React.FC<{ drill: Drill }> = ({ drill }) => {
  const [shared, setShared] = useState(drill.shareToLibrary === true);
  const [clubAllowsSharing, setClubAllowsSharing] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Read the club's allowDrillSharing setting. If the club owner has
  // disabled outbound sharing, the toggle reads as locked. Already-
  // shared drills stay shared (we don't auto-unshare on lockdown).
  useEffect(() => {
    const clubId = (drill as any).clubId;
    if (!clubId) { setClubAllowsSharing(true); return; }
    let cancelled = false;
    (async () => {
      try {
        const { getDoc, doc } = await import('firebase/firestore');
        const { db } = await import('../utils/firebase');
        const snap = await getDoc(doc(db, 'clubs', clubId));
        if (cancelled) return;
        const allow = snap.exists() ? ((snap.data() as any).allowDrillSharing !== false) : true;
        setClubAllowsSharing(allow);
      } catch { setClubAllowsSharing(true); }
    })();
    return () => { cancelled = true; };
  }, [drill]);

  const flip = async () => {
    if (busy) return;
    const next = !shared;
    // Block enabling when the club has it disabled. Disabling
    // (unshare) is always allowed so a coach can pull their drill
    // back out of the catalog regardless of club setting.
    if (next && !clubAllowsSharing) {
      setError('Your club owner has paused outbound drill sharing.');
      return;
    }
    setBusy(true); setError(null);
    try {
      await toggleShareToLibrary(drill.id, next);
      setShared(next);
    } catch (e: any) {
      setError(e?.message || 'Could not update share status.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="bg-charcoal-800 rounded-xl ring-1 ring-white/10 px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-bone">Share to library</p>
          <p className="text-xs text-bone/55 mt-0.5 leading-snug">
            {clubAllowsSharing
              ? 'Let other coaches across GoalKickr find, rate, and save this drill. You can unshare anytime.'
              : (shared
                  ? 'Your club owner paused new shares, but this drill stays public until you unshare it.'
                  : 'Your club owner has paused outbound drill sharing.')}
          </p>
        </div>
        <button
          type="button"
          onClick={flip}
          disabled={busy || (!shared && !clubAllowsSharing)}
          className={`shrink-0 text-[11px] font-extrabold uppercase tracking-widest px-2.5 py-1 rounded-full transition disabled:opacity-50 ${
            shared
              ? 'bg-brand-primary text-white'
              : 'bg-white/[0.06] text-bone/65 ring-1 ring-white/15 hover:bg-white/[0.1]'
          }`}
        >
          {busy ? '…' : shared ? 'Shared' : 'Off'}
        </button>
      </div>
      {error && (
        <p className="mt-2 text-rose-300 text-xs bg-rose-500/10 border border-rose-500/30 rounded p-2">{error}</p>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────
// ReportLibraryDrillButton — flag a shared drill for review.
// Files a platform-scope support ticket with a 'drill-report'
// tag so Patrick sees it in the GoalKickr admin portal Tickets
// inbox. Single button, prompts for a reason, sends.
// ─────────────────────────────────────────────────────────────
const ReportLibraryDrillButton: React.FC<{
  drill: Drill;
  reporterUid?: string;
  reporterName?: string;
  reporterEmail?: string;
}> = ({ drill, reporterUid, reporterName, reporterEmail }) => {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const handle = async () => {
    if (busy || done || !reporterUid) return;
    const reason = window.prompt(
      `Why are you reporting "${drill.title}"?\n\nGoalKickr will review and may remove the drill.`,
      '',
    );
    if (reason === null) return; // cancelled
    const trimmed = reason.trim();
    if (!trimmed) {
      window.alert('Please give a brief reason so we can review.');
      return;
    }
    setBusy(true);
    try {
      const { openTicket } = await import('../utils/tickets');
      await openTicket({
        scope: 'platform',
        subject: `Drill report: "${drill.title}"`,
        body:
          `${trimmed}\n\n— context —\n` +
          `Drill id: ${drill.id}\n` +
          `Author: ${drill.createdByName || '—'} (uid ${drill.createdBy})\n` +
          `Topic: ${drill.topic}\n` +
          `Age band: ${drill.ageBand || 'all'}\n` +
          `Rating: ${drill.averageRating?.toFixed(1) || '—'} (${drill.ratingCount || 0} votes)`,
        authorUid: reporterUid,
        authorName: reporterName || 'Coach',
        authorEmail: reporterEmail || '',
        tags: ['drill-report', `drill:${drill.id}`],
        priority: 'normal',
      });
      setDone(true);
    } catch (e: any) {
      window.alert(e?.message || 'Could not send report. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={handle}
      disabled={busy || done}
      title={done ? 'Reported — thanks' : 'Report this drill'}
      className={`shrink-0 px-2.5 py-2 rounded-lg text-xs font-bold transition ring-1 ${
        done
          ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30'
          : 'bg-charcoal-800 text-bone/55 ring-white/10 hover:text-bone hover:bg-charcoal-700'
      } disabled:opacity-60`}
    >
      {busy ? '…' : done ? '✓' : '⚑'}
    </button>
  );
};

// ─────────────────────────────────────────────────────────────
// LibraryCard — surface for shared community drills.
// Shows the rating badge + save button + star row. Tapping the
// card body navigates to a read-only detail view in the future;
// for v1 it just expands info inline via the description.
// ─────────────────────────────────────────────────────────────
const LibraryCard: React.FC<{
  drill: Drill;
  voterUid?: string;
  voterName?: string;
  voterEmail?: string;
  onRate: (stars: 1 | 2 | 3 | 4 | 5) => void;
  onSave: () => void;
  saving: boolean;
}> = ({ drill, voterUid, voterName, voterEmail, onRate, onSave, saving }) => {
  const myStars = voterUid ? (drill.ratedBy?.[voterUid] as 1 | 2 | 3 | 4 | 5 | undefined) : undefined;
  const avg = drill.averageRating || 0;
  const count = drill.ratingCount || 0;
  const saveCount = drill.saveCount || 0;
  const featured = isFeatured(drill);

  return (
    <li className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 overflow-hidden">
      {drill.streamUid && (
        <div className="aspect-video w-full bg-white/10 relative">
          <img
            src={streamThumbnailUrl(drill.streamUid, { height: 240 })}
            alt=""
            loading="lazy"
            className="w-full h-full object-cover"
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
          />
        </div>
      )}
      <div className="p-4">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[10px] font-extrabold tracking-widest uppercase text-brand-primary-soft bg-brand-primary/15 ring-1 ring-brand-primary-soft/30 px-1.5 py-0.5 rounded">
            {TOPICS.find(t => t.value === drill.topic)?.label || drill.topic}
          </span>
          {drill.ageBand && drill.ageBand !== 'all' && (
            <span className="text-[10px] font-bold text-bone/50">{drill.ageBand}</span>
          )}
          {featured && (
            <span className="text-[10px] font-extrabold tracking-widest uppercase text-amber-300 bg-amber-500/15 ring-1 ring-amber-300/30 px-1.5 py-0.5 rounded">Featured</span>
          )}
        </div>
        <h3 className="text-base font-bold text-bone mb-1 line-clamp-2">{drill.title}</h3>
        {drill.focus && <p className="text-xs text-bone/65 line-clamp-2">{drill.focus}</p>}
        {drill.description && !drill.focus && <p className="text-xs text-bone/65 line-clamp-2">{drill.description}</p>}

        <div className="mt-3 flex items-center justify-between gap-2 text-[11px] text-bone/55">
          <div className="flex items-center gap-2">
            <span title={`Average ${avg.toFixed(1)} from ${count} ${count === 1 ? 'rating' : 'ratings'}`}>
              ★ {count > 0 ? avg.toFixed(1) : '—'} <span className="text-bone/35">({count})</span>
            </span>
            {saveCount > 0 && <span>· saved {saveCount}×</span>}
          </div>
          <span className="text-bone/35 truncate">by {drill.createdByName || 'Coach'}</span>
        </div>

        {/* Star row — five buttons. Filled if user's vote >= n. */}
        <div className="mt-3 flex items-center gap-0.5">
          {[1, 2, 3, 4, 5].map(n => {
            const active = myStars !== undefined && n <= myStars;
            return (
              <button
                key={n}
                type="button"
                onClick={() => onRate(n as 1 | 2 | 3 | 4 | 5)}
                className={`text-lg leading-none transition ${active ? 'text-amber-300' : 'text-bone/25 hover:text-bone/55'}`}
                title={`Rate ${n} star${n === 1 ? '' : 's'}`}
              >
                ★
              </button>
            );
          })}
          {myStars !== undefined && (
            <span className="ml-2 text-[10px] font-bold uppercase tracking-wider text-bone/45">
              your rating
            </span>
          )}
        </div>

        <div className="mt-3 flex items-stretch gap-2">
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className="flex-1 px-3 py-2 rounded-lg bg-brand-primary text-white text-xs font-extrabold uppercase tracking-widest hover:bg-brand-primary-soft hover:text-charcoal-950 disabled:opacity-60 transition"
          >
            {saving ? 'Saving…' : 'Save to my drills'}
          </button>
          <ReportLibraryDrillButton
            drill={drill}
            reporterUid={voterUid}
            reporterName={voterName}
            reporterEmail={voterEmail}
          />
        </div>
      </div>
    </li>
  );
};

export default Drills;

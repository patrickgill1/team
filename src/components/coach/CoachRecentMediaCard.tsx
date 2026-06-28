// @ts-nocheck
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, getDocs, limit, orderBy, query, where } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { useTeam } from '../../contexts/TeamContext';

/**
 * Coach recent media card — surfaces the latest 6 photos/videos
 * uploaded by anyone on the team in the last 14 days. Lives in /coach
 * cockpit (not Dashboard — the dashboard's already getting busy).
 * Patrick 2026-06-21 dialogue idea #4: 'Recent media to promote. New
 * photos/clips uploaded by parents that the coach hasn't reviewed
 * yet. Encourages parent-uploaded content because they see it
 * actually used.'
 *
 * V1: thumbnail grid + tap-to-open. No promote-to-highlights action
 * yet (that's a separate flow that touches the highlights collection;
 * worth a dedicated batch). Showing the media here is enough to
 * trigger 'oh I should react to that' which is the loop we're
 * trying to close.
 *
 * Hidden when no media in the window — keeps the cockpit tight on
 * teams that don't have media uploads yet.
 */

interface MediaThumb {
  id: string;
  url: string;
  thumb?: string;
  type: 'photo' | 'video';
  uploadedByName?: string;
}

const CoachRecentMediaCard: React.FC = () => {
  const { selectedTeamId } = useTeam();
  const [media, setMedia] = useState<MediaThumb[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!selectedTeamId) { setLoaded(true); return; }
    let cancelled = false;
    (async () => {
      try {
        const q = query(
          collection(db, 'player_media'),
          where('teamId', '==', selectedTeamId),
          orderBy('createdAt', 'desc'),
          limit(6)
        );
        const snap = await getDocs(q);
        if (cancelled) return;
        setMedia(snap.docs.map((d) => {
          const data: any = d.data();
          return {
            id: d.id,
            url: data.url || '',
            thumb: data.thumbnailUrl || data.url,
            type: data.type === 'video' ? 'video' : 'photo',
            uploadedByName: data.uploadedByName,
          };
        }));
      } catch (err) {
        console.warn('[coach-recent-media] load failed', err);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedTeamId]);

  if (!loaded) return null;
  if (media.length === 0) return null;

  return (
    <div className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/10 p-4 mt-3 animate-fade-in">
      <div className="flex items-center justify-between mb-2.5">
        <div>
          <p className="text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/55">Recent media</p>
          <p className="text-sm font-bold text-ink-primary mt-0.5">{media.length} new from your team</p>
        </div>
        <Link to="/player-media" className="text-[10px] font-extrabold tracking-widest uppercase text-brand-primary-soft hover:text-brand-primary-soft">
          See all →
        </Link>
      </div>
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
        {media.map((m) => (
          <Link
            key={m.id}
            to="/player-media"
            className="relative aspect-square rounded-lg overflow-hidden bg-surface-base ring-1 ring-line-default/10 hover:ring-brand-primary/40 transition group"
            title={m.uploadedByName ? `From ${m.uploadedByName}` : undefined}
          >
            {m.thumb ? (
              <img
                src={m.thumb}
                alt=""
                loading="lazy"
                className="absolute inset-0 w-full h-full object-cover"
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-ink-primary/40">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><polyline points="21 15 16 10 5 21" /></svg>
              </div>
            )}
            {m.type === 'video' && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span className="w-7 h-7 rounded-full bg-black/55 backdrop-blur text-white flex items-center justify-center">
                  <svg className="w-3 h-3 translate-x-[1px]" fill="currentColor" viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4" /></svg>
                </span>
              </div>
            )}
          </Link>
        ))}
      </div>
    </div>
  );
};

export default CoachRecentMediaCard;

import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { FullGame } from '../types';
import { downloadFile } from '../utils/downloadFile';
import { getStreamDownloadUrl } from '../utils/streamUpload';
import StreamPlayer from '../components/common/StreamPlayer';

const PublicGame: React.FC = () => {
  const { gameId } = useParams<{ gameId: string }>();
  const [game, setGame] = useState<FullGame | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadPercent, setDownloadPercent] = useState(0);

  const handleDownload = async () => {
    if (!game || downloading) return;
    if (!game.videoUrl && !game.streamUid) return;
    const filename = game.videoFileName || `${(game.title || 'game').replace(/[^a-z0-9]+/gi, '_')}.mp4`;
    setDownloading(true);
    setDownloadPercent(0);

    let sourceUrl = game.videoUrl || '';
    if (game.streamUid) {
      try {
        const dl = await getStreamDownloadUrl(game.streamUid);
        if (dl.ready) {
          sourceUrl = dl.url;
        } else {
          alert(`Your download is still being prepared (${dl.percent}%). Try again in 30-60 seconds.`);
          setDownloading(false);
          return;
        }
      } catch (err) {
        console.error('Stream download URL failed:', err);
      }
    }
    if (!sourceUrl) { setDownloading(false); return; }

    const result = await downloadFile(sourceUrl, filename, {
      onProgress: p => setDownloadPercent(p.percent),
    });
    setDownloading(false);
    setDownloadPercent(0);
    if (result.ok === false && result.reason === 'fetch-failed') {
      alert("Your browser couldn't save this directly. The file opened in a new tab — long-press (mobile) or right-click (desktop) to save it.");
    }
  };

  useEffect(() => {
    if (!gameId) {
      setError('Invalid link.');
      setLoading(false);
      return;
    }
    const load = async () => {
      try {
        const cleanId = decodeURIComponent(gameId).split(/[\s,]/)[0].trim();
        const snap = await getDoc(doc(db, 'full_games', cleanId));
        if (!snap.exists()) {
          setError('This game could not be found or may have been removed.');
          setLoading(false);
          return;
        }
        const data = snap.data() as any;
        setGame({
          id: snap.id,
          ...data,
          gameDate: data.gameDate?.toDate ? data.gameDate.toDate() : new Date(data.gameDate),
        });
      } catch (err) {
        console.error('Error loading game:', err);
        setError('Failed to load game. Please try again.');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [gameId]);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-cyan-200 border-t-cyan-500" />
      </div>
    );
  }

  if (error || !game) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
        <div className="text-center">
          <div className="text-5xl mb-4">⚽</div>
          <h1 className="text-xl font-bold text-white mb-2">Game Not Found</h1>
          <p className="text-white/60 text-sm mb-6">{error}</p>
          <Link to="/" className="inline-block px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white text-sm font-medium rounded-lg">
            Go to Fire FC
          </Link>
        </div>
      </div>
    );
  }

  const formattedDate = (game.gameDate as Date).toLocaleDateString(undefined, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-black text-white">
      {/* Ambient glow */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -left-40 w-96 h-96 bg-cyan-500/20 rounded-full blur-3xl" />
        <div className="absolute -top-20 right-0 w-96 h-96 bg-violet-500/15 rounded-full blur-3xl" />
      </div>

      <header className="relative z-10 border-b border-white/10 backdrop-blur-sm bg-black/30">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <Link to="/" className="flex items-center space-x-2">
            <span className="text-2xl">🔥</span>
            <span className="font-bold tracking-tight">Fire FC</span>
          </Link>
          <Link to="/auth" className="text-xs text-white/60 hover:text-white">Team Login</Link>
        </div>
      </header>

      <main className="relative z-10 max-w-5xl mx-auto px-4 py-6">
        <div className="aspect-video w-full bg-black rounded-xl overflow-hidden ring-1 ring-white/10 shadow-2xl">
          {game.streamUid ? (
            <StreamPlayer
              uid={game.streamUid}
              autoplay
              title={game.title}
              className="w-full h-full"
            />
          ) : game.videoUrl ? (
            <video
              src={game.videoUrl}
              className="w-full h-full"
              controls
              autoPlay
              playsInline
            />
          ) : game.youtubeId ? (
            <iframe
              src={`https://www.youtube.com/embed/${game.youtubeId}?autoplay=1&rel=0`}
              title={game.title}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowFullScreen
              className="w-full h-full"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-white/40">
              No video attached.
            </div>
          )}
        </div>

        <div className="mt-5">
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <span className="text-[11px] uppercase tracking-wider text-cyan-300/80 px-2 py-0.5 rounded-full bg-cyan-500/10 ring-1 ring-cyan-500/30">
              Full Game
            </span>
            {game.result && (
              <span className={`text-xs font-bold px-2 py-0.5 rounded ${
                game.result.startsWith('W') ? 'bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/30'
                  : game.result.startsWith('L') ? 'bg-red-500/20 text-red-300 ring-1 ring-red-500/30'
                  : 'bg-white/10 text-white/80 ring-1 ring-white/20'
              }`}>
                {game.result}
              </span>
            )}
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">{game.title}</h1>
          <div className="text-sm text-white/70 mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            {game.opponent && <span>vs {game.opponent}</span>}
            <span>{formattedDate}</span>
          </div>
          {game.notes && (
            <p className="text-sm text-white/80 mt-4 leading-relaxed whitespace-pre-wrap">{game.notes}</p>
          )}

          <div className="flex flex-wrap items-center gap-3 mt-6">
            <button
              onClick={async () => {
                const url = window.location.href;
                const data = { title: game.title, url };
                try {
                  if (navigator.share) await navigator.share(data);
                  else { await navigator.clipboard.writeText(url); alert('Link copied!'); }
                } catch (err: any) {
                  if (err?.name !== 'AbortError') {
                    try { await navigator.clipboard.writeText(url); alert('Link copied!'); } catch {}
                  }
                }
              }}
              className="inline-flex items-center space-x-1.5 px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white text-sm font-medium rounded-lg transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"/></svg>
              <span>Share</span>
            </button>
            {game.videoUrl && (
              <button
                onClick={handleDownload}
                disabled={downloading}
                className="inline-flex items-center space-x-1.5 px-4 py-2 bg-white/10 hover:bg-white/15 disabled:bg-white/10 disabled:cursor-wait text-white text-sm font-medium rounded-lg ring-1 ring-white/15 transition-colors"
              >
                {downloading ? (
                  <>
                    <div className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                    <span className="tabular-nums">{downloadPercent > 0 ? `${downloadPercent}%` : 'Saving…'}</span>
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" /></svg>
                    <span>Download</span>
                  </>
                )}
              </button>
            )}
          </div>
        </div>

        <p className="text-xs text-white/40 mt-10 text-center">
          Hosted on <span className="text-cyan-300/80">firefcsoccer.com</span> · Shared by {game.addedByName}
        </p>
      </main>
    </div>
  );
};

export default PublicGame;

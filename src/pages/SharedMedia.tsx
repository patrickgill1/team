import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { downloadFile } from '../utils/downloadFile';
import { streamIframeUrl, getStreamDownloadUrl } from '../utils/streamUpload';

const SharedMedia: React.FC = () => {
  const { mediaId } = useParams<{ mediaId: string }>();
  const [media, setMedia] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadPercent, setDownloadPercent] = useState(0);

  const handleDownload = async () => {
    if (!media || downloading) return;
    const isVid = media.type === 'video' || media.contentType?.startsWith('video/');
    const filename = media.fileName || `${media.playerName || 'team'}-${isVid ? 'video.mp4' : 'photo.jpg'}`;
    setDownloading(true);
    setDownloadPercent(0);

    // Stream videos: ask Cloudflare to render an MP4 download URL.
    // First call typically returns "in progress" then "ready" within ~30s.
    let url: string = media.url;
    if (isVid && media.streamUid) {
      try {
        const dl = await getStreamDownloadUrl(media.streamUid);
        if (dl.ready) {
          url = dl.url;
        } else {
          alert('Cloudflare is still preparing the MP4 for this clip. Try again in 30–60 seconds.');
          setDownloading(false);
          return;
        }
      } catch (err) {
        console.error('Stream download URL error', err);
        // fall through and try the existing url (HLS) — downloadFile will
        // fall back to opening in a new tab if the browser can't save HLS.
      }
    }

    const result = await downloadFile(url, filename, {
      onProgress: p => setDownloadPercent(p.percent),
    });
    setDownloading(false);
    setDownloadPercent(0);
    if (result.ok === false && result.reason === 'fetch-failed') {
      alert("Your browser couldn't save this directly. The file opened in a new tab — long-press (mobile) or right-click (desktop) to save it.");
    }
  };

  useEffect(() => {
    if (!mediaId) {
      setError('Invalid link.');
      setLoading(false);
      return;
    }

    const load = async () => {
      try {
        // Some share targets append the share text to the URL, so extract just the doc ID
        // Firestore auto-IDs are 20 alphanumeric characters
        const cleanId = decodeURIComponent(mediaId).split(/[\s,]/)[0].trim();
        
        // Try player_media first, then gallery
        let snap = await getDoc(doc(db, 'player_media', cleanId));
        if (!snap.exists()) {
          snap = await getDoc(doc(db, 'gallery', cleanId));
        }
        if (!snap.exists()) {
          setError('This media could not be found or may have been removed.');
          setLoading(false);
          return;
        }
        setMedia({ id: snap.id, ...snap.data() });
      } catch (err) {
        console.error('Error loading shared media:', err);
        setError('Failed to load media. Please try again.');
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [mediaId]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-white"></div>
      </div>
    );
  }

  if (error || !media) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
        <div className="text-center">
          <div className="text-5xl mb-4">⚽</div>
          <h1 className="text-xl font-bold text-white mb-2">Media Not Found</h1>
          <p className="text-gray-400">{error || 'This link may have expired or been removed.'}</p>
        </div>
      </div>
    );
  }

  const isVideo = media.type === 'video' || media.contentType?.startsWith('video/');
  const title = media.caption || `${media.playerName || 'Team'} — ${isVideo ? 'Video' : 'Photo'}`;

  return (
    <div className="min-h-screen bg-gray-900 flex flex-col">
      {/* Header */}
      <div className="bg-gray-800 border-b border-gray-700 px-4 py-3">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <span className="text-2xl">⚽</span>
            <div>
              <h1 className="text-white font-semibold text-sm sm:text-base truncate max-w-[200px] sm:max-w-none">
                {title}
              </h1>
              {media.playerName && (
                <p className="text-gray-400 text-xs sm:text-sm">{media.playerName}</p>
              )}
            </div>
          </div>
          <button
            onClick={handleDownload}
            disabled={downloading}
            className="flex items-center space-x-1.5 bg-charcoal-600 hover:bg-charcoal-700 disabled:bg-charcoal-600/70 disabled:cursor-wait text-white text-sm px-3 py-1.5 rounded-lg transition-colors"
          >
            {downloading ? (
              <>
                <div className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                <span className="tabular-nums">
                  {downloadPercent > 0 ? `${downloadPercent}%` : 'Saving…'}
                </span>
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                <span className="hidden sm:inline">Download</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Media */}
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="max-w-4xl w-full">
          {isVideo ? (
            media.streamUid ? (
              <div className="w-full aspect-video rounded-lg overflow-hidden bg-black">
                <iframe
                  key={media.streamUid}
                  src={streamIframeUrl(media.streamUid)}
                  title={media.caption || 'Video'}
                  loading="lazy"
                  allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture;"
                  allowFullScreen
                  className="w-full h-full block border-0"
                />
              </div>
            ) : (
              <video
                src={media.url}
                controls
                playsInline
                preload="metadata"
                className="w-full max-h-[80vh] rounded-lg bg-black"
              />
            )
          ) : (
            <img
              src={media.url}
              alt={media.caption || ''}
              className="w-full max-h-[80vh] object-contain rounded-lg"
            />
          )}

          {/* Caption & metadata */}
          {(media.caption || media.uploadedByName) && (
            <div className="mt-3 px-1">
              {media.caption && (
                <p className="text-white text-sm sm:text-base">{media.caption}</p>
              )}
              {media.uploadedByName && (
                <p className="text-gray-500 text-xs mt-1">
                  Shared by {media.uploadedByName}
                  {media.createdAt?.toDate && (
                    <> · {media.createdAt.toDate().toLocaleDateString()}</>
                  )}
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="bg-gray-800 border-t border-gray-700 px-4 py-3 text-center">
        <a
          href="/"
          className="text-gray-400 hover:text-white text-xs transition-colors"
        >
          GoalKickr
        </a>
      </div>
    </div>
  );
};

export default SharedMedia;

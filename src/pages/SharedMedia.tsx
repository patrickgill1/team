import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../utils/firebase';

const SharedMedia: React.FC = () => {
  const { mediaId } = useParams<{ mediaId: string }>();
  const [media, setMedia] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
          <a
            href={media.url}
            download
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center space-x-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm px-3 py-1.5 rounded-lg transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            <span className="hidden sm:inline">Download</span>
          </a>
        </div>
      </div>

      {/* Media */}
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="max-w-4xl w-full">
          {isVideo ? (
            <video
              src={media.url}
              controls
              playsInline
              preload="metadata"
              className="w-full max-h-[80vh] rounded-lg bg-black"
            />
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
          Fire FC ⚽
        </a>
      </div>
    </div>
  );
};

export default SharedMedia;

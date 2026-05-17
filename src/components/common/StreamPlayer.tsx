// Cloudflare Stream iframe player.
//
// Stream's hosted iframe handles HLS, adaptive bitrate, mobile playback (incl.
// iOS native HLS), captions, and the player chrome — saves us from owning a
// custom hls.js setup. Tradeoff: it's an iframe, so we can't directly listen
// to events on the <video>; if we ever need playback events we can adopt the
// stream SDK or postMessage.
//
// While a freshly uploaded video is still being transcoded, the iframe shows
// CF's own "video is being processed" UI, so we don't need to do anything
// special on our end.

import React from 'react';
import { streamIframeUrl } from '../../utils/streamUpload';

interface StreamPlayerProps {
  uid: string;
  className?: string;
  autoplay?: boolean;
  poster?: string;
  title?: string;
}

const StreamPlayer: React.FC<StreamPlayerProps> = ({
  uid,
  className = '',
  autoplay = false,
  poster,
  title,
}) => (
  <div className={`relative w-full bg-black overflow-hidden ${className}`} style={{ aspectRatio: '16 / 9' }}>
    <iframe
      src={streamIframeUrl(uid, { autoplay, poster })}
      title={title || 'Video'}
      loading="lazy"
      allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture;"
      allowFullScreen
      className="absolute inset-0 w-full h-full border-0"
    />
  </div>
);

export default StreamPlayer;

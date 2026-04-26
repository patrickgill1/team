/**
 * Client-side video compression using Canvas + MediaRecorder.
 * Re-encodes videos at 720p / 2Mbps to dramatically reduce file sizes
 * for smooth mobile playback from Firebase Storage.
 */

const TARGET_HEIGHT = 1080;
const TARGET_WIDTH = 1920;
const TARGET_BITRATE = 6_000_000; // 6 Mbps — high quality for 1080p
const MIN_SIZE_TO_COMPRESS = 50 * 1024 * 1024; // Only compress files over 50MB
const MAX_DURATION_TO_COMPRESS = 300; // 5 minutes max

function getSupportedMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  const types = [
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4',
  ];
  return types.find(t => MediaRecorder.isTypeSupported(t)) || null;
}

export function canCompressVideo(): boolean {
  // DISABLED: Source clips are already H.264 MP4 with Fast Start from Premiere.
  // Canvas-based recompression destroys quality and produces WebM that iOS
  // Safari cannot play. Upload originals as-is.
  return false;
}

export interface CompressionProgress {
  phase: 'loading' | 'compressing' | 'done';
  percent: number;
}

export function compressVideo(
  file: File,
  onProgress?: (progress: CompressionProgress) => void
): Promise<File> {
  return new Promise((resolve) => {
    // Skip small files
    if (file.size <= MIN_SIZE_TO_COMPRESS) {
      resolve(file);
      return;
    }

    const mimeType = getSupportedMimeType();
    if (!mimeType) {
      resolve(file);
      return;
    }

    onProgress?.({ phase: 'loading', percent: 0 });

    const video = document.createElement('video');
    video.playsInline = true;
    video.preload = 'auto';

    const url = URL.createObjectURL(file);

    const cleanup = () => {
      URL.revokeObjectURL(url);
      video.pause();
      video.removeAttribute('src');
      video.load();
    };

    video.onloadedmetadata = () => {
      // Skip long videos
      if (video.duration > MAX_DURATION_TO_COMPRESS) {
        cleanup();
        resolve(file);
        return;
      }

      // Calculate target dimensions (maintain aspect ratio)
      let { videoWidth: w, videoHeight: h } = video;
      if (w > TARGET_WIDTH || h > TARGET_HEIGHT) {
        const ratio = Math.min(TARGET_WIDTH / w, TARGET_HEIGHT / h);
        w = Math.round(w * ratio);
        h = Math.round(h * ratio);
      }
      // Ensure even dimensions (required by most codecs)
      w = w % 2 === 0 ? w : w - 1;
      h = h % 2 === 0 ? h : h - 1;

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d')!;

      // Set up streams
      let audioCtx: AudioContext | null = null;
      let combined: MediaStream;

      try {
        // Try to capture audio via AudioContext
        audioCtx = new AudioContext();
        const source = audioCtx.createMediaElementSource(video);
        const dest = audioCtx.createMediaStreamDestination();
        source.connect(dest);
        // Don't connect to speakers (no audible playback)

        const canvasStream = canvas.captureStream(30);
        combined = new MediaStream([
          ...canvasStream.getVideoTracks(),
          ...dest.stream.getAudioTracks(),
        ]);
        video.muted = false;
      } catch {
        // Fallback: video-only (no audio)
        combined = canvas.captureStream(30);
        video.muted = true;
      }

      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(combined, {
          mimeType,
          videoBitsPerSecond: TARGET_BITRATE,
        });
      } catch {
        audioCtx?.close();
        cleanup();
        resolve(file);
        return;
      }

      const chunks: Blob[] = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      recorder.onstop = () => {
        audioCtx?.close();
        cleanup();

        const blob = new Blob(chunks, { type: mimeType });
        onProgress?.({ phase: 'done', percent: 100 });

        // Only use compressed version if actually smaller
        if (blob.size < file.size * 0.9) {
          const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
          const name = file.name.replace(/\.[^.]+$/, `.${ext}`);
          resolve(new File([blob], name, { type: mimeType }));
        } else {
          resolve(file);
        }
      };

      recorder.onerror = () => {
        audioCtx?.close();
        cleanup();
        resolve(file);
      };

      // Draw loop
      const draw = () => {
        if (video.ended || video.paused) return;
        ctx.drawImage(video, 0, 0, w, h);
        if (onProgress && video.duration > 0) {
          onProgress({
            phase: 'compressing',
            percent: Math.round((video.currentTime / video.duration) * 100),
          });
        }
        requestAnimationFrame(draw);
      };

      video.onplay = draw;
      video.onended = () => {
        // Small delay to ensure last frames are captured
        setTimeout(() => recorder.stop(), 200);
      };

      recorder.start(100);

      video.play().catch(() => {
        // Autoplay blocked — try muted (will lose audio)
        video.muted = true;
        video.play().catch(() => {
          audioCtx?.close();
          cleanup();
          resolve(file);
        });
      });
    };

    video.onerror = () => {
      cleanup();
      resolve(file);
    };

    video.src = url;
  });
}

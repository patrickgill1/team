package com.firefc.team.widget;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.graphics.Rect;
import android.graphics.RectF;
import android.os.AsyncTask;
import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Background fetch for the widget snapshot. Matches the iOS widget's
 * networking: GET https://api.goalkickr.com/widget/snapshot with a
 * Bearer header carrying the user's long-lived setup code, response
 * JSON is decoded into a {@link Snapshot}.
 *
 * Also includes a small image downloader that center-crops the player
 * photo into a circle for the RemoteViews avatar slot (RemoteViews has
 * no clipToOutline equivalent, so we pre-crop the Bitmap and call
 * setImageViewBitmap with the result).
 *
 * Uses HttpURLConnection so we don't need to add OkHttp as a widget
 * dependency. AsyncTask is deprecated app-wide but still legal; for a
 * widget refresh that fires every 30 minutes it's fine.
 */
public final class SnapshotFetcher {
    private static final String TAG = "GKWidget";
    private static final String ENDPOINT = "https://api.goalkickr.com/widget/snapshot";
    private static final int CONNECT_TIMEOUT_MS = 12_000;
    private static final int READ_TIMEOUT_MS = 12_000;
    private static final int PHOTO_MAX_EDGE_PX = 192;

    private SnapshotFetcher() {}

    public interface Callback {
        void onResult(Snapshot snapshot, Bitmap photo, String errorCode);
    }

    public static final class Snapshot {
        public final String playerId;
        public final String playerName;
        public final Integer jerseyNumber;
        public final String photoUrl;
        public final String teamName;
        public final int streakDays;
        public final Integer potmCount;
        public final String nextEventTitle;
        public final String nextEventType;
        public final Long nextEventDateMs;
        public final String nextEventLocation;
        public final String nextEventRsvp;
        public final String lastResultTitle;
        public final String lastResultScore;
        public final Long lastResultDateMs;

        Snapshot(JSONObject o) {
            this.playerId = o.optString("playerId", "");
            this.playerName = o.optString("playerName", "");
            this.jerseyNumber = o.has("jerseyNumber") && !o.isNull("jerseyNumber")
                ? o.optInt("jerseyNumber") : null;
            this.photoUrl = nullIfEmpty(o.optString("photoUrl", null));
            this.teamName = nullIfEmpty(o.optString("teamName", null));
            this.streakDays = o.optInt("streakDays", 0);
            this.potmCount = o.has("potmCount") && !o.isNull("potmCount")
                ? o.optInt("potmCount") : null;
            this.nextEventTitle = nullIfEmpty(o.optString("nextEventTitle", null));
            this.nextEventType = nullIfEmpty(o.optString("nextEventType", null));
            this.nextEventDateMs = o.has("nextEventDateMs") && !o.isNull("nextEventDateMs")
                ? (long) o.optDouble("nextEventDateMs", 0) : null;
            this.nextEventLocation = nullIfEmpty(o.optString("nextEventLocation", null));
            this.nextEventRsvp = nullIfEmpty(o.optString("nextEventRsvp", null));
            this.lastResultTitle = nullIfEmpty(o.optString("lastResultTitle", null));
            this.lastResultScore = nullIfEmpty(o.optString("lastResultScore", null));
            this.lastResultDateMs = o.has("lastResultDateMs") && !o.isNull("lastResultDateMs")
                ? (long) o.optDouble("lastResultDateMs", 0) : null;
        }

        private static String nullIfEmpty(String s) {
            return (s == null || s.isEmpty() || "null".equals(s)) ? null : s;
        }
    }

    /**
     * Kick off the fetch. The callback fires on the main thread.
     * Pass an empty/null setupCode for a "needs-setup" placeholder.
     */
    public static void fetch(final String setupCode, final Callback cb) {
        if (setupCode == null || setupCode.isEmpty()) {
            cb.onResult(null, null, "needs-setup");
            return;
        }
        // Time-nonce ensures the URLConnection cache doesn't serve a
        // stale 200 from earlier in the day.
        final String urlStr = ENDPOINT + "?t=" + (System.currentTimeMillis() / 1000);

        new AsyncTask<Void, Void, Object[]>() {
            @Override
            protected Object[] doInBackground(Void... voids) {
                Snapshot snap = null;
                Bitmap photo = null;
                String err = null;
                HttpURLConnection conn = null;
                try {
                    URL url = new URL(urlStr);
                    conn = (HttpURLConnection) url.openConnection();
                    conn.setRequestMethod("GET");
                    conn.setRequestProperty("Authorization", "Bearer " + setupCode);
                    conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
                    conn.setReadTimeout(READ_TIMEOUT_MS);
                    conn.setUseCaches(false);
                    int code = conn.getResponseCode();
                    if (code == 401) {
                        err = "invalid-code";
                    } else if (code != 200) {
                        err = "server";
                    } else {
                        StringBuilder body = new StringBuilder();
                        InputStream is = conn.getInputStream();
                        try (BufferedReader r = new BufferedReader(new InputStreamReader(is, "UTF-8"))) {
                            String line;
                            while ((line = r.readLine()) != null) body.append(line);
                        }
                        JSONObject root = new JSONObject(body.toString());
                        if (!root.optBoolean("ok", false)) {
                            err = root.optString("error", "server");
                        } else {
                            JSONObject snapObj = root.optJSONObject("snapshot");
                            if (snapObj != null) snap = new Snapshot(snapObj);
                        }
                    }
                } catch (Exception e) {
                    Log.w(TAG, "snapshot fetch failed", e);
                    err = "offline";
                } finally {
                    if (conn != null) conn.disconnect();
                }

                if (snap != null && snap.photoUrl != null) {
                    photo = fetchPhoto(snap.photoUrl);
                }
                return new Object[]{snap, photo, err};
            }

            @Override
            protected void onPostExecute(Object[] result) {
                Snapshot s = (Snapshot) result[0];
                Bitmap b = (Bitmap) result[1];
                String e = (String) result[2];
                cb.onResult(s, b, e);
            }
        }.execute();
    }

    private static Bitmap fetchPhoto(String urlStr) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(urlStr);
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setUseCaches(false);
            Bitmap raw = BitmapFactory.decodeStream(conn.getInputStream());
            if (raw == null) return null;
            // Downscale so RemoteViews binder doesn't blow the 1MB
            // serialization cap (iOS has a similar archive limit).
            Bitmap scaled = downscale(raw, PHOTO_MAX_EDGE_PX);
            return circleCrop(scaled);
        } catch (Exception e) {
            Log.w(TAG, "photo fetch failed", e);
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static Bitmap downscale(Bitmap src, int maxEdgePx) {
        int w = src.getWidth(), h = src.getHeight();
        int longEdge = Math.max(w, h);
        if (longEdge <= maxEdgePx) return src;
        float scale = (float) maxEdgePx / longEdge;
        return Bitmap.createScaledBitmap(src, Math.round(w * scale), Math.round(h * scale), true);
    }

    private static Bitmap circleCrop(Bitmap src) {
        int side = Math.min(src.getWidth(), src.getHeight());
        // Center-crop to a square first.
        int x = (src.getWidth() - side) / 2;
        int y = (src.getHeight() - side) / 2;
        Bitmap square = Bitmap.createBitmap(src, x, y, side, side);

        Bitmap output = Bitmap.createBitmap(side, side, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(output);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        Rect rect = new Rect(0, 0, side, side);
        RectF rectF = new RectF(rect);
        canvas.drawARGB(0, 0, 0, 0);
        canvas.drawOval(rectF, paint);
        paint.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.SRC_IN));
        canvas.drawBitmap(square, rect, rect, paint);
        return output;
    }
}

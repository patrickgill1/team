package com.firefc.team.widget;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.format.DateUtils;
import android.view.View;
import android.widget.RemoteViews;

import com.firefc.team.R;

import java.util.Locale;

/**
 * Home-screen widget for GoalKickr. Mirrors the iOS PlayerWidget:
 * shows a player snapshot (avatar, name, streak, next event, RSVP).
 *
 * Lifecycle:
 *   1. User drops the widget onto the home screen ->
 *      {@link PlayerWidgetConfigure} runs, asks for the setup code,
 *      stores it in SharedPreferences keyed by widget ID.
 *   2. Android fires {@link #onUpdate}; we read the code, fire a
 *      background fetch via {@link SnapshotFetcher}, render the
 *      result into the appropriate RemoteViews layout (small or
 *      medium based on widget cell count).
 *   3. updatePeriodMillis (player_widget_info.xml) is 30 min — the
 *      minimum Android allows without WorkManager. That matches the
 *      iOS widget's 1-hour cadence closely enough.
 *
 * Tapping the widget opens GoalKickr's MainActivity. Eventually we
 * could deep-link into the player profile or the next event; for v1
 * a plain app launch matches user expectations.
 */
public class PlayerWidgetProvider extends AppWidgetProvider {
    static final String PREFS_NAME = "com.firefc.team.widget.PlayerWidget";
    static final String PREF_PREFIX_KEY = "appwidget_";

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        for (int appWidgetId : appWidgetIds) {
            updateAppWidget(context, appWidgetManager, appWidgetId);
        }
    }

    @Override
    public void onAppWidgetOptionsChanged(Context context, AppWidgetManager appWidgetManager,
                                          int appWidgetId, Bundle newOptions) {
        super.onAppWidgetOptionsChanged(context, appWidgetManager, appWidgetId, newOptions);
        updateAppWidget(context, appWidgetManager, appWidgetId);
    }

    @Override
    public void onDeleted(Context context, int[] appWidgetIds) {
        SharedPreferences.Editor prefs = context
            .getSharedPreferences(PREFS_NAME, 0).edit();
        for (int id : appWidgetIds) {
            prefs.remove(PREF_PREFIX_KEY + id);
        }
        prefs.apply();
    }

    static void updateAppWidget(final Context context, final AppWidgetManager mgr,
                                final int appWidgetId) {
        final SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, 0);
        final String setupCode = prefs.getString(PREF_PREFIX_KEY + appWidgetId, "");

        // Decide layout: medium if the widget is at least 4 cells wide,
        // small otherwise. cell counts come from the options bundle.
        Bundle options = mgr.getAppWidgetOptions(appWidgetId);
        int minWidthDp = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 110);
        boolean useMedium = minWidthDp >= 220;

        // Show the "needs setup" placeholder immediately so the user
        // sees something while the fetch runs. Will be overwritten
        // once snapshot arrives (or stays if setupCode is empty).
        RemoteViews placeholder = renderPlaceholder(context, useMedium, setupCode);
        mgr.updateAppWidget(appWidgetId, placeholder);

        if (setupCode.isEmpty()) return;

        final boolean useMediumFinal = useMedium;
        SnapshotFetcher.fetch(setupCode, new SnapshotFetcher.Callback() {
            @Override
            public void onResult(SnapshotFetcher.Snapshot snapshot, Bitmap photo, String errorCode) {
                RemoteViews views;
                if (snapshot != null) {
                    views = useMediumFinal
                        ? renderMedium(context, snapshot, photo)
                        : renderSmall(context, snapshot, photo);
                } else {
                    views = renderError(context, useMediumFinal, errorCode);
                }
                mgr.updateAppWidget(appWidgetId, views);
            }
        });
    }

    /** Default state when no setup code is stored or while fetching. */
    private static RemoteViews renderPlaceholder(Context context, boolean useMedium, String setupCode) {
        int layoutId = useMedium ? R.layout.widget_player_medium : R.layout.widget_player_small;
        RemoteViews v = new RemoteViews(context.getPackageName(), layoutId);
        attachLaunchIntent(context, v);

        if (useMedium) {
            v.setTextViewText(R.id.widget_player_name_m,
                context.getString(setupCode.isEmpty() ? R.string.widget_needs_setup_title : R.string.app_name));
            v.setTextViewText(R.id.widget_team_name,
                context.getString(setupCode.isEmpty() ? R.string.widget_needs_setup_body : R.string.widget_no_upcoming));
            v.setViewVisibility(R.id.widget_avatar_photo_m, View.GONE);
            v.setTextViewText(R.id.widget_avatar_initials_m, "GK");
            v.setViewVisibility(R.id.widget_avatar_initials_m, View.VISIBLE);
            v.setTextViewText(R.id.widget_streak_label_m, "0d");
            v.setTextViewText(R.id.widget_event_icon, "•");
            v.setTextViewText(R.id.widget_event_title, context.getString(R.string.app_name));
            v.setTextViewText(R.id.widget_event_meta, "");
            v.setTextViewText(R.id.widget_rsvp_pill, "");
        } else {
            v.setTextViewText(R.id.widget_player_name,
                context.getString(setupCode.isEmpty() ? R.string.widget_needs_setup_title : R.string.app_name));
            v.setViewVisibility(R.id.widget_avatar_photo, View.GONE);
            v.setTextViewText(R.id.widget_avatar_initials, "GK");
            v.setViewVisibility(R.id.widget_avatar_initials, View.VISIBLE);
            v.setTextViewText(R.id.widget_streak_label, setupCode.isEmpty() ? "—" : "0d");
        }
        return v;
    }

    private static RemoteViews renderError(Context context, boolean useMedium, String errorCode) {
        int layoutId = useMedium ? R.layout.widget_player_medium : R.layout.widget_player_small;
        RemoteViews v = new RemoteViews(context.getPackageName(), layoutId);
        attachLaunchIntent(context, v);
        String title = "invalid-code".equals(errorCode)
            ? context.getString(R.string.widget_error_invalid_code)
            : context.getString(R.string.widget_error_offline);
        if (useMedium) {
            v.setTextViewText(R.id.widget_player_name_m, title);
            v.setTextViewText(R.id.widget_team_name, "");
            v.setViewVisibility(R.id.widget_avatar_photo_m, View.GONE);
            v.setTextViewText(R.id.widget_avatar_initials_m, "GK");
            v.setViewVisibility(R.id.widget_avatar_initials_m, View.VISIBLE);
            v.setTextViewText(R.id.widget_streak_label_m, "");
            v.setTextViewText(R.id.widget_event_title, "");
            v.setTextViewText(R.id.widget_event_meta, "");
            v.setTextViewText(R.id.widget_rsvp_pill, "");
        } else {
            v.setTextViewText(R.id.widget_player_name, title);
            v.setViewVisibility(R.id.widget_avatar_photo, View.GONE);
            v.setTextViewText(R.id.widget_avatar_initials, "GK");
            v.setViewVisibility(R.id.widget_avatar_initials, View.VISIBLE);
            v.setTextViewText(R.id.widget_streak_label, "");
        }
        return v;
    }

    private static RemoteViews renderSmall(Context context, SnapshotFetcher.Snapshot s, Bitmap photo) {
        RemoteViews v = new RemoteViews(context.getPackageName(), R.layout.widget_player_small);
        attachLaunchIntent(context, v);

        bindAvatar(v, R.id.widget_avatar_photo, R.id.widget_avatar_initials, s.playerName, photo);
        v.setTextViewText(R.id.widget_player_name, firstName(s.playerName));
        v.setTextViewText(R.id.widget_streak_label,
            context.getString(R.string.widget_streak_label_long, s.streakDays));
        return v;
    }

    private static RemoteViews renderMedium(Context context, SnapshotFetcher.Snapshot s, Bitmap photo) {
        RemoteViews v = new RemoteViews(context.getPackageName(), R.layout.widget_player_medium);
        attachLaunchIntent(context, v);

        bindAvatar(v, R.id.widget_avatar_photo_m, R.id.widget_avatar_initials_m, s.playerName, photo);
        v.setTextViewText(R.id.widget_player_name_m, s.playerName);
        v.setTextViewText(R.id.widget_team_name,
            s.teamName != null ? s.teamName.toUpperCase(Locale.getDefault()) : "");
        v.setTextViewText(R.id.widget_streak_label_m,
            context.getString(R.string.widget_streak_label_short, s.streakDays));

        // Upcoming event row. iOS prefers next event over last result;
        // mirror that ordering. "P" / "G" / "T" as event icon stand-ins
        // for the SF Symbols iOS uses — Android RemoteViews can't easily
        // load drawable resources programmatically without extra setup,
        // and these single letters are legible at the 32dp icon size.
        if (s.nextEventTitle != null && s.nextEventDateMs != null) {
            String icon = iconForEventType(s.nextEventType);
            v.setTextViewText(R.id.widget_event_icon, icon);
            v.setTextViewText(R.id.widget_event_title, s.nextEventTitle);
            CharSequence relative = DateUtils.getRelativeTimeSpanString(
                s.nextEventDateMs, System.currentTimeMillis(),
                DateUtils.MINUTE_IN_MILLIS, DateUtils.FORMAT_ABBREV_RELATIVE);
            String meta = relative.toString();
            if (s.nextEventLocation != null && !s.nextEventLocation.isEmpty()) {
                meta = meta + " · " + s.nextEventLocation;
            }
            v.setTextViewText(R.id.widget_event_meta, meta);

            if (s.nextEventRsvp != null) {
                v.setTextViewText(R.id.widget_rsvp_pill, rsvpLabel(context, s.nextEventRsvp));
                v.setInt(R.id.widget_rsvp_pill, "setBackgroundResource",
                    "going".equals(s.nextEventRsvp)
                        ? R.drawable.widget_rsvp_pill_going
                        : R.drawable.widget_rsvp_pill_neutral);
                v.setTextColor(R.id.widget_rsvp_pill,
                    "going".equals(s.nextEventRsvp) ? 0xFFF5F2E8 : 0xA6F5F2E8);
            } else {
                v.setTextViewText(R.id.widget_rsvp_pill, context.getString(R.string.widget_please_rsvp));
                v.setInt(R.id.widget_rsvp_pill, "setBackgroundResource",
                    R.drawable.widget_rsvp_pill_neutral);
                v.setTextColor(R.id.widget_rsvp_pill, 0xA6F5F2E8);
            }
        } else if (s.lastResultTitle != null && s.lastResultScore != null) {
            v.setTextViewText(R.id.widget_event_icon, "★");
            v.setTextViewText(R.id.widget_event_title, s.lastResultScore + " · " + s.lastResultTitle);
            v.setTextViewText(R.id.widget_event_meta, "Last match");
            v.setTextViewText(R.id.widget_rsvp_pill, "");
        } else {
            v.setTextViewText(R.id.widget_event_icon, "•");
            v.setTextViewText(R.id.widget_event_title, context.getString(R.string.widget_no_upcoming));
            v.setTextViewText(R.id.widget_event_meta, "");
            v.setTextViewText(R.id.widget_rsvp_pill, "");
        }
        return v;
    }

    private static void bindAvatar(RemoteViews v, int photoId, int initialsId, String name, Bitmap photo) {
        if (photo != null) {
            v.setImageViewBitmap(photoId, photo);
            v.setViewVisibility(photoId, View.VISIBLE);
            v.setViewVisibility(initialsId, View.GONE);
        } else {
            v.setViewVisibility(photoId, View.GONE);
            v.setTextViewText(initialsId, initials(name));
            v.setViewVisibility(initialsId, View.VISIBLE);
        }
    }

    private static String initials(String name) {
        if (name == null || name.isEmpty()) return "GK";
        String[] parts = name.split(" ");
        String f = parts[0].isEmpty() ? "" : parts[0].substring(0, 1);
        String l = parts.length > 1 && !parts[parts.length - 1].isEmpty()
            ? parts[parts.length - 1].substring(0, 1) : "";
        return (f + l).toUpperCase(Locale.getDefault());
    }

    private static String firstName(String name) {
        if (name == null || name.isEmpty()) return "";
        int sp = name.indexOf(' ');
        return sp > 0 ? name.substring(0, sp) : name;
    }

    private static String iconForEventType(String type) {
        if (type == null) return "•";
        switch (type.toLowerCase(Locale.US)) {
            case "game": return "▲";          // game = play marker
            case "practice": return "P";
            case "tournament": return "★";
            default: return "•";
        }
    }

    private static String rsvpLabel(Context context, String status) {
        switch (status) {
            case "going": return context.getString(R.string.widget_rsvp_going);
            case "maybe": return context.getString(R.string.widget_rsvp_maybe);
            case "no":    return context.getString(R.string.widget_rsvp_no);
            default:      return status.toUpperCase(Locale.getDefault());
        }
    }

    private static void attachLaunchIntent(Context context, RemoteViews v) {
        // Tapping anywhere on the widget opens the app. Two intent
        // targets we know are safe: MainActivity directly, or via
        // the package-name launcher. Use the launcher path so we
        // don't have to hardcode a Capacitor activity class name.
        Intent intent = context.getPackageManager()
            .getLaunchIntentForPackage(context.getPackageName());
        if (intent == null) return;
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent pi = PendingIntent.getActivity(context, 0, intent, flags);
        // Set on both the small and medium layout roots. The wrong ID
        // is a no-op silently; RemoteViews tolerates IDs that aren't
        // in the inflated layout.
        v.setOnClickPendingIntent(R.id.widget_root_small, pi);
        v.setOnClickPendingIntent(R.id.widget_root_medium, pi);
    }
}

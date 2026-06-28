package com.firefc.team.widget;

import android.app.Activity;
import android.appwidget.AppWidgetManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;

import com.firefc.team.R;

/**
 * Setup screen that fires when the widget is dropped on the home
 * screen. Asks for the setupCode (long-lived per-user token from
 * GoalKickr -> Settings -> Widget), stores it in SharedPreferences,
 * pings AppWidgetManager to trigger the first refresh.
 *
 * Cancellation path: if the user backs out without saving, the
 * widget addition is cancelled (RESULT_CANCELED, no widget on home
 * screen). That matches Android best practice for configurable
 * widgets.
 */
public class PlayerWidgetConfigure extends Activity {
    private int appWidgetId = AppWidgetManager.INVALID_APPWIDGET_ID;

    @Override
    public void onCreate(Bundle icicle) {
        super.onCreate(icicle);

        // Default to cancelled until the user explicitly saves.
        setResult(RESULT_CANCELED);

        setContentView(R.layout.widget_configure);

        Intent intent = getIntent();
        Bundle extras = intent.getExtras();
        if (extras != null) {
            appWidgetId = extras.getInt(
                AppWidgetManager.EXTRA_APPWIDGET_ID,
                AppWidgetManager.INVALID_APPWIDGET_ID);
        }
        if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
            finish();
            return;
        }

        // Hydrate any existing code (for reconfigure flow).
        final EditText input = findViewById(R.id.widget_setup_input);
        SharedPreferences prefs = getSharedPreferences(
            PlayerWidgetProvider.PREFS_NAME, 0);
        String existing = prefs.getString(
            PlayerWidgetProvider.PREF_PREFIX_KEY + appWidgetId, "");
        if (!existing.isEmpty()) input.setText(existing);

        Button save = findViewById(R.id.widget_setup_save);
        save.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                String code = input.getText().toString().trim();
                Context ctx = PlayerWidgetConfigure.this;
                SharedPreferences.Editor editor = ctx
                    .getSharedPreferences(PlayerWidgetProvider.PREFS_NAME, 0)
                    .edit();
                editor.putString(PlayerWidgetProvider.PREF_PREFIX_KEY + appWidgetId, code);
                editor.apply();

                AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
                PlayerWidgetProvider.updateAppWidget(ctx, mgr, appWidgetId);

                Intent result = new Intent();
                result.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId);
                setResult(RESULT_OK, result);
                finish();
            }
        });
    }
}

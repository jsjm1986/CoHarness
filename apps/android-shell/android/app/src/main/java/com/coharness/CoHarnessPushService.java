package com.coharness;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;
import org.unifiedpush.android.connector.FailedReason;
import org.unifiedpush.android.connector.PushService;
import org.unifiedpush.android.connector.data.PushEndpoint;
import org.unifiedpush.android.connector.data.PushMessage;

/**
 * Receives UnifiedPush events from the installed distributor: new endpoints feed web-side device
 * registration, messages render a local notification that reuses the session click bridge.
 */
public final class CoHarnessPushService extends PushService {
    private static final String TAG = "CoHarnessPushService";
    private static final String CHANNEL_ID = "ai-replies";
    private static final String UUID_REGEX = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
    static final String UP_PREFERENCES = "coharness.push";
    static final String UP_ENDPOINT = "unifiedpush-endpoint";
    static final String UP_DISTRIBUTOR = "unifiedpush-distributor";

    static String storedEndpoint(Context context) {
        return context.getApplicationContext().getSharedPreferences(UP_PREFERENCES, Context.MODE_PRIVATE)
            .getString(UP_ENDPOINT, "");
    }

    @Override
    public void onNewEndpoint(PushEndpoint endpoint, String instance) {
        if (endpoint == null || endpoint.getUrl() == null || endpoint.getUrl().trim().isEmpty()) return;
        Context context = getApplicationContext();
        context.getSharedPreferences(UP_PREFERENCES, Context.MODE_PRIVATE)
            .edit().putString(UP_ENDPOINT, endpoint.getUrl().trim()).apply();
        NativePushStatusPlugin.emitUnifiedPushEndpoint(endpoint.getUrl().trim());
    }

    @Override
    public void onMessage(PushMessage message, String instance) {
        if (message == null || message.getContent() == null) return;
        handleUpMessage(getApplicationContext(), new String(message.getContent(), StandardCharsets.UTF_8));
    }

    /** Parse one UnifiedPush payload, post the notification, and report the arrival receipt. */
    static void handleUpMessage(Context context, String raw) {
        JSONObject payload;
        try {
            payload = new JSONObject(raw);
        } catch (org.json.JSONException error) {
            return;
        }
        String sessionId = payload.optString("sessionId", "").trim();
        String runtimeId = payload.optString("runtimeId", "").trim();
        String eventSeq = payload.optString("eventSeq", "").trim();
        if (sessionId.isEmpty() || !runtimeId.matches(UUID_REGEX)) return;
        String endpoint = storedEndpoint(context);
        if (!endpoint.isEmpty() && !eventSeq.isEmpty()) {
            PushReceiptReporter.report(context, "unifiedpush", endpoint, runtimeId, sessionId, eventSeq, "arrived");
        }
        String title = payload.optString("title", "").trim();
        String body = payload.optString("body", "").trim();
        postNotification(context, title.isEmpty() ? "AI 回复完成" : title,
            body.isEmpty() ? "点击查看回复" : body, sessionId, runtimeId, eventSeq);
    }

    private static void postNotification(Context context, String title, String body,
        String sessionId, String runtimeId, String eventSeq) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "AI 回复", NotificationManager.IMPORTANCE_HIGH);
            manager.createNotificationChannel(channel);
        }
        String conversation = runtimeId + "/" + sessionId;
        Intent launch = new Intent(context, MainActivity.class)
            .setAction(BuildConfig.APPLICATION_ID + ".OPEN_PUSH." + conversation)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(NativePushStatusPlugin.EXTRA_SESSION_ID, sessionId)
            .putExtra(NativePushStatusPlugin.EXTRA_RUNTIME_ID, runtimeId)
            .putExtra(NativePushStatusPlugin.EXTRA_PUSH_PROVIDER, "unifiedpush");
        if (!eventSeq.isEmpty()) launch.putExtra(NativePushStatusPlugin.EXTRA_EVENT_SEQ, eventSeq);
        PendingIntent content = PendingIntent.getActivity(context, 0, launch,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(content)
            .setPriority(NotificationCompat.PRIORITY_HIGH);
        try {
            manager.notify(conversation, 0, builder.build());
        } catch (SecurityException error) {
            Log.w(TAG, "notification permission missing; dropping UnifiedPush notification", error);
        }
    }

    @Override
    public void onRegistrationFailed(FailedReason reason, String instance) {
        Log.w(TAG, "UnifiedPush registration failed: " + reason);
    }

    @Override
    public void onUnregistered(String instance) {
        Context context = getApplicationContext();
        context.getSharedPreferences(UP_PREFERENCES, Context.MODE_PRIVATE)
            .edit().remove(UP_ENDPOINT).apply();
    }
}

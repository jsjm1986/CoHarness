package com.coharness;

import android.content.Context;
import android.content.Intent;
import cn.jpush.android.api.NotificationMessage;
import cn.jpush.android.service.JPushMessageReceiver;
import org.json.JSONException;
import org.json.JSONObject;

/** Routes a JPush notification click into the existing Capacitor activity. */
public final class CoHarnessPushReceiver extends JPushMessageReceiver {
    @Override
    public void onNotifyMessageOpened(Context context, NotificationMessage message) {
        super.onNotifyMessageOpened(context, message);
        if (message == null) return;
        JSONObject extras;
        try {
            extras = new JSONObject(message.notificationExtras == null ? "{}" : message.notificationExtras);
        } catch (JSONException error) {
            return;
        }
        String sessionId = extras.optString("sessionId", "").trim();
        String runtimeId = extras.optString("runtimeId", "").trim();
        if (sessionId.isEmpty() || !runtimeId.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")) return;

        Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (launch == null) return;
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        launch.putExtra(NativePushStatusPlugin.EXTRA_SESSION_ID, sessionId);
        launch.putExtra(NativePushStatusPlugin.EXTRA_RUNTIME_ID, runtimeId);
        String eventSeq = extras.optString("eventSeq", "").trim();
        if (!eventSeq.isEmpty()) launch.putExtra(NativePushStatusPlugin.EXTRA_EVENT_SEQ, eventSeq);
        context.startActivity(launch);
    }
}

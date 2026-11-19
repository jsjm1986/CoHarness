package com.coharness;

import android.content.Context;
import android.util.Log;
import android.webkit.CookieManager;
import cn.jpush.android.api.JPushInterface;
import cn.jpush.android.api.NotificationMessage;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** Reports JPush arrival and open outcomes to the Gateway over the wrapped WebView's session. */
public final class PushReceiptReporter {
    private static final String TAG = "PushReceiptReporter";

    /** Test seam: instrumentation replaces the transport instead of standing up a Gateway. */
    public interface Sink {
        void post(JSONObject payload);
    }

    private static volatile Sink sink = PushReceiptReporter::postToGateway;

    public static void setSink(Sink replacement) {
        sink = replacement == null ? PushReceiptReporter::postToGateway : replacement;
    }

    /** Parse a JPush notification and report the outcome; malformed extras are dropped. */
    public static void reportMessage(Context context, String kind, NotificationMessage message) {
        if (!BuildConfig.NATIVE_PUSH_ENABLED || context == null || message == null) return;
        JSONObject extras;
        try {
            extras = new JSONObject(message.notificationExtras == null ? "{}" : message.notificationExtras);
        } catch (org.json.JSONException error) {
            return;
        }
        String sessionId = extras.optString("sessionId", "").trim();
        String eventSeq = extras.optString("eventSeq", "").trim();
        if (sessionId.isEmpty() || eventSeq.isEmpty()) return;
        String token;
        try {
            token = JPushInterface.getRegistrationID(context);
        } catch (RuntimeException error) {
            token = "";
        }
        report(context, "jpush", token == null ? "" : token.trim(), sessionId, eventSeq, kind);
    }

    /** Post one outcome receipt; empty token or malformed sequence drops silently. */
    public static void report(Context context, String provider, String token,
        String sessionId, String eventSeq, String kind) {
        if (!BuildConfig.NATIVE_PUSH_ENABLED || context == null || token.isEmpty()) return;
        JSONObject payload = new JSONObject();
        try {
            payload.put("provider", provider);
            payload.put("token", token);
            payload.put("sessionId", sessionId);
            payload.put("eventSeq", Long.parseLong(eventSeq));
            payload.put("kind", kind);
        } catch (org.json.JSONException | NumberFormatException error) {
            return;
        }
        Sink active = sink;
        new Thread(() -> {
            try { active.post(payload); }
            catch (RuntimeException error) { Log.w(TAG, "push receipt report failed", error); }
        }, "push-receipt").start();
    }

    private static void postToGateway(JSONObject payload) {
        String origin = BuildConfig.PUSH_GATEWAY_ORIGIN;
        if (origin == null || origin.trim().isEmpty()) return;
        String endpoint = origin.replaceAll("/+$", "") + "/account/api/push-receipts";
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(endpoint).openConnection();
            connection.setConnectTimeout(5_000);
            connection.setReadTimeout(5_000);
            connection.setRequestMethod("POST");
            connection.setRequestProperty("content-type", "application/json");
            String cookies;
            try {
                cookies = CookieManager.getInstance().getCookie(origin);
            } catch (RuntimeException error) {
                cookies = null;
            }
            if (cookies != null && !cookies.trim().isEmpty()) {
                connection.setRequestProperty("cookie", cookies);
            }
            connection.setDoOutput(true);
            byte[] body = payload.toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream stream = connection.getOutputStream()) {
                stream.write(body);
            }
            int status = connection.getResponseCode();
            if (status >= 400) {
                Log.w(TAG, "push receipt rejected with HTTP " + status);
            }
        } catch (java.io.IOException error) {
            Log.w(TAG, "push receipt transport failed", error);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private PushReceiptReporter() {}
}

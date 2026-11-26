package com.coharness;

import static org.junit.Assert.*;
import android.content.Intent;
import android.os.SystemClock;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import cn.jpush.android.api.NotificationMessage;
import com.getcapacitor.JSObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.json.JSONObject;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/** Exercises the ordinary variant's notification Intent on a real Android runtime. */
@RunWith(AndroidJUnit4.class)
public class NativePushBridgeTest {
    @Test
    public void realActivityDeliversLaunchIntentThroughTheWebViewBridge() throws Exception {
        String session = UUID.randomUUID().toString();
        Intent intent = new Intent(InstrumentationRegistry.getInstrumentation().getTargetContext(), MainActivity.class)
            .putExtra(NativePushStatusPlugin.EXTRA_SESSION_ID, session)
            .putExtra(NativePushStatusPlugin.EXTRA_RUNTIME_ID, "a1b2c3d4-e5f6-7890-abcd-ef1234567890")
            .putExtra(NativePushStatusPlugin.EXTRA_EVENT_SEQ, "42");
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(intent)) {
            long deadline = SystemClock.elapsedRealtime() + 20_000;
            JSONObject observed = null;
            while (SystemClock.elapsedRealtime() < deadline && observed == null) {
                HttpURLConnection connection = (HttpURLConnection) new URL("http://127.0.0.1:38761/observed?session=" + session).openConnection();
                connection.setConnectTimeout(2_000);
                connection.setReadTimeout(2_000);
                try {
                    String body = new String(connection.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
                    observed = new JSONObject(body).optJSONObject("observed");
                } finally { connection.disconnect(); }
                if (observed == null) SystemClock.sleep(50);
            }
            assertNotNull("MainActivity must deliver through the real Capacitor listener", observed);
            assertEquals(session, observed.getJSONObject("payload").getString("sessionId"));
            assertEquals("a1b2c3d4-e5f6-7890-abcd-ef1234567890", observed.getJSONObject("payload").getString("runtimeId"));
            assertEquals("42", observed.getJSONObject("payload").getString("eventSeq"));
        }
    }

    private static class Listener extends NativePushStatusPlugin {
        int deliveries;
        String event;
        JSObject payload;
        boolean retained;

        @Override
        protected void notifyListeners(String name, JSObject data, boolean retainUntilConsumed) {
            deliveries++;
            event = name;
            payload = data;
            retained = retainUntilConsumed;
        }
    }

    @Test
    public void coldStartDeliversSessionOnceAndRetainsUntilWebListener() {
        assertTrue("diagnostic APKs cannot supply native proof", BuildConfig.NATIVE_PUSH_ENABLED);
        assertEquals("com.coharness", InstrumentationRegistry.getInstrumentation().getTargetContext().getPackageName());
        Listener listener = new Listener();
        Intent intent = new Intent()
            .putExtra(NativePushStatusPlugin.EXTRA_SESSION_ID, " session-17 ")
            .putExtra(NativePushStatusPlugin.EXTRA_RUNTIME_ID, " a1b2c3d4-e5f6-7890-abcd-ef1234567890 ")
            .putExtra(NativePushStatusPlugin.EXTRA_EVENT_SEQ, " 42 ");
        listener.handleInitialIntent(intent);
        assertEquals("notificationAction", listener.event);
        assertEquals("session-17", listener.payload.getString("sessionId"));
        assertEquals("a1b2c3d4-e5f6-7890-abcd-ef1234567890", listener.payload.getString("runtimeId"));
        assertEquals("42", listener.payload.getString("eventSeq"));
        assertTrue(listener.retained);
        assertFalse(intent.hasExtra(NativePushStatusPlugin.EXTRA_SESSION_ID));
        assertFalse(intent.hasExtra(NativePushStatusPlugin.EXTRA_RUNTIME_ID));
        listener.handleInitialIntent(intent);
        assertEquals(1, listener.deliveries);
    }

    @Test
    public void warmStartUsesTheSamePayloadAndRejectsEmptySessions() {
        Listener listener = new Listener();
        listener.handleOnNewIntent(new Intent().putExtra(NativePushStatusPlugin.EXTRA_SESSION_ID, " "));
        listener.handleInitialIntent(null);
        listener.handleOnNewIntent(new Intent()
            .putExtra(NativePushStatusPlugin.EXTRA_SESSION_ID, "warm-session")
            .putExtra(NativePushStatusPlugin.EXTRA_RUNTIME_ID, " "));
        listener.handleOnNewIntent(new Intent().putExtra(NativePushStatusPlugin.EXTRA_SESSION_ID, "warm-session"));
        assertEquals(0, listener.deliveries);
        listener.handleOnNewIntent(new Intent()
            .putExtra(NativePushStatusPlugin.EXTRA_SESSION_ID, "warm-session")
            .putExtra(NativePushStatusPlugin.EXTRA_RUNTIME_ID, "a1b2c3d4-e5f6-7890-abcd-ef1234567890"));
        assertEquals("warm-session", listener.payload.getString("sessionId"));
        assertEquals("a1b2c3d4-e5f6-7890-abcd-ef1234567890", listener.payload.getString("runtimeId"));
        assertFalse(listener.payload.has("eventSeq"));
    }

    private static List<JSONObject> awaitReceipt(List<JSONObject> captured) throws Exception {
        return awaitReceipt(captured, 5_000);
    }

    private static List<JSONObject> awaitReceipt(List<JSONObject> captured, long timeoutMs) throws Exception {
        long deadline = SystemClock.elapsedRealtime() + timeoutMs;
        while (captured.isEmpty() && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(25);
        return captured;
    }

    private static NotificationMessage notification(String sessionId, String eventSeq) throws Exception {
        NotificationMessage message = new NotificationMessage();
        message.notificationExtras = new JSONObject()
            .put("sessionId", sessionId)
            .put("runtimeId", UUID.randomUUID().toString())
            .put("eventSeq", eventSeq)
            .toString();
        return message;
    }

    @Test
    public void arrivalReportsThroughTheReceiptSink() throws Exception {
        assertTrue("diagnostic APKs cannot supply native proof", BuildConfig.NATIVE_PUSH_ENABLED);
        List<JSONObject> captured = new ArrayList<>();
        PushReceiptReporter.setSink(captured::add);
        try {
            new CoHarnessPushReceiver().onNotifyMessageArrived(
                InstrumentationRegistry.getInstrumentation().getTargetContext(),
                notification("arrival-session", "41"));
            List<JSONObject> receipts = awaitReceipt(captured);
            assertEquals(1, receipts.size());
            JSONObject payload = receipts.get(0);
            assertEquals("arrived", payload.getString("kind"));
            assertEquals("jpush", payload.getString("provider"));
            assertEquals("arrival-session", payload.getString("sessionId"));
            assertEquals(41L, payload.getLong("eventSeq"));
            assertTrue(payload.has("token"));
        } finally {
            PushReceiptReporter.setSink(null);
        }
    }

    @Test
    public void openedReportsThroughTheReceiptSink() throws Exception {
        List<JSONObject> captured = new ArrayList<>();
        PushReceiptReporter.setSink(captured::add);
        try {
            PushReceiptReporter.reportMessage(
                InstrumentationRegistry.getInstrumentation().getTargetContext(),
                "opened", notification("opened-session", "42"));
            JSONObject payload = awaitReceipt(captured).get(0);
            assertEquals("opened", payload.getString("kind"));
            assertEquals("opened-session", payload.getString("sessionId"));
            assertEquals(42L, payload.getLong("eventSeq"));
        } finally {
            PushReceiptReporter.setSink(null);
        }
    }

    @Test
    public void unifiedpushMessageReportsArrivedAndDropsMalformed() throws Exception {
        android.content.Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String endpoint = "https://ntfy.example.com/upTESTTOKEN";
        context.getSharedPreferences(CoHarnessPushService.UP_PREFERENCES, android.content.Context.MODE_PRIVATE)
            .edit().putString(CoHarnessPushService.UP_ENDPOINT, endpoint).apply();
        List<JSONObject> captured = new ArrayList<>();
        PushReceiptReporter.setSink(captured::add);
        try {
            String runtimeId = UUID.randomUUID().toString();
            CoHarnessPushService.handleUpMessage(context, new JSONObject()
                .put("title", "AI 回复完成").put("body", "点击查看回复")
                .put("sessionId", "up-arrival-session").put("runtimeId", runtimeId)
                .put("eventSeq", "77").toString());
            List<JSONObject> receipts = awaitReceipt(captured);
            assertEquals(1, receipts.size());
            JSONObject payload = receipts.get(0);
            assertEquals("arrived", payload.getString("kind"));
            assertEquals("unifiedpush", payload.getString("provider"));
            assertEquals(endpoint, payload.getString("token"));
            assertEquals("up-arrival-session", payload.getString("sessionId"));
            assertEquals(runtimeId, payload.getString("runtimeId"));
            assertEquals(77L, payload.getLong("eventSeq"));
            CoHarnessPushService.handleUpMessage(context, "{not-json");
            CoHarnessPushService.handleUpMessage(context, new JSONObject()
                .put("sessionId", "no-runtime").toString());
            CoHarnessPushService.handleUpMessage(context, new JSONObject()
                .put("sessionId", "no-seq").put("runtimeId", runtimeId).toString());
            SystemClock.sleep(300);
            assertEquals(1, captured.size());
        } finally {
            PushReceiptReporter.setSink(null);
            context.getSharedPreferences(CoHarnessPushService.UP_PREFERENCES, android.content.Context.MODE_PRIVATE)
                .edit().remove(CoHarnessPushService.UP_ENDPOINT).apply();
        }
    }

    @Test
    public void unifiedpushLaunchIntentReportsOpenedOnce() throws Exception {
        android.content.Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String endpoint = "https://ntfy.example.com/upTESTTOKEN";
        context.getSharedPreferences(CoHarnessPushService.UP_PREFERENCES, android.content.Context.MODE_PRIVATE)
            .edit().putString(CoHarnessPushService.UP_ENDPOINT, endpoint).apply();
        List<JSONObject> captured = new ArrayList<>();
        PushReceiptReporter.setSink(captured::add);
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(
            new Intent(context, MainActivity.class)
                .putExtra(NativePushStatusPlugin.EXTRA_SESSION_ID, "up-opened-session")
                .putExtra(NativePushStatusPlugin.EXTRA_RUNTIME_ID, "a1b2c3d4-e5f6-7890-abcd-ef1234567890")
                .putExtra(NativePushStatusPlugin.EXTRA_EVENT_SEQ, "88")
                .putExtra(NativePushStatusPlugin.EXTRA_PUSH_PROVIDER, "unifiedpush"))) {
            List<JSONObject> receipts = awaitReceipt(captured);
            assertEquals(1, receipts.size());
            JSONObject payload = receipts.get(0);
            assertEquals("opened", payload.getString("kind"));
            assertEquals("unifiedpush", payload.getString("provider"));
            assertEquals(endpoint, payload.getString("token"));
            assertEquals("a1b2c3d4-e5f6-7890-abcd-ef1234567890", payload.getString("runtimeId"));
            assertEquals(88L, payload.getLong("eventSeq"));
        } finally {
            PushReceiptReporter.setSink(null);
            context.getSharedPreferences(CoHarnessPushService.UP_PREFERENCES, android.content.Context.MODE_PRIVATE)
                .edit().remove(CoHarnessPushService.UP_ENDPOINT).apply();
        }
    }

    @Test
    public void unifiedpushRealDistributorDeliversPostedMessage() throws Exception {
        android.content.Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        java.util.List<String> distributors = org.unifiedpush.android.connector.UnifiedPush.getDistributors(context);
        org.junit.Assume.assumeTrue("no UnifiedPush distributor installed", !distributors.isEmpty());
        org.unifiedpush.android.connector.UnifiedPush.saveDistributor(context, distributors.get(0));
        try {
            org.unifiedpush.android.connector.UnifiedPush.register(
                context, org.unifiedpush.android.connector.ConstantsKt.INSTANCE_DEFAULT, null, null);
            String endpoint = null;
            long deadline = SystemClock.elapsedRealtime() + 15_000;
            while (SystemClock.elapsedRealtime() < deadline && endpoint == null) {
                String stored = CoHarnessPushService.storedEndpoint(context);
                if (!stored.isEmpty()) endpoint = stored;
                else SystemClock.sleep(100);
            }
            assertNotNull("distributor must issue an endpoint", endpoint);
            List<JSONObject> captured = new ArrayList<>();
            PushReceiptReporter.setSink(captured::add);
            try {
                String runtimeId = UUID.randomUUID().toString();
                String payload = new JSONObject()
                    .put("title", "AI 回复完成").put("body", "点击查看回复")
                    .put("sessionId", "up-e2e-session").put("runtimeId", runtimeId)
                    .put("eventSeq", "99").toString();
                String deliveryEndpoint = endpoint;
                new Thread(() -> {
                    try {
                        HttpURLConnection connection = (HttpURLConnection) new URL(deliveryEndpoint).openConnection();
                        connection.setRequestMethod("POST");
                        connection.setRequestProperty("content-type", "application/json");
                        connection.setConnectTimeout(10_000);
                        connection.setReadTimeout(10_000);
                        connection.setDoOutput(true);
                        connection.getOutputStream().write(payload.getBytes(StandardCharsets.UTF_8));
                        connection.getOutputStream().close();
                        connection.getInputStream().close();
                        connection.disconnect();
                    } catch (Exception error) {
                        throw new RuntimeException(error);
                    }
                }).join(15_000);
                List<JSONObject> receipts = awaitReceipt(captured, 30_000);
                assertEquals(1, receipts.size());
                JSONObject receipt = receipts.get(0);
                assertEquals("arrived", receipt.getString("kind"));
                assertEquals("unifiedpush", receipt.getString("provider"));
                assertEquals("up-e2e-session", receipt.getString("sessionId"));
                assertEquals(99L, receipt.getLong("eventSeq"));
            } finally {
                PushReceiptReporter.setSink(null);
            }
        } finally {
            context.getSharedPreferences(CoHarnessPushService.UP_PREFERENCES, android.content.Context.MODE_PRIVATE)
                .edit().remove(CoHarnessPushService.UP_ENDPOINT).apply();
        }
    }

    @Test
    public void malformedExtrasAndBadSequencesReportNothing() throws Exception {
        List<JSONObject> captured = new ArrayList<>();
        PushReceiptReporter.setSink(captured::add);
        try {
            android.content.Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
            NotificationMessage malformed = new NotificationMessage();
            malformed.notificationExtras = "{not-json";
            PushReceiptReporter.reportMessage(context, "arrived", malformed);
            PushReceiptReporter.reportMessage(context, "arrived", notification("missing-seq", ""));
            PushReceiptReporter.reportMessage(context, "arrived", notification("bad-seq-session", "not-a-number"));
            SystemClock.sleep(300);
            assertTrue(captured.isEmpty());
        } finally {
            PushReceiptReporter.setSink(null);
        }
    }
}

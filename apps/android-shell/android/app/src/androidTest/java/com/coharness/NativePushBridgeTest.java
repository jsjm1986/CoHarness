package com.coharness;

import static org.junit.Assert.*;
import android.content.Intent;
import android.os.SystemClock;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.JSObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.json.JSONObject;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

/** Exercises the ordinary variant's notification Intent on a real Android runtime. */
@RunWith(AndroidJUnit4.class)
public class NativePushBridgeTest {
    @Test
    public void realActivityDeliversLaunchIntentThroughTheWebViewBridge() throws Exception {
        String session = UUID.randomUUID().toString();
        Intent intent = new Intent(InstrumentationRegistry.getInstrumentation().getTargetContext(), MainActivity.class)
            .putExtra(NativePushStatusPlugin.EXTRA_SESSION_ID, session)
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
            .putExtra(NativePushStatusPlugin.EXTRA_EVENT_SEQ, " 42 ");
        listener.handleInitialIntent(intent);
        assertEquals("notificationAction", listener.event);
        assertEquals("session-17", listener.payload.getString("sessionId"));
        assertEquals("42", listener.payload.getString("eventSeq"));
        assertTrue(listener.retained);
        assertFalse(intent.hasExtra(NativePushStatusPlugin.EXTRA_SESSION_ID));
        listener.handleInitialIntent(intent);
        assertEquals(1, listener.deliveries);
    }

    @Test
    public void warmStartUsesTheSamePayloadAndRejectsEmptySessions() {
        Listener listener = new Listener();
        listener.handleOnNewIntent(new Intent().putExtra(NativePushStatusPlugin.EXTRA_SESSION_ID, " "));
        listener.handleInitialIntent(null);
        assertEquals(0, listener.deliveries);
        listener.handleOnNewIntent(new Intent().putExtra(NativePushStatusPlugin.EXTRA_SESSION_ID, "warm-session"));
        assertEquals("warm-session", listener.payload.getString("sessionId"));
        assertFalse(listener.payload.has("eventSeq"));
    }
}

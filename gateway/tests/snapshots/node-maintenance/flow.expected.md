# Managed node control during maintenance

Three authenticated heartbeats: HTTP 200; same node and connection epoch; no business writer admitted; writers quiesced.
Release and reconnect: HTTP 204 then 200; exactly one successor epoch; lost-response retry retains it; old heartbeat and release return 409.
Pending attachment and enrollment: HTTP 503; attachment and topology unchanged.
New personal Runtime and message submission: HTTP 503; zero launches; Runtime records unchanged.
Restore in progress: HTTP 503; control lease cannot bypass the restore fence.

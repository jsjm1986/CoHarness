-- The question/requested frame carries `wait.callId` on the wire, but it is
-- not a logged session event, so the rpcId-to-callId link was dropped when a
-- response was claimed. Keeping the callId lets readers join a claimed
-- question back to its tool/call (question text) and tool/result (log anchor)
-- rows in conversation_events. Claims written before this column keep NULL.
ALTER TABLE harness.conversation_interaction_responses
  ADD COLUMN call_id text;

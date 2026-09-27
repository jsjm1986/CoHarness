-- Writer convergence must count in-flight work, not just gate admissions: a
-- mutating request or periodic sweep that passed the write gate before
-- maintenance entered keeps writing until it finishes. Nodes report their
-- in-flight writer count on every heartbeat; the applier treats a live node
-- as quiesced only once it acknowledged the maintenance epoch AND reports
-- zero writers in flight.
--
-- The default is -1 ("never reported") rather than 0 so a node running an
-- older build that predates this column cannot look quiesced while it still
-- holds pre-maintenance work — the operator must drain or stop it before a
-- restore opens.
ALTER TABLE harness.compute_nodes
  ADD COLUMN inflight_writes bigint NOT NULL DEFAULT -1 CHECK (inflight_writes >= -1);

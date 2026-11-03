-- Node-reported execution capability: whether the computer's configured local
-- Gateway can actually allocate Runtimes. Connectivity alone keeps it false.
ALTER TABLE harness.node_agents ADD COLUMN execution_ready boolean NOT NULL DEFAULT false;

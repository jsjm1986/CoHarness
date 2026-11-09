-- Every Gateway publishes its Ed25519 principal public key on its own
-- compute_nodes row so peer gateways can verify forwarded-request assertions
-- instead of re-running the issuing side's session and permission queries.
-- The trust boundary matches the existing one: any organization node holding
-- an active agent lease may issue, because the same lease already grants
-- full database credentials.
ALTER TABLE harness.compute_nodes ADD COLUMN principal_public_key text;

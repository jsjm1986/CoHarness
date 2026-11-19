-- Device-reported push outcomes: provider message correlation, arrival, and open receipts.
ALTER TABLE harness.push_deliveries
  ADD COLUMN provider_msg_id text,
  ADD COLUMN delivered_at timestamptz,
  ADD COLUMN opened_at timestamptz;

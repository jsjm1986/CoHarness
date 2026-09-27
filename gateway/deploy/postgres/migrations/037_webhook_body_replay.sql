-- Delivery aliases keep transport retries idempotent after the body window expires.
ALTER TABLE harness.webhook_delivery_receipts
  ADD CONSTRAINT webhook_receipt_endpoint_identity UNIQUE (organization_id,endpoint_id,id);
CREATE INDEX webhook_receipts_body ON harness.webhook_delivery_receipts
  (organization_id,endpoint_id,request_hash,received_at DESC);

CREATE TABLE harness.webhook_delivery_aliases (
  organization_id uuid NOT NULL,
  endpoint_id uuid NOT NULL,
  delivery_id text NOT NULL CHECK (length(delivery_id) BETWEEN 1 AND 256),
  receipt_id uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,endpoint_id,delivery_id),
  FOREIGN KEY (organization_id,endpoint_id,receipt_id)
    REFERENCES harness.webhook_delivery_receipts(organization_id,endpoint_id,id)
);

-- Preserve the source identity and catalogue metadata when an approved account's existing directory stays in place.
ALTER TABLE node_content.document_entries ADD COLUMN previously_legacy boolean;
CREATE TABLE node_content.personal_document_imports(
  organization_id uuid NOT NULL,node_id uuid NOT NULL,user_id uuid NOT NULL,root_id uuid PRIMARY KEY,volume_id uuid NOT NULL,
  catalog_digest text NOT NULL CHECK(catalog_digest~'^[a-f0-9]{64}$'),physical_digest text NOT NULL CHECK(physical_digest~'^[a-f0-9]{64}$'),
  source_count bigint NOT NULL CHECK(source_count>=0),history_count bigint NOT NULL CHECK(history_count>=0),
  sequence bigint NOT NULL CHECK(sequence>=0),ordinal integer NOT NULL CHECK(ordinal>=0),UNIQUE(organization_id,node_id,user_id),
  FOREIGN KEY(organization_id,root_id) REFERENCES node_content.document_roots(organization_id,root_id)
);
-- The application cannot set arbitrary sequence numbers. Only the maximum committed/restored audit ordinal may advance it.
CREATE FUNCTION node_content.advance_document_event_sequence() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s regclass;maximum bigint;
BEGIN
  LOCK TABLE node_content.document_events IN SHARE ROW EXCLUSIVE MODE NOWAIT;
  SELECT max(id) INTO maximum FROM node_content.document_events;
  IF maximum IS NOT NULL THEN
    s:=pg_get_serial_sequence('node_content.document_events','id')::regclass;
    PERFORM setval(s,greatest(coalesce(pg_sequence_last_value(s),1),maximum),true);
  END IF;
END $$;

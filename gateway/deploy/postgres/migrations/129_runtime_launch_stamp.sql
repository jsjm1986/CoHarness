-- The launch stamp records the content-addressed identity of the code and
-- launch inputs a generation was started with; a surviving process may be
-- re-attached only while its recorded stamp remains mintable by the running
-- Gateway build. Rows written before stamps existed keep NULL and are fenced
-- as incompatible until their next generation is claimed.
ALTER TABLE harness.instances ADD COLUMN launch_stamp text;

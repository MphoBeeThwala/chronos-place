-- Consent history is append-only (TASKS M1.2). A withdrawal is a new row; no row is ever changed.
-- Deletes stay possible because account erasure must remove the history (CLAUDE.md rule 10).
CREATE FUNCTION "identity"."consent_records_no_update"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'consent records are append-only' USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "consent_records_no_update"
  BEFORE UPDATE ON "identity"."consent_records"
  FOR EACH ROW EXECUTE FUNCTION "identity"."consent_records_no_update"();

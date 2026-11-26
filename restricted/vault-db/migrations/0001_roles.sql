-- Health Vault roles, grants and the append-only audit log (TECHNICAL_SPEC §3.3, M2.1).
--
-- vault_owner         owns the vault schema and tables. Used only to run migrations; nobody
--                     logs in as it. No runtime code uses it.
-- disclosure_service  the Disclosure Service at runtime. Privileges on vault tables only.
--
-- Both roles are created WITHOUT LOGIN and without a password: infrastructure decides how the
-- service authenticates (a password from the environment locally, IAM auth in deployed
-- environments), so no secret ever appears in a migration. No human role gets standing access.
--
-- Roles are cluster-wide, so they are created only if missing; grants below are per database.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vault_owner') THEN
    CREATE ROLE vault_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'disclosure_service') THEN
    CREATE ROLE disclosure_service NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint

-- The migrating user joins vault_owner so it can hand objects over and run later migrations.
GRANT vault_owner TO CURRENT_USER;
--> statement-breakpoint

-- Nothing in this database is open to PUBLIC.
DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO disclosure_service', current_database());
END
$$;
--> statement-breakpoint
REVOKE ALL ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON SCHEMA vault FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA vault FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON ALL SEQUENCES IN SCHEMA vault FROM PUBLIC;
--> statement-breakpoint

ALTER SCHEMA vault OWNER TO vault_owner;
--> statement-breakpoint
ALTER TABLE vault.subject_map OWNER TO vault_owner;
--> statement-breakpoint
ALTER TABLE vault.subject_keys OWNER TO vault_owner;
--> statement-breakpoint
ALTER TABLE vault.condition_taxonomy OWNER TO vault_owner;
--> statement-breakpoint
ALTER TABLE vault.health_profiles OWNER TO vault_owner;
--> statement-breakpoint
ALTER TABLE vault.filter_preferences OWNER TO vault_owner;
--> statement-breakpoint
ALTER TABLE vault.disclosure_grants OWNER TO vault_owner;
--> statement-breakpoint
ALTER TABLE vault.health_access_log OWNER TO vault_owner;
--> statement-breakpoint

-- Runtime privileges. DELETE is for erasure (M2.7) and revocation clean-up; never on the log.
GRANT USAGE ON SCHEMA vault TO disclosure_service;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON
  vault.subject_map,
  vault.subject_keys,
  vault.health_profiles,
  vault.filter_preferences,
  vault.disclosure_grants
TO disclosure_service;
--> statement-breakpoint
-- Reference data: changed only by migrations.
GRANT SELECT ON vault.condition_taxonomy TO disclosure_service;
--> statement-breakpoint
-- The audit log: read (for "who has seen my health information", M2.8) and append, nothing else.
GRANT SELECT, INSERT ON vault.health_access_log TO disclosure_service;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE vault.health_access_log_id_seq TO disclosure_service;
--> statement-breakpoint

-- Append-only for every role, the owner included: the grants above are the first lock, this
-- trigger the second. Only the table owner could disable it, and nobody runs as the owner.
CREATE FUNCTION vault.health_access_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'health_access_log is append-only' USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
ALTER FUNCTION vault.health_access_log_append_only() OWNER TO vault_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION vault.health_access_log_append_only() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER health_access_log_no_change
  BEFORE UPDATE OR DELETE ON vault.health_access_log
  FOR EACH ROW EXECUTE FUNCTION vault.health_access_log_append_only();
--> statement-breakpoint
CREATE TRIGGER health_access_log_no_truncate
  BEFORE TRUNCATE ON vault.health_access_log
  FOR EACH STATEMENT EXECUTE FUNCTION vault.health_access_log_append_only();

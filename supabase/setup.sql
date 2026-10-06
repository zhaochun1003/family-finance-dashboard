-- Run once in your own Supabase SQL Editor. Replace the placeholder locally.
-- No financial data or real email address belongs in this repository.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE SCHEMA IF NOT EXISTS finance_private;
REVOKE ALL ON SCHEMA finance_private FROM PUBLIC, anon, authenticated;
CREATE TABLE IF NOT EXISTS finance_private.allowed_emails (email text PRIMARY KEY CHECK (email=lower(email)));
ALTER TABLE finance_private.allowed_emails ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON finance_private.allowed_emails FROM PUBLIC, anon, authenticated;
-- INSERT INTO finance_private.allowed_emails VALUES ('YOUR_VERIFIED_EMAIL') ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.finance_is_owner() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM auth.users u JOIN finance_private.allowed_emails a ON a.email=lower(u.email)
    WHERE u.id=(SELECT auth.uid()) AND u.email_confirmed_at IS NOT NULL
  );
$$;
REVOKE ALL ON FUNCTION public.finance_is_owner() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finance_is_owner() TO authenticated;

CREATE TABLE IF NOT EXISTS public.finance_snapshots (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id), revision integer NOT NULL CHECK (revision>0),
  payload text NOT NULL CHECK (octet_length(payload)<=1500000), digest text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.finance_snapshot_history (
  user_id uuid NOT NULL REFERENCES auth.users(id), revision integer NOT NULL,
  payload text NOT NULL, digest text NOT NULL, updated_at timestamptz NOT NULL,
  PRIMARY KEY (user_id,revision)
);
ALTER TABLE public.finance_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_snapshot_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.finance_snapshots, public.finance_snapshot_history FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.finance_snapshots, public.finance_snapshot_history TO authenticated;
CREATE POLICY finance_owner_read ON public.finance_snapshots FOR SELECT TO authenticated
  USING (user_id=(SELECT auth.uid()) AND (SELECT public.finance_is_owner()));
CREATE POLICY finance_owner_history_read ON public.finance_snapshot_history FOR SELECT TO authenticated
  USING (user_id=(SELECT auth.uid()) AND (SELECT public.finance_is_owner()));

-- Only this guarded function may write: REST clients cannot bypass revision checks.
CREATE OR REPLACE FUNCTION public.finance_write_snapshot(p_revision integer,p_payload text,p_digest text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE owner uuid := auth.uid(); old public.finance_snapshots%ROWTYPE; result jsonb;
BEGIN
  IF owner IS NULL OR NOT public.finance_is_owner() THEN
    RAISE EXCEPTION 'FINANCE_ACCESS_DENIED' USING ERRCODE='42501';
  END IF;
  IF p_revision IS NULL OR p_revision<0 OR p_revision>=2147483647 OR p_payload IS NULL
    OR octet_length(p_payload)=0 OR octet_length(p_payload)>1500000
    OR p_payload !~ '^[A-Za-z0-9+/]+={0,2}$' OR length(p_payload)%4<>0
    OR p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$'
    OR encode(extensions.digest(p_payload,'sha256'),'hex')<>p_digest THEN
    RAISE EXCEPTION 'FINANCE_INVALID_PAYLOAD' USING ERRCODE='22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(owner::text,0));
  SELECT * INTO old FROM public.finance_snapshots WHERE user_id=owner FOR UPDATE;
  IF coalesce(old.revision,0)<>p_revision THEN RAISE EXCEPTION 'FINANCE_CONFLICT'; END IF;
  IF old.revision IS NOT NULL THEN
    INSERT INTO public.finance_snapshot_history VALUES (old.user_id,old.revision,old.payload,old.digest,old.updated_at);
  END IF;
  INSERT INTO public.finance_snapshots(user_id,revision,payload,digest,updated_at)
    VALUES(owner,p_revision+1,p_payload,p_digest,now())
    ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,digest=excluded.digest,updated_at=excluded.updated_at;
  DELETE FROM public.finance_snapshot_history WHERE user_id=owner AND revision<p_revision-9;
  SELECT jsonb_build_object('revision',revision,'digest',digest,'updated_at',updated_at) INTO result
    FROM public.finance_snapshots WHERE user_id=owner;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.finance_write_snapshot(integer,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finance_write_snapshot(integer,text,text) TO authenticated;
COMMIT;

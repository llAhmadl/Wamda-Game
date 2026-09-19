BEGIN;

-- Run manually in the Supabase SQL Editor as the postgres role.
-- This migration does not overwrite or delete existing question banks.
CREATE TABLE IF NOT EXISTS public.wamda_banks (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data JSONB NOT NULL CHECK (
        (jsonb_typeof(data) = 'object'
        AND jsonb_typeof(data -> 'banks') = 'array'
        AND jsonb_typeof(data -> 'activeBankId') = 'string'
        AND jsonb_typeof(data -> 'revision') = 'number'
        AND (data ->> 'revision') ~ '^[0-9]+$') IS TRUE
    )
);

-- Browser/API roles cannot read answers or manage banks directly.
-- The server connects through DATABASE_URL as the table owner (postgres).
ALTER TABLE public.wamda_banks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.wamda_banks FROM PUBLIC;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON TABLE public.wamda_banks FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON TABLE public.wamda_banks FROM authenticated;
    END IF;
END $$;

COMMIT;

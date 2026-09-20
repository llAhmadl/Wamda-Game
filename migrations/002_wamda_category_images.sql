BEGIN;

-- Run manually in Supabase SQL Editor as postgres. Safe to run repeatedly.
-- Existing banks stay in wamda_banks JSONB. The application upgrades their
-- schemaVersion to 2 using revision-checked writes and preserves every question.
-- Small decoded, resized WebP assets use binary storage, never Base64.
CREATE TABLE IF NOT EXISTS public.wamda_category_images (
    id UUID PRIMARY KEY,
    data BYTEA NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 524288),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.wamda_category_images ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.wamda_category_images FROM PUBLIC;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON TABLE public.wamda_category_images FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON TABLE public.wamda_category_images FROM authenticated;
    END IF;
END $$;

COMMIT;

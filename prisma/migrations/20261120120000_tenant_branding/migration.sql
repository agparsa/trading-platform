-- Branding: optional per-firm name, accent colours and contact details.
ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "brand_name" TEXT,
  ADD COLUMN IF NOT EXISTS "brand_accent_dark" TEXT,
  ADD COLUMN IF NOT EXISTS "brand_accent_light" TEXT,
  ADD COLUMN IF NOT EXISTS "support_email" TEXT,
  ADD COLUMN IF NOT EXISTS "website_url" TEXT;

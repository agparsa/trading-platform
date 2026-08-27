-- The RISK_MANAGER role, which the master upgrade specification requires and
-- which the permission catalogue already describes.
--
-- Additive: an existing row keeps its value, and an older image running against
-- this schema simply never issues the new one.
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'RISK_MANAGER';

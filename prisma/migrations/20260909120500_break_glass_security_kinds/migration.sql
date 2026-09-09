-- Break-glass in the security feed.
--
-- Its own migration because `ALTER TYPE … ADD VALUE` and a use of the new value
-- cannot share a transaction on PostgreSQL. Nothing here uses it yet, so this
-- one would in fact have been legal alongside the table — but the next person
-- adding an enum value copies whichever they find, and this is the safe one.
--
-- The event is recorded against the **subject**, not the staff member. Somebody
-- looked at your account is a thing you are entitled to know, and a break-glass
-- nobody outside the room can see is indistinguishable from snooping.
ALTER TYPE "SecurityEventKind" ADD VALUE IF NOT EXISTS 'BREAK_GLASS_OPENED';
ALTER TYPE "SecurityEventKind" ADD VALUE IF NOT EXISTS 'BREAK_GLASS_CLOSED';

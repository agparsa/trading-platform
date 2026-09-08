-- Leases for the loops that must run in exactly one place.
--
-- Before this, "only one instance runs the trigger engine" was an environment
-- variable set on one container. Nothing enforced it. A rolling deploy that
-- overlaps old and new for ten seconds, or `--scale api-ingest=2` typed once,
-- and two engines evaluate the same tick: two stop-outs on one position, two
-- fills for one resting order, two candles for one minute.
--
-- The lease is decided by the database's clock (`now()` below and in every
-- statement that touches this table), never by the process's. Contenders on
-- machines whose clocks disagree still agree about who holds the lease.
--
-- `term` is a fencing token: it increments when the lease changes hands and
-- does not move when the holder renews. "Held by one process since 09:00" and
-- "changed hands two hundred times since 09:00" are different incidents, and
-- without this column they look the same.
--
-- No tenant_id and no RLS: leadership is a property of the deployment. It is
-- read through the platform-admin API and written only by the processes
-- themselves.
CREATE TABLE "leader_leases" (
    "name" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "term" BIGINT NOT NULL DEFAULT 1,
    "acquired_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "renewed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "leader_leases_pkey" PRIMARY KEY ("name")
);

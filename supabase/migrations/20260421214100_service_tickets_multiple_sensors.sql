-- Support grouping multiple sensors under one service ticket.
--
-- The tool usually opens a ticket per sensor, but occasionally several
-- sensors need to be returned to QuantAQ together under a single RMA.
-- Add sensor_ids text[] alongside the existing sensor_id column, backfill
-- from sensor_id for existing rows, and keep sensor_id as the "primary"
-- sensor (sensor_ids[0]) for backwards compatibility with the old column
-- and the existing index.

ALTER TABLE service_tickets
    ADD COLUMN IF NOT EXISTS sensor_ids text[] DEFAULT '{}';

-- Backfill one-sensor array for every existing row. Only touch rows that
-- don't already have a populated array so this migration can safely
-- replay against newer data.
UPDATE service_tickets
SET sensor_ids = ARRAY[sensor_id]
WHERE sensor_id IS NOT NULL
  AND (sensor_ids IS NULL OR array_length(sensor_ids, 1) IS NULL);

CREATE INDEX IF NOT EXISTS idx_service_tickets_sensor_ids
    ON service_tickets USING gin (sensor_ids);

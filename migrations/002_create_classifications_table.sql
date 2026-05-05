-- Migration 002: Ensure classifications table has the correct schema
-- Drops and recreates the table to match the canonical schema (safe for fresh CI environments)
-- For existing databases with data, use ALTER TABLE to add missing columns instead.

-- DROP TABLE IF EXISTS classifications;

CREATE TABLE IF NOT EXISTS classifications (
    id                    UUID PRIMARY KEY NOT NULL,
    name                  VARCHAR NOT NULL UNIQUE,
    gender                VARCHAR NOT NULL,
    gender_probability    FLOAT NOT NULL CHECK (gender_probability >= 0 AND gender_probability <= 1),
    age                   INTEGER NOT NULL CHECK (age >= 0),
    age_group             VARCHAR NOT NULL,
    country_id            VARCHAR(2) NOT NULL,
    country_name          VARCHAR NOT NULL,
    country_probability   FLOAT NOT NULL CHECK (country_probability >= 0 AND country_probability <= 1),
    created_at            TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS classifications_country_id_idx ON classifications (country_id);
CREATE INDEX IF NOT EXISTS classifications_gender_idx ON classifications (gender);
CREATE INDEX IF NOT EXISTS classifications_gender_prob_idx ON classifications (gender_probability);
CREATE INDEX IF NOT EXISTS classifications_age_group_idx ON classifications (age_group);
CREATE INDEX IF NOT EXISTS classifications_age_idx ON classifications (age);
CREATE INDEX IF NOT EXISTS classifications_country_prob_idx ON classifications (country_probability);
CREATE INDEX IF NOT EXISTS classifications_created_at_idx ON classifications (created_at);

CREATE INDEX IF NOT EXISTS classifications_lower_name_idx ON classifications (LOWER(name));
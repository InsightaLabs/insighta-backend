-- Migration 002: Ensure classifications table has the correct schema
-- Drops and recreates the table to match the canonical schema (safe for fresh CI environments)
-- For existing databases with data, use ALTER TABLE to add missing columns instead.

DROP TABLE IF EXISTS classifications;

CREATE TABLE classifications (
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

CREATE INDEX classifications_country_id_idx ON classifications (country_id);

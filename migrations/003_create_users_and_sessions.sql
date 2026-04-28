CREATE TABLE users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    github_id   VARCHAR NOT NULL UNIQUE,
    username    VARCHAR NOT NULL,
    email       VARCHAR,
    role        VARCHAR NOT NULL DEFAULT 'analyst' CHECK (role IN ('admin', 'analyst')),
    created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE sessions (
    id          UUID PRIMARY KEY NOT NULL,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  VARCHAR NOT NULL UNIQUE,
    expires_at  TIMESTAMP NOT NULL,
    revoked     BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sessions_token_hash ON sessions(token_hash);

CREATE INDEX idx_sessions_user_id ON sessions(user_id);
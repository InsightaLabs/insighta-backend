# Insighta Labs+ — Backend

A REST API that classifies names by gender, age, and nationality using three external APIs (Genderize, Agify, Nationalize), stores results in PostgreSQL, and exposes a full query interface with natural language search, role-based access control, GitHub OAuth with PKCE, and CSV export.

---

## Tech Stack

- Node.js + TypeScript
- Express
- PostgreSQL (`pg`)
- JWT (`jsonwebtoken`) + opaque refresh tokens
- UUID v7 for primary keys
- `cookie-parser` for HTTP-only cookie auth
- `csv-stringify` for streaming CSV export
- `express-rate-limit` for rate limiting
- Vitest + Supertest for testing

---

## System Architecture

```
src/
├── index.ts                  # App entry — mounts middleware, routes, starts server
├── types.ts                  # Shared TypeScript types
├── utils.ts                  # Country map, type guards, NLQ parser
├── controllers/
│   ├── auth.controller.ts    # GitHub OAuth, token issuance, refresh, logout, /me
│   └── profiles.controller.ts# CRUD, search, CSV export
├── routes/
│   └── v1/
│       ├── auth.route.ts     # /auth/*
│       └── profiles.route.ts # /api/profiles/* (auth + RBAC enforced)
├── middleware/
│   ├── authenticate.ts       # JWT/cookie verification → populates req.user
│   ├── authorize.ts          # Role-based access control (analyst < admin)
│   ├── csrf.ts               # CSRF double-submit for browser clients
│   ├── logger.ts             # Request logger (method, endpoint, status, response time)
│   ├── rate-limiting.ts      # Auth limiter (10/min), app limiter (60/min)
│   └── version-check.ts      # Enforces X-API-Version: 1 header on /api/profiles/*
└── db/
    └── index.ts              # DatabaseClient — all SQL queries
```

### Request lifecycle

```
Request
  → requestLogger
  → CORS
  → express.json()
  → cookieParser()
  → Rate limiter (authLimiter or appLimiter)
  → authenticate    (verifies JWT from cookie or Bearer header)
  → csrfProtection  (skipped for GET/HEAD/OPTIONS and Bearer/CLI clients)
  → versionCheck    (enforces X-API-Version: 1)
  → authorize(role) (checks req.user.role)
  → Controller
  → Response
```

---

## Authentication

Two clients are supported: a **CLI** and a **web portal**. Both use GitHub OAuth with PKCE. The client type is signalled via the `x-client-type: cli` request header.

### GitHub OAuth with PKCE

**Web portal flow:**

1. Portal redirects browser to `GET /auth/github`
2. Backend generates `state`, `code_verifier`, `code_challenge`, stores them in memory (10 min TTL), and redirects to GitHub
3. GitHub redirects to `GET /auth/github/callback?code=...&state=...`
4. Backend validates state, exchanges code + verifier for a GitHub access token, upserts the user, issues tokens
5. Sets three cookies and redirects to `WEB_PORTAL_URL/dashboard`

**CLI flow:**

1. CLI generates its own PKCE params and opens the browser directly to GitHub OAuth with `redirect_uri=http://localhost:<port>/callback`
2. GitHub redirects to the CLI's local callback server
3. CLI sends `GET /auth/github/callback?code=...&code_verifier=...` with `x-client-type: cli`
4. Backend exchanges the code, upserts the user, returns tokens as JSON

### Token issuance

| Token         | Type                  | Expiry    | Storage (web)                   | Storage (CLI)                |
| ------------- | --------------------- | --------- | ------------------------------- | ---------------------------- |
| Access token  | JWT (HS256)           | 3 minutes | `access_token` httpOnly cookie  | In memory / credentials file |
| Refresh token | Opaque (32 bytes hex) | 5 minutes | `refresh_token` httpOnly cookie | Credentials file             |

**Browser response** (no `x-client-type: cli`):

- Sets `access_token` — httpOnly, SameSite=Strict
- Sets `refresh_token` — httpOnly, SameSite=Strict
- Sets `csrf_token` — readable (non-httpOnly), for CSRF double-submit
- Redirects to `WEB_PORTAL_URL/dashboard`

**CLI response** (`x-client-type: cli`):

```json
{
  "status": "success",
  "access_token": "...",
  "refresh_token": "...",
  "token_type": "Bearer",
  "expires_in": 180
}
```

### Token refresh

`POST /auth/refresh` — body: `{ "refresh_token": "<opaque token>" }`

1. Hash the incoming token, look up the session
2. Validate: not revoked, not expired, user exists and is active
3. Revoke the old session (rotation — prevents replay)
4. Issue new access token + new refresh token
5. Return both as JSON

### Logout

`POST /auth/logout` — body: `{ "refresh_token": "<opaque token>" }`

Marks the session as `revoked = true`. Idempotent — returns 200 even if already revoked.

---

## Role-Based Access Control

| Role      | Permissions                                                  |
| --------- | ------------------------------------------------------------ |
| `analyst` | Read profiles, search, export CSV                            |
| `admin`   | Everything analyst can do + create profiles, delete profiles |

New users are assigned `analyst` by default. Role is stored in the `users` table and embedded in the JWT payload.

The `authorize` middleware uses a hierarchy array `["analyst", "admin"]` — an admin always passes an analyst check.

---

## CSRF Protection

Applied to all mutating requests (`POST`, `PUT`, `PATCH`, `DELETE`) on `/api/profiles/*`.

- On login, the backend sets a readable `csrf_token` cookie
- The web portal reads this cookie and sends it as `X-CSRF-Token` on every mutating request
- The middleware compares `req.headers['x-csrf-token']` against `req.cookies['csrf_token']`
- Skipped for `GET`, `HEAD`, `OPTIONS` (safe methods)
- Skipped for requests with `Authorization: Bearer ...` (CLI)

---

## Rate Limiting

| Limiter       | Applied to        | Limit                         |
| ------------- | ----------------- | ----------------------------- |
| `authLimiter` | `/auth/*`         | 10 requests / minute          |
| `appLimiter`  | `/api/profiles/*` | 60 requests / minute per user |

Returns `429 Too Many Requests` when exceeded. Limits are relaxed to 1000/min in `development` mode.

---

## Logging

Every request is logged to stdout:

```
GET /api/profiles 200 45ms
POST /auth/refresh 200 12ms
GET /auth/me 401 8ms
```

Format: `METHOD ENDPOINT STATUS_CODE RESPONSE_TIMEms`

---

## API Reference

### Auth

#### `GET /auth/github`

Initiates GitHub OAuth. Generates PKCE params, stores state, redirects to GitHub.

#### `GET /auth/github/callback`

GitHub redirects here after authorization. Validates state, exchanges code, upserts user, issues tokens.

Supports both web portal (sets cookies, redirects) and CLI (`x-client-type: cli`, returns JSON).

#### `POST /auth/refresh`

```json
{ "refresh_token": "string" }
```

Returns new `access_token` and `refresh_token`. Old refresh token is immediately revoked.

#### `POST /auth/logout`

```json
{ "refresh_token": "string" }
```

Revokes the session. Returns 200 regardless of prior state.

#### `GET /auth/me`

Requires authentication (cookie or Bearer token). Returns the authenticated user's profile.

```json
{
  "status": "success",
  "user": {
    "id": "uuid",
    "username": "github-login",
    "email": "user@example.com",
    "avatar_url": "https://avatars.githubusercontent.com/...",
    "role": "analyst",
    "created_at": "2026-01-01T00:00:00.000Z"
  }
}
```

---

### Profiles (all require authentication + `X-API-Version: 1` header)

#### `POST /api/profiles` — admin only

Classifies a name via Genderize, Agify, and Nationalize. Returns 201 on creation, 200 if the name already exists.

```json
{ "name": "Harriet Tubman" }
```

Response:

```json
{
  "status": "success",
  "data": {
    "id": "uuid",
    "name": "Harriet Tubman",
    "gender": "female",
    "gender_probability": 0.97,
    "age": 34,
    "age_group": "adult",
    "country_id": "US",
    "country_name": "United States",
    "country_probability": 0.89,
    "created_at": "2026-01-01T00:00:00.000Z"
  }
}
```

#### `GET /api/profiles` — analyst+

Returns paginated profiles.

**Query parameters:**

| Parameter                 | Type                                          | Description                             |
| ------------------------- | --------------------------------------------- | --------------------------------------- |
| `gender`                  | `male` \| `female`                            | Filter by gender                        |
| `age_group`               | `child` \| `teenager` \| `adult` \| `senior`  | Filter by age group                     |
| `country_id`              | string                                        | ISO 3166-1 alpha-2 (e.g. `NG`)          |
| `min_age`                 | number                                        | Minimum age inclusive                   |
| `max_age`                 | number                                        | Maximum age inclusive                   |
| `min_gender_probability`  | float                                         | Minimum gender confidence (0–1)         |
| `min_country_probability` | float                                         | Minimum nationality confidence (0–1)    |
| `sort_by`                 | `age` \| `created_at` \| `gender_probability` | Sort field                              |
| `order`                   | `asc` \| `desc`                               | Sort direction                          |
| `page`                    | number                                        | Page number (default: 1)                |
| `limit`                   | number                                        | Results per page (default: 10, max: 50) |

**Response:**

```json
{
  "status": "success",
  "page": 1,
  "limit": 10,
  "total": 2026,
  "total_pages": 203,
  "links": {
    "self": "/api/profiles?page=1&limit=10",
    "next": "/api/profiles?page=2&limit=10",
    "prev": null
  },
  "data": [...]
}
```

#### `GET /api/profiles/search` — analyst+

Natural language search. See [Natural Language Parsing](#natural-language-parsing) below.

```
GET /api/profiles/search?q=young+males+from+nigeria
```

#### `GET /api/profiles/export?format=csv` — analyst+

Streams a CSV file of all matching profiles (up to 1000 records). Accepts the same filter and sort parameters as `GET /api/profiles`.

```
Content-Type: text/csv
Content-Disposition: attachment; filename="profiles_<timestamp>.csv"
```

CSV columns: `id, name, gender, gender_probability, age, age_group, country_id, country_name, country_probability, created_at`

#### `GET /api/profiles/:id` — analyst+

Returns a single profile by UUID.

#### `DELETE /api/profiles/:id` — admin only

Deletes a profile. Returns `204 No Content`.

---

## Natural Language Parsing

The `/api/profiles/search` endpoint uses a rule-based parser — no AI or LLMs. The query is lowercased, tokenized by whitespace, and run through four independent passes.

### Gender pass

Checks tokens against fixed male/female word sets. If both are present, no gender filter is applied.

### Age group pass

Maps named tokens (`young`, `adult`, `teenager`, `senior`, `child`) to age filters. Numeric anchors (`above N`, `over N`, `below N`, `under N`) extract `min_age` / `max_age`.

### Nationality pass

Looks for anchor words (`from`, `in`, `of`) then matches following tokens against a reverse ISO 3166-1 country name map, longest match first.

### Pagination pass

Looks for `page N`, `show N`, `take N`, `limit N` patterns.

**Examples:**

| Query                            | Parsed filters                                   |
| -------------------------------- | ------------------------------------------------ |
| `young males`                    | `gender: male, min_age: 16, max_age: 24`         |
| `females above 30`               | `gender: female, min_age: 30`                    |
| `adult males from kenya`         | `gender: male, age_group: adult, country_id: KE` |
| `seniors from the united states` | `age_group: senior, country_id: US`              |

Returns `422 Unable to interpret query` if no recognisable filter is extracted.

---

## Database Schema

### `classifications`

| Column                | Type      | Notes                                  |
| --------------------- | --------- | -------------------------------------- |
| `id`                  | UUID      | Primary key, UUID v7                   |
| `name`                | VARCHAR   | Unique (case-insensitive conflict)     |
| `gender`              | VARCHAR   | `male` or `female`                     |
| `gender_probability`  | FLOAT     | 0–1                                    |
| `age`                 | INT       | From Agify                             |
| `age_group`           | VARCHAR   | `child`, `teenager`, `adult`, `senior` |
| `country_id`          | VARCHAR   | ISO alpha-2                            |
| `country_name`        | VARCHAR   | Full country name                      |
| `country_probability` | FLOAT     | 0–1                                    |
| `created_at`          | TIMESTAMP | Auto                                   |

### `users`

| Column          | Type      | Notes                          |
| --------------- | --------- | ------------------------------ |
| `id`            | UUID      | Primary key, UUID v7           |
| `github_id`     | VARCHAR   | Unique                         |
| `username`      | VARCHAR   | GitHub login                   |
| `email`         | VARCHAR   | Nullable                       |
| `avatar_url`    | VARCHAR   | GitHub avatar URL              |
| `role`          | VARCHAR   | `analyst` (default) or `admin` |
| `is_active`     | BOOLEAN   | If false → 403 on all requests |
| `last_login_at` | TIMESTAMP | Updated on each login          |
| `created_at`    | TIMESTAMP | Auto                           |

### `sessions`

| Column       | Type      | Notes                                 |
| ------------ | --------- | ------------------------------------- |
| `id`         | UUID      | Primary key, UUID v7                  |
| `user_id`    | UUID      | FK → users(id)                        |
| `token_hash` | VARCHAR   | SHA-256 hash of the raw refresh token |
| `expires_at` | TIMESTAMP | 5 minutes from creation               |
| `revoked`    | BOOLEAN   | Default false                         |
| `created_at` | TIMESTAMP | Auto                                  |

---

## Setup

### Prerequisites

- Node.js 18+
- PostgreSQL

### Environment variables

```env
CLASSIFY_DB_URL=postgresql://user:password@localhost:5432/db
GITHUB_CLIENT_ID=your_github_client_id
GITHUB_SECRET=your_github_client_secret
GITHUB_CALLBACK_URL=http://localhost:3001/auth/github/callback
JWT_SECRET=your_jwt_secret
JWT_EXPIRY=3m
REFRESH_TOKEN_EXPIRY=5m
WEB_PORTAL_URL=http://localhost:3000
NODE_ENV=development
```

### Install and run

```bash
pnpm install

# Run migrations
psql $CLASSIFY_DB_URL -f migrations/001_create_classifications_table.sql
psql $CLASSIFY_DB_URL -f migrations/002_create_classifications_table.sql
psql $CLASSIFY_DB_URL -f migrations/003_create_users_and_sessions.sql

# Seed profiles (optional)
pnpm tsx scripts/seed.ts

# Dev server
pnpm dev
```

### Tests

```bash
pnpm test
```

---

## Error Responses

All errors follow this shape:

```json
{ "status": "error", "message": "<description>" }
```

| Status | Meaning                                                                     |
| ------ | --------------------------------------------------------------------------- |
| 400    | Missing or empty parameter / missing API version header                     |
| 401    | Missing, expired, or invalid access token                                   |
| 403    | Insufficient role / invalid CSRF token / deactivated user                   |
| 404    | Resource not found                                                          |
| 422    | Invalid parameter value or uninterpretable NLQ                              |
| 429    | Rate limit exceeded                                                         |
| 500    | Internal server error                                                       |
| 502    | External API (Genderize / Agify / Nationalize) returned an invalid response |

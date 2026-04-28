# Insighta Labs+ — Backend

A REST API that classifies names by gender, age, and nationality using three external APIs (Genderize, Agify, Nationalize), stores results in PostgreSQL, and exposes a full query interface with natural language search, role-based access control, GitHub OAuth, and CSV export.

---

## Tech Stack

- Node.js + TypeScript
- Express 5
- PostgreSQL (`pg`)
- JWT (`jsonwebtoken`) + opaque refresh tokens
- UUID v7 for primary keys
- `csv-stringify` for streaming CSV export
- `express-rate-limit` for rate limiting
- Vitest + Supertest for testing

---

## System Architecture

```
src/
├── index.ts                  # App entry point — mounts routes, middleware, starts server
├── types.ts                  # Shared TypeScript types
├── utils.ts                  # Country map, type guards, NLQ parser
├── controllers/
│   ├── auth.controller.ts    # GitHub OAuth, token issuance, refresh, logout, me
│   └── profiles.controller.ts# CRUD, search, CSV export
├── routes/
│   ├── profiles.route.ts     # Legacy unversioned routes (no auth)
│   └── v1/
│       ├── auth.route.ts     # /api/v1/auth/*
│       └── profiles.route.ts # /api/v1/profiles/* (auth + RBAC enforced)
├── middleware/
│   ├── authenticate.ts       # JWT verification → populates req.user
│   ├── authorize.ts          # Role-based access control (analyst < admin)
│   ├── csrf.ts               # CSRF protection for browser clients
│   └── rate-limiting.ts      # Auth limiter (10/15min), app limiter (100/15min)
└── db/
    └── index.ts              # DatabaseClient — all SQL queries
```

### Request lifecycle (v1 routes)

```
Request
  → CORS
  → express.json()
  → Rate limiter (authLimiter or appLimiter)
  → authenticate    (verifies JWT, sets req.user)
  → csrfProtection  (skipped for Bearer/CLI clients)
  → authorize(role) (checks req.user.role against required role)
  → Controller
  → Response
```

---

## Authentication Flow

This backend supports two clients: a **CLI** and a **web portal**. Both use the same GitHub OAuth flow with PKCE, but the callback response differs based on the `x-client-type` header.

### GitHub OAuth with PKCE

1. Client calls `GET /api/v1/auth/github`
2. Backend generates a `code_verifier` (random 32 bytes, base64url), derives a `code_challenge` (SHA-256 hash), generates a `state` nonce, stores `{ codeVerifier, expiresAt }` keyed by `state` in an in-memory map, and redirects to GitHub
3. GitHub redirects back to `GET /api/v1/auth/github/callback?code=...&state=...`
4. Backend validates `state` (must exist in store, must not be expired), deletes it (one-time use), then exchanges `code + code_verifier` for a GitHub access token
5. Backend fetches the GitHub user profile, upserts the user in the `users` table (preserving existing role), issues tokens

### Token issuance

| Token | Type | Expiry | Storage |
|---|---|---|---|
| Access token | JWT (HS256) | 15 minutes | Client memory / Authorization header |
| Refresh token | Opaque (random 32 bytes hex) | 7 days | Hashed (SHA-256) in `sessions` table |

**CLI path** (`x-client-type: cli` header present):
- Returns `{ access_token, refresh_token, token_type, expires_in }` as JSON

**Browser path** (no `x-client-type: cli` header):
- Sets `refresh_token` as an `HttpOnly; SameSite=Strict` cookie
- Sets `csrf_token` as a readable (non-HttpOnly) cookie for CSRF double-submit
- Redirects to `WEB_PORTAL_URL/dashboard?access_token=...`

### Token refresh

`POST /api/v1/auth/refresh` — body: `{ refresh_token }`

1. Hash the incoming token, look up the session
2. Validate: not revoked, not expired, user still exists
3. Revoke the old session (rotation — prevents replay)
4. Issue a new access token + new refresh token
5. Return both

### Logout

`POST /api/v1/auth/logout` — body: `{ refresh_token }`

Hashes the token and marks the session as `revoked = true`. Idempotent — returns 200 even if the token is already revoked or doesn't exist (no information leakage).

---

## Role-Based Access Control

Two roles exist: `analyst` and `admin`. `admin` is a strict superset of `analyst`.

| Role | Can do |
|---|---|
| `analyst` | GET profiles, search, export CSV |
| `admin` | Everything analyst can do + create profiles, delete profiles |

New users are assigned `analyst` by default. Role is stored in the `users` table and embedded in the JWT payload (`{ userId, role }`).

### Middleware chain for protected routes

```
authenticate → authorize("analyst" | "admin") → controller
```

`authenticate` verifies the JWT and populates `req.user = { userId, role }`. `authorize` reads `req.user.role` and compares it against a role hierarchy array `["analyst", "admin"]` using index comparison — an admin always passes an analyst check.

---

## CSRF Protection

Applied to all `/api/v1/profiles/*` routes. Uses the double-submit cookie pattern:

- On login (browser path), the backend sets a `csrf_token` cookie (readable by JS)
- The web portal reads this cookie and sends it back as an `X-CSRF-Token` header on every mutating request
- The middleware compares `req.headers['x-csrf-token']` against `req.cookies['csrf_token']`
- **Bypass:** if the request has an `Authorization: Bearer ...` header (CLI), CSRF is skipped entirely

---

## Rate Limiting

| Limiter | Applied to | Limit |
|---|---|---|
| `authLimiter` | `/api/v1/auth/*` | 10 requests / 15 min |
| `appLimiter` | `/api/v1/profiles/*` | 100 requests / 15 min |

Exceeding the limit returns `429 Too Many Requests`.

---

## API Reference

### Auth

#### `GET /api/v1/auth/github`
Initiates GitHub OAuth. Redirects to GitHub with PKCE parameters.

#### `GET /api/v1/auth/github/callback`
GitHub redirects here after authorization. Validates state, exchanges code, upserts user, issues tokens.

#### `POST /api/v1/auth/refresh`
```json
{ "refresh_token": "<opaque token>" }
```
Returns new `access_token` and `refresh_token`. Old refresh token is revoked.

#### `POST /api/v1/auth/logout`
```json
{ "refresh_token": "<opaque token>" }
```
Revokes the session. Returns 200 regardless.

#### `GET /api/v1/auth/me`
Requires `Authorization: Bearer <access_token>`. Returns the authenticated user's profile (id, username, email, role, created_at).

---

### Profiles (v1 — all require authentication)

All v1 profile endpoints require a valid JWT in the `Authorization: Bearer` header.

#### `POST /api/v1/profiles` — admin only
Creates a profile by classifying a name via Genderize, Agify, and Nationalize. Returns 201 on creation, 200 if the name already exists.

```json
{ "name": "ella" }
```

#### `GET /api/v1/profiles` — analyst+
Returns paginated profiles. All filters from the legacy endpoint are supported.

**Response shape (v1):**
```json
{
  "status": "success",
  "data": [...],
  "meta": {
    "page": 1,
    "limit": 10,
    "total": 2026,
    "totalPages": 203
  }
}
```

**Query parameters:**

| Parameter | Type | Description |
|---|---|---|
| `gender` | `male` \| `female` | Filter by gender |
| `age_group` | `child` \| `teenager` \| `adult` \| `senior` | Filter by age group |
| `country_id` | string | ISO 3166-1 alpha-2 (e.g. `NG`) |
| `min_age` | number | Minimum age inclusive |
| `max_age` | number | Maximum age inclusive |
| `min_gender_probability` | float | Minimum gender confidence |
| `min_country_probability` | float | Minimum nationality confidence |
| `sort_by` | `age` \| `created_at` \| `gender_probability` | Sort field |
| `order` | `asc` \| `desc` | Sort direction |
| `page` | number | Page number (default: 1) |
| `limit` | number | Results per page (default: 10, max: 50) |

#### `GET /api/v1/profiles/search` — analyst+
Natural language search. See [Natural Language Parsing](#natural-language-parsing) below.

```
GET /api/v1/profiles/search?q=young males from nigeria page 2
```

#### `GET /api/v1/profiles/export` — analyst+
Streams a CSV file of all matching profiles. Accepts the same filter and sort parameters as `GET /api/v1/profiles` (no pagination — exports all matching records up to 1000).

Response headers:
```
Content-Type: text/csv
Content-Disposition: attachment; filename="profiles.csv"
```

#### `GET /api/v1/profiles/:id` — analyst+
Returns a single profile by UUID.

#### `DELETE /api/v1/profiles/:id` — admin only
Deletes a profile. Returns `204 No Content`.

---

### Legacy routes (no auth)

The original unversioned routes remain intact at `/api/profiles/*` with no authentication or rate limiting. These are preserved from Stage 2.

---

## Database Schema

### `classifications`
Stores name classification results from the external APIs.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | Primary key, UUID v7 |
| `name` | VARCHAR | Unique (case-insensitive conflict) |
| `gender` | VARCHAR | `male` or `female` |
| `gender_probability` | FLOAT | 0–1 |
| `age` | INT | From Agify |
| `age_group` | VARCHAR | `child`, `teenager`, `adult`, `senior` |
| `country_id` | VARCHAR | ISO alpha-2 |
| `country_name` | VARCHAR | Full country name |
| `country_probability` | FLOAT | 0–1 |
| `created_at` | TIMESTAMP | Auto |

### `users`
Stores authenticated users created via GitHub OAuth.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | Primary key |
| `github_id` | VARCHAR | Unique, from GitHub |
| `username` | VARCHAR | GitHub login |
| `email` | VARCHAR | Nullable |
| `role` | VARCHAR | `analyst` (default) or `admin` |
| `created_at` | TIMESTAMP | Auto |

### `sessions`
Stores hashed refresh tokens.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | Primary key |
| `user_id` | UUID | FK → users(id), CASCADE DELETE |
| `token_hash` | VARCHAR | SHA-256 hash of the raw refresh token |
| `expires_at` | TIMESTAMP | 7 days from creation |
| `revoked` | BOOLEAN | Default false |
| `created_at` | TIMESTAMP | Auto |

Indexed on `token_hash` and `user_id`.

---

## Natural Language Parsing

The `/api/v1/profiles/search` endpoint uses a rule-based parser — no AI or LLMs. The query is lowercased, tokenized by whitespace, and run through four independent passes that each extract a different category of filters. Results are merged.

### Gender Pass
Checks tokens against fixed male/female sets. If both are present, gender filter is cancelled (no filter applied).

### Age Group Pass
Maps named tokens (`young`, `adult`, `teenager`, `senior`, `child`) to age filters. Numeric anchors (`above N`, `below N`, `over N`, `under N`) extract `min_age` / `max_age`. Explicit numeric anchors override `young` defaults.

### Nationality Pass
Looks for anchor words (`from`, `in`, `of`) then tries to match the following tokens against a reverse ISO 3166-1 country name map, longest match first.

### Pagination Pass
Looks for `page N`, `show N`, `take N`, `limit N` patterns.

**Examples:**

| Query | Parsed filters |
|---|---|
| `young males` | `gender: male, min_age: 16, max_age: 24` |
| `females above 30` | `gender: female, min_age: 30` |
| `adult males from kenya` | `gender: male, age_group: adult, country_id: KE` |
| `young males from nigeria page 2` | `gender: male, min_age: 16, max_age: 24, country_id: NG, page: 2` |

If no recognisable filter is extracted, returns `422 Unable to interpret query`.

---

## Setup

### Prerequisites

- Node.js 18+
- PostgreSQL

### Environment variables

```env
CLASSIFY_DB_URL=postgresql://user:password@localhost:5432/db
GITHUB_CLIENT_ID=...
GITHUB_SECRET=...
GITHUB_CALLBACK_URL=http://localhost:3001/api/v1/auth/github/callback
JWT_SECRET=...
WEB_PORTAL_URL=http://localhost:3000
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

Tests require a running local PostgreSQL instance seeded with the 2026 profiles. DB tests run against the real database. HTTP tests use isolated Express apps with no rate limiting or CSRF to keep them fast and deterministic.

---

## Error Responses

All errors follow this shape:

```json
{ "status": "error", "message": "<description>" }
```

| Status | Meaning |
|---|---|
| 400 | Missing or empty parameter |
| 401 | Missing, expired, or invalid access token |
| 403 | Insufficient role / invalid CSRF token |
| 404 | Resource not found |
| 422 | Invalid parameter value or uninterpretable query |
| 429 | Rate limit exceeded |
| 500 | Internal server error |
| 502 | External API (Genderize / Agify / Nationalize) returned an invalid response |

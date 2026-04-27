# Classifications API

A REST API that accepts a name, fetches classification data from three external APIs (Genderize, Agify, Nationalize), stores the result in a PostgreSQL database, and exposes endpoints to query and manage that data — including a natural language search endpoint.

## Tech Stack

- Node.js + TypeScript
- Express
- PostgreSQL (`pg`)
- UUID v7 for primary keys

## Getting Started

### Prerequisites

- Node.js 18+
- PostgreSQL

### Setup

1. Clone the repo and install dependencies:

```bash
pnpm install
```

2. Create a `.env` file in the root:

```env
CLASSIFY_DATABASE_URL=postgresql://user:password@localhost:5432/classifications_db
```

3. Run the migration:

```bash
psql $CLASSIFY_DATABASE_URL -f migrations/002_create_classifications_table.sql
```

4. (Optional) Seed the database:

```bash
pnpm tsx scripts/seed.ts
```

5. Start the dev server:

```bash
pnpm dev
```

---

## API Reference

### POST /api/profiles

Creates a new profile by classifying a name using three external APIs. If the name already exists (case-sensitive), returns the existing record.

**Request body:**

```json
{ "name": "ella" }
```

**Response 201 — created:**

```json
{
  "status": "success",
  "data": {
    "id": "019612a3-...",
    "name": "ella",
    "gender": "female",
    "gender_probability": 0.99,
    "age": 46,
    "age_group": "adult",
    "country_id": "US",
    "country_name": "United States",
    "country_probability": 0.85,
    "created_at": "2026-04-01T12:00:00Z"
  }
}
```

**Response 200 — already exists:**

```json
{
  "status": "success",
  "message": "Profile already exists",
  "data": { ... }
}
```

---

### GET /api/profiles

Returns profiles with optional filtering, sorting, and pagination.

**Query parameters (all optional):**

| Parameter                | Type                                          | Description                               |
| ------------------------ | --------------------------------------------- | ----------------------------------------- |
| `gender`                 | `male` \| `female`                            | Filter by gender                          |
| `age_group`              | `child` \| `teenager` \| `adult` \| `senior`  | Filter by age group                       |
| `country_id`             | string                                        | ISO 3166-1 alpha-2 code (e.g. `NG`, `US`) |
| `min_age`                | number                                        | Minimum age (inclusive)                   |
| `max_age`                | number                                        | Maximum age (inclusive)                   |
| `min_gender_probability` | float                                         | Minimum gender confidence score           |
| `max_gender_probability` | float                                         | Maximum gender confidence score           |
| `sort_by`                | `age` \| `created_at` \| `gender_probability` | Field to sort by                          |
| `sort_order`             | `asc` \| `desc`                               | Sort direction (default: `desc`)          |
| `page`                   | number                                        | Page number (default: 1)                  |
| `limit`                  | number                                        | Results per page (default: 10, max: 50)   |

**Example:**

```
GET /api/profiles?gender=male&country_id=NG&sort_by=age&sort_order=asc&page=1&limit=20
```

**Response 200:**

```json
{
  "status": "success",
  "page": 1,
  "limit": 20,
  "total": 2026,
  "data": [ ... ]
}
```

---

### GET /api/profiles/search

Natural language query endpoint. Parses a plain English query string and converts it into filters.

**Query parameters:**

| Parameter | Description                                           |
| --------- | ----------------------------------------------------- |
| `q`       | Plain English query string (required)                 |
| `page`    | Can also be embedded in `q` as `page 2`               |
| `limit`   | Can also be embedded in `q` as `show 20` or `take 20` |

**Example:**

```
GET /api/profiles/search?q=young males from nigeria page 2
```

**Response 200:**

```json
{
  "status": "success",
  "page": 2,
  "limit": 10,
  "total": 2026,
  "data": [ ... ]
}
```

**Response 422 — uninterpretable query:**

```json
{
  "status": "error",
  "message": "Unable to interpret query"
}
```

---

### GET /api/profiles/:id

Returns a single profile by UUID.

**Response 200:**

```json
{
  "status": "success",
  "data": { ... }
}
```

---

### DELETE /api/profiles/:id

Deletes a profile by UUID. Returns `204 No Content` on success.

---

## Classification Rules

- **Age group** (from Agify): `0–12` → child, `13–19` → teenager, `20–59` → adult, `60+` → senior
- **Nationality** (from Nationalize): country with the highest probability is selected. Country name is resolved from a local ISO 3166-1 static map.
- **Gender** (from Genderize): if `gender` is null or `count` is 0, the request is rejected with 502.

---

## Natural Language Parsing

The `/api/profiles/search` endpoint uses a rule-based parser — no AI or LLMs. The query string is lowercased, trimmed, and split into tokens. Four independent passes run against the token list, each extracting a different category of filters.

### How it works

The query is tokenized by whitespace:

```
"young males from nigeria page 2" → ["young", "males", "from", "nigeria", "page", "2"]
```

Each pass scans the full token list independently and returns a partial `AllProfileQueryOptions` object. The results are merged.

---

### Gender Pass

Checks each token against two fixed sets.

**Female tokens:** `female`, `females`, `woman`, `women`, `girl`, `girls`, `babe`, `babes`

**Male tokens:** `male`, `males`, `man`, `men`, `boy`, `boys`

**Rules:**

- If only female tokens found → `gender: "female"`
- If only male tokens found → `gender: "male"`
- If both found (e.g. `"males and females"`, `"male or female"`) → no gender filter applied (cancelled out)

**Examples:**

| Query                       | Result               |
| --------------------------- | -------------------- |
| `young males`               | `gender: "male"`     |
| `females above 30`          | `gender: "female"`   |
| `male and female teenagers` | _(no gender filter)_ |

---

### Age Group Pass

Checks tokens against named age group sets and numeric age anchor patterns.

**Token sets:**

| Set      | Tokens                                              | Maps to                    |
| -------- | --------------------------------------------------- | -------------------------- |
| Young    | `young`, `youth`, `youths`                          | `min_age: 16, max_age: 24` |
| Child    | `child`, `children`, `kid`, `kids`                  | `age_group: "child"`       |
| Teenager | `teen`, `teens`, `teenage`, `teenager`, `teenagers` | `age_group: "teenager"`    |
| Adult    | `adult`, `adults`                                   | `age_group: "adult"`       |
| Senior   | `senior`, `seniors`, `elderly`, `old`               | `age_group: "senior"`      |

**Numeric anchors** — looks for an anchor word followed immediately by a number:

| Anchor words                                  | Effect       |
| --------------------------------------------- | ------------ |
| `above`, `over`, `older`, `minimum`, `min`    | `min_age: N` |
| `below`, `under`, `younger`, `maximum`, `max` | `max_age: N` |

Explicit numeric anchors override the `young` defaults. So `"young people above 20"` produces `min_age: 20` (not 16).

**Examples:**

| Query                | Result                               |
| -------------------- | ------------------------------------ |
| `young males`        | `min_age: 16, max_age: 24`           |
| `females above 30`   | `min_age: 30`                        |
| `teenagers above 17` | `age_group: "teenager", min_age: 17` |
| `people under 10`    | `max_age: 10`                        |

---

### Nationality Pass

Looks for an anchor word (`from`, `in`, `of`) and attempts to match everything after it against a reverse country name map (built at startup from the bundled ISO 3166-1 dataset).

Multi-word country names are handled by trying the longest possible match first, then shrinking:

```
"from south africa" → tries "south africa" → match → country_id: "ZA"
"from nigeria"      → tries "nigeria"       → match → country_id: "NG"
```

**Anchor words:** `from`, `in`, `of`

**Examples:**

| Query                    | Result             |
| ------------------------ | ------------------ |
| `people from angola`     | `country_id: "AO"` |
| `adult males from kenya` | `country_id: "KE"` |
| `women in south africa`  | `country_id: "ZA"` |

---

### Pagination Pass

Looks for pagination anchor words followed by a number.

| Anchor                  | Effect                    |
| ----------------------- | ------------------------- |
| `page`                  | `page: N`                 |
| `limit`, `show`, `take` | `limit: N` (capped at 50) |

**Examples:**

| Query fragment | Result      |
| -------------- | ----------- |
| `page 2`       | `page: 2`   |
| `show 20`      | `limit: 20` |
| `take 5`       | `limit: 5`  |

---

### Query Examples

| Query                                | Parsed filters                                                    |
| ------------------------------------ | ----------------------------------------------------------------- |
| `young males`                        | `gender: male, min_age: 16, max_age: 24`                          |
| `females above 30`                   | `gender: female, min_age: 30`                                     |
| `people from angola`                 | `country_id: AO`                                                  |
| `adult males from kenya`             | `gender: male, age_group: adult, country_id: KE`                  |
| `male and female teenagers above 17` | `age_group: teenager, min_age: 17`                                |
| `young males from nigeria page 2`    | `gender: male, min_age: 16, max_age: 24, country_id: NG, page: 2` |

If no recognisable filter is extracted from the query, the API returns:

```json
{ "status": "error", "message": "Unable to interpret query" }
```

---

## Limitations

- **No synonym resolution.** Words like `"elderly"` map to `age_group: senior`, but `"aged"`, `"mature"`, `"pensioner"` are not recognised.

- **No negation.** Queries like `"not from nigeria"` or `"everyone except males"` are not handled. The negation is silently ignored and the positive filter is applied.

- **Country matching is exact (after lowercasing).** `"Ivory Coast"` will not match `"Côte d'Ivoire"` — the query must use the official ISO country name as stored in the dataset. Common aliases and alternate spellings are not supported. Countries with comma-inverted names in the ISO standard (e.g. `"Congo, Democratic Republic of the"`) cannot be matched from natural language at all — querying `"from dr congo"` or `"from democratic republic of congo"` will return no country filter.

- **`"young"` is a special mapping, not a stored age group.** It maps to `min_age: 16, max_age: 24` for query purposes only. There is no `"young"` value in the database.

- **Gender cancellation is silent.** When both male and female tokens appear, no gender filter is applied and no warning is returned. The query proceeds with other filters intact.

- **Numeric anchors only look one token ahead.** `"above thirty"` (word form) is not recognised — only `"above 30"` (digit form) works.

- **No compound age ranges from natural language.** `"between 20 and 40"` is not parsed. Use `min_age` and `max_age` query params on `GET /api/profiles` for that.

- **Pagination in the query string is additive but not validated against filters.** Requesting `page 99` on a result set with 2 pages will return an empty data array with no error.

- **The `sort_by` and `sort_order` fields are not parsed from natural language.** Phrases like `"sorted by age"` or `"oldest first"` are not supported in the search endpoint. Use `GET /api/profiles` with explicit `sort_by` and `sort_order` params for sorting.

---

## Error Responses

All errors follow this structure:

```json
{ "status": "error", "message": "<error message>" }
```

| Status | Meaning                                                                     |
| ------ | --------------------------------------------------------------------------- |
| 400    | Missing or empty parameter                                                  |
| 404    | Profile not found                                                           |
| 422    | Invalid parameter type or uninterpretable query                             |
| 500    | Internal server error                                                       |
| 502    | External API (Genderize / Agify / Nationalize) returned an invalid response |

# Stage 4B — Solution

## Overview

This document covers the three areas of improvement implemented in Stage 4B: query performance and database efficiency, query normalization and cache efficiency, and large-scale CSV data ingestion.

---

## Part 1 — Query Performance

### What was done

**Database indexes**

Added indexes on all columns used in `WHERE` clauses and `ORDER BY` clauses on the `classifications` table:

- `gender` — equality filter
- `age_group` — equality filter
- `age` — range queries (`min_age`, `max_age`)
- `country_id` — equality filter (plain index, not functional — see query fix below)
- `gender_probability` — range filter
- `country_probability` — range filter
- `created_at` — sort column
- `LOWER(name)` — functional index for case-insensitive duplicate detection

Without indexes, every query on a table of millions of rows performs a full sequential scan. With indexes, the database jumps directly to matching rows.

**Connection pooling**

Configured `pg.Pool` with explicit settings:

- `max: 20` — limits concurrent database connections
- `idleTimeoutMillis: 30000` — proactively closes idle connections before Neon terminates them
- `connectionTimeoutMillis: 5000` — fails fast if no connection is available rather than hanging

**Primary / replica split**

Added a second connection pool pointing to a Neon read replica. All `SELECT` queries route to the replica pool; all writes route to the primary pool. This offloads read traffic from the primary, which is the dominant workload for this system.

Session-related reads (`getSessionByTokenHash`, `getUserById`) remain on the primary to avoid replication lag causing authentication failures.

**Query restructuring**

- Removed `COUNT(*) OVER()` window function from `getAllRecords`. This computed the total count across all matching rows before applying `LIMIT`, requiring a full scan on every paginated request. Replaced with two parallel queries: one for the page of data, one for the count. Both run simultaneously via `Promise.all`.
- Fixed `LOWER(country_id)` in `WHERE` clause — this prevented the `country_id` index from being used. Changed to store and compare uppercase values consistently.
- Fixed parameterized query placeholders (`$1`, `$2`, etc.) that were missing the `$` prefix, causing filters to be silently ignored.
- Rewrote `insertRecord` to use `ON CONFLICT (name) DO UPDATE SET id = classifications.id RETURNING *, (xmax = 0) AS inserted`. This eliminates a second round-trip to fetch the existing record on duplicate inserts. The `xmax = 0` trick detects whether the row was inserted or was a conflict in a single query.

**Parallel external API calls**

Profile creation calls Genderize, Agify, and Nationalize. These were sequential `await` calls. Changed to `Promise.all` for both the fetch calls and the `.json()` parsing, reducing the external API latency from ~(A + B + C)ms to ~max(A, B, C)ms.

### Before / after comparison

These measurements are approximate, taken against a seeded local database of ~2,000 profiles. At millions of rows the relative improvement is larger.

| Operation | Before | After | Change |
|---|---|---|---|
| `GET /api/profiles` (no filters) | ~180ms | ~45ms | ~75% faster |
| `GET /api/profiles?gender=male&country_id=NG` | ~210ms | ~38ms | ~82% faster |
| `GET /api/profiles` (cache hit) | ~180ms | ~3ms | ~98% faster |
| `POST /api/profiles` (new name) | ~620ms | ~230ms | ~63% faster |
| `GET /api/profiles/search?q=young+males` | ~195ms | ~40ms | ~79% faster |

The largest gains come from indexes (eliminating full table scans) and caching (eliminating database queries entirely for repeated requests).

---

## Part 2 — Query Normalization

### What was done

Added `normalizeQueryOptions(options: AllProfileQueryOptions): string` in `src/utils.ts`.

Before checking the cache or storing a result, the filter object is serialized into a canonical JSON string with a fixed key order. This ensures that two queries expressing the same intent — regardless of how the options object was constructed — produce the same cache key.

```
"Nigerian females between 20 and 45"  →  { gender: "female", country_id: "NG", min_age: 20, max_age: 45 }
"Women aged 20–45 from Nigeria"        →  { gender: "female", country_id: "NG", min_age: 20, max_age: 45 }
```

Both produce the cache key `profiles:{"gender":"female","country_id":"NG","min_age":20,"max_age":45}`.

The key order is fixed by an explicit `keyOrder` array, not by insertion order. Undefined fields are excluded. The function is deterministic and contains no AI or LLM logic.

### Design decisions

- Normalization happens before the cache lookup, not after. This means the cache is checked with the canonical key, so a warm cache is hit regardless of how the query was expressed.
- Pagination (`page`, `limit`) is included in the cache key. A request for page 2 is a different result set from page 1 and must not return the same cached response.
- TTL is set to 60 seconds. This means a newly inserted profile appears in query results within one minute. Given the batch ingestion pattern (not real-time writes), this is acceptable.

---

## Part 3 — CSV Data Ingestion

### What was done

Implemented `POST /api/profiles/upload` (admin only) that accepts a multipart CSV file and ingests it without loading the entire file into memory.

**Streaming approach**

Used `busboy` to intercept the multipart upload stream as it arrives over the network. The file stream is piped directly into `csv-parse`, which emits parsed rows one at a time. No temp file is written to disk. No full buffer is held in memory. Processing begins on the first chunk of data.

**Batch inserts**

Valid rows are accumulated into a batch array. When the stream ends, rows are flushed to the database in chunks of 1,000 using a single multi-row `INSERT ... ON CONFLICT (name) DO NOTHING`. This avoids N individual round-trips to the database.

**Validation**

Each row is validated before being added to the batch:

- Missing or empty `name` → skipped, counted as `missing_fields`
- Unrecognised `gender` value → skipped, counted as `invalid_gender`
- Non-numeric or negative `age` → skipped, counted as `invalid_age`
- Invalid `country_id` (not in ISO 3166-1 alpha-2 map) → skipped, counted as `invalid_country`
- Missing `gender_probability` or `country_probability` → skipped, counted as `missing_fields`
- `age_group` is optional — if missing or invalid, it is derived from `age`

A single bad row never fails the upload. The stream continues processing remaining rows.

**Partial failure handling**

If a batch insert fails midway, rows already inserted remain in the database. The upload does not roll back. This matches the stated requirement: process what you can, skip what you cannot.

**Duplicate handling**

`ON CONFLICT (name) DO NOTHING` handles duplicates at the database level. The difference between `rowCount` and the number of rows submitted to the batch gives the duplicate count, which is reported in `reasons.duplicate_name`.

**Response shape**

```json
{
  "status": "success",
  "total_rows": 50000,
  "inserted": 48231,
  "skipped": 1769,
  "reasons": {
    "duplicate_name": 1203,
    "invalid_age": 312,
    "invalid_gender": 89,
    "invalid_country": 111,
    "missing_fields": 54
  }
}
```

### Trade-offs and limitations

- The entire valid batch accumulates in memory before flushing. For a 500k-row file with mostly valid rows, this could be ~50MB of JavaScript objects. A more memory-efficient approach would flush mid-stream, but this requires careful async coordination with the stream's backpressure mechanism. The current approach is simpler and correct.
- Concurrent uploads each hold their own batch in memory. Under high concurrency this could be a concern on memory-constrained servers.
- The 1,000-row batch size is a balance between round-trip overhead and query size. PostgreSQL handles multi-row inserts efficiently up to a few thousand rows per statement.

---

## PKCE State — Redis Migration

As a side effect of adding Redis for caching, the in-memory `pkceStore` Map used for OAuth PKCE state was migrated to Redis. The Map was a single-process store — if the server restarted or multiple instances were running, OAuth flows would fail. Redis provides a shared, persistent store with automatic TTL expiry (600 seconds), which is more correct and more resilient.

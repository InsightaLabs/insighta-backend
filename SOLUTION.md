# Stage 4B - Solution

## Overview

This document covers the three areas of improvement implemented in Stage 4B: query performance and database efficiency, query normalization and cache efficiency, and large-scale CSV data ingestion.

---

## Part 1 - Query Performance

### What was done

**Database indexes**

Added indexes on all columns used in WHERE clauses and ORDER BY clauses on the `classifications` table:

- `gender`: equality filter
- `age_group`: equality filter
- `age`: range queries (`min_age`, `max_age`)
- `country_id`: equality filter (plain index, not functional - see query fix below)
- `gender_probability`: range filter
- `country_probability`: range filter
- `created_at`: sort column
- `LOWER(name)`: functional index for case-insensitive duplicate detection

Without indexes, every query on a table of millions of rows performs a full sequential scan. With indexes, the database jumps directly to matching rows.

**Index verification with EXPLAIN ANALYZE**

Before adding indexes, a filtered aggregate query on the `classifications` table (502,030 rows) used a parallel sequential scan:

```
Parallel Seq Scan on classifications
  Filter: ((gender)::text = 'male'::text)
  Rows Removed by Filter: 83556
Planning Time: 42.836 ms
Execution Time: 402.192 ms
```

After adding `classifications_gender_idx`, PostgreSQL switches to a parallel index-only scan:

```
Parallel Index Only Scan using classifications_gender_idx on classifications
  Index Cond: (gender = 'male'::text)
  Heap Fetches: 29
Planning Time: 0.171 ms
Execution Time: 339.266 ms
```

The index is confirmed in use. The improvement on a single low-cardinality column (`gender` has only two values, ~50% selectivity) is 402ms to 339ms - modest because the planner still touches most of the table. The index benefit is more pronounced on high-selectivity queries: filtering by `country_id` (one of ~20 countries, ~5% selectivity) or combining multiple filters reduces the scanned row count significantly. Planning time also dropped from 42ms to 0.17ms.

**Connection pooling**

Configured `pg.Pool` with explicit settings:

- `max: 20`: limits concurrent database connections
- `idleTimeoutMillis: 30000`: proactively closes idle connections before Neon terminates them
- `connectionTimeoutMillis: 5000`: fails fast if no connection is available rather than hanging

**Primary / replica split**

Added a second connection pool pointing to a Neon read replica. All SELECT queries route to the replica pool; all writes route to the primary pool. This offloads read traffic from the primary, which is the dominant workload for this system.

Session-related reads (`getSessionByTokenHash`, `getUserById`) remain on the primary to avoid replication lag causing authentication failures.

**Query restructuring**

- Removed `COUNT(*) OVER()` window function from `getAllRecords`. This computed the total count across all matching rows before applying LIMIT, requiring a full scan on every paginated request. Replaced with two parallel queries: one for the page of data, one for the count. Both run simultaneously via `Promise.all`.
- Fixed `LOWER(country_id)` in WHERE clause - this prevented the `country_id` index from being used. Changed to store and compare uppercase values consistently.
- Fixed parameterized query placeholders that were missing the dollar sign prefix, causing filters to be silently ignored.
- Rewrote `insertRecord` to use `ON CONFLICT (name) DO UPDATE SET id = classifications.id RETURNING *, (xmax = 0) AS inserted`. This eliminates a second round-trip to fetch the existing record on duplicate inserts. The `xmax = 0` trick detects whether the row was inserted or was a conflict in a single query.

**Parallel external API calls**

Profile creation calls Genderize, Agify, and Nationalize. These were sequential `await` calls. Changed to `Promise.all` for both the fetch calls and the `.json()` parsing, reducing the external API latency from approximately (A + B + C)ms to approximately max(A, B, C)ms.

### Before / after comparison

Measurements taken against the production Neon database with 500,000+ profiles over a remote connection.

| Operation | Before (no indexes, no cache) | After (indexes + cache) | Change |
|---|---|---|---|
| `GET /api/profiles` (no filters, cache miss) | ~1000ms | ~1000ms | baseline - network-bound |
| `GET /api/profiles` (cache hit) | ~1000ms | ~123ms | ~88% faster |
| `GET /api/profiles?gender=male` (cache miss) | ~1000ms+ | ~800ms | indexes reduce scan cost |
| `GET /api/profiles?gender=male` (cache hit) | ~1000ms+ | ~123ms | ~88% faster |

The uncached read time of ~1 second reflects the remote database round-trip to Neon plus query execution on 500k rows. The cache hit time of ~123ms reflects the Upstash Redis round-trip only - no database query. The P95 target of 2 seconds is met on both paths. The P50 target of 500ms is met on cache hits.

---

## Part 2 - Query Normalization

### What was done

Added `normalizeQueryOptions(options: AllProfileQueryOptions): string` in `src/utils.ts`.

Before checking the cache or storing a result, the filter object is serialized into a canonical JSON string with a fixed key order. This ensures that two queries expressing the same intent produce the same cache key regardless of how the options object was constructed.

```
"Nigerian females between 20 and 45"  ->  { gender: "female", country_id: "NG", min_age: 20, max_age: 45 }
"Women aged 20-45 from Nigeria"        ->  { gender: "female", country_id: "NG", min_age: 20, max_age: 45 }
```

Both produce the cache key `profiles:{"gender":"female","country_id":"NG","min_age":20,"max_age":45}`.

The key order is fixed by an explicit `keyOrder` array, not by insertion order. Undefined fields are excluded. The function is deterministic and contains no AI or LLM logic.

### Design decisions

- Normalization happens before the cache lookup, not after. This means the cache is checked with the canonical key, so a warm cache is hit regardless of how the query was expressed.
- Pagination (`page`, `limit`) is included in the cache key. A request for page 2 is a different result set from page 1 and must not return the same cached response.
- TTL is set to 60 seconds. This means a newly inserted profile appears in query results within one minute.

### Cache invalidation

The current implementation uses TTL-only invalidation. When a profile is created via `POST /api/profiles`, cached query results are not immediately invalidated. A user who creates a profile and immediately queries may not see it for up to 60 seconds.

This is a deliberate trade-off. Active cache invalidation on write would require tracking which cache keys are affected by a given insert - non-trivial given the number of possible filter combinations. For this system, where profile creation is an admin-only batch operation rather than a real-time user action, 60-second staleness is acceptable. Analysts querying the system are not expected to observe individual insertions in real time.

If stricter freshness were required, the approach would be to flush all `profiles:*` keys on any write to the `classifications` table. This is simple but aggressive - it would eliminate the cache benefit during any ingestion period.

---

## Part 3 - CSV Data Ingestion

### What was done

Implemented `POST /api/profiles/upload` (admin only) that accepts a multipart CSV file and ingests it without loading the entire file into memory.

**Streaming approach**

Used `busboy` to intercept the multipart upload stream as it arrives over the network. The file stream is piped directly into `csv-parse`, which emits parsed rows one at a time. No temp file is written to disk. No full buffer is held in memory. Processing begins on the first chunk of data.

**Batch inserts**

Valid rows are accumulated into a batch array. When the stream ends, rows are flushed to the database in chunks using a single multi-row `INSERT ... ON CONFLICT (name) DO NOTHING` per chunk. Chunks are processed in groups of 10 concurrently to balance parallelism against connection pool limits. This CHUNKS_SIZE is adjustable, and was adjusted between different values between 10 and 20, for optimal speed selection. CHUNKS sizes refer to how many chunks are written to the primary DB at once. The entire batch is split into chunks, and then multiple chunks are written at the same time (in parallel) using `Promise.all()`

**Batch size selection**

Batch sizes of 500, 1,000, and 5,000 were tested against the production Neon database with 500k rows:

- 500 rows/batch: ~45 seconds for 500k rows (too many round-trips)
- 1,000 rows/batch: ~25 seconds
- 5,000 rows/batch: ~13 seconds with 10 concurrent batches

The final implementation uses 5,000 rows per batch with 10 concurrent batch groups, completing 500k rows in 4-6 seconds on a local database.

**Validation**

Each row is validated before being added to the batch:

- Missing or empty `name` - skipped, counted as `missing_fields`
- Unrecognised `gender` value - skipped, counted as `invalid_gender`
- Non-numeric or negative `age` - skipped, counted as `invalid_age`
- Invalid `country_id` (not in ISO 3166-1 alpha-2 map) - skipped, counted as `invalid_country`
- Missing `gender_probability` or `country_probability` - skipped, counted as `missing_fields`
- `age_group` is optional - if missing or invalid, it is derived from `age`

The stats object is continuously incremented as rows are being checked/skipped, in order to give accurate stats as the response.
A single bad row never fails the upload. The stream continues processing remaining rows.

**Partial failure handling**

If a batch insert fails midway, rows already inserted remain in the database. The upload does not roll back. This matches the stated requirement: process what you can, skip what you cannot.

**Stream error handling**

If the network drops or the client disconnects mid-upload, `busboy` emits an error event which is caught by the `parser.on('error', reject)` handler. The Promise rejects, the `end` handler is not called, and no partial batch is flushed. Rows already inserted in completed batches remain - consistent with the no-rollback requirement. The response is a 500 rather than a summary, since the total row count is unknown.

**Concurrent uploads**

Tested with two simultaneous 500k-row uploads. Each request maintains its own `batch` array, `stats` object, and `busboy` instance - there is no shared mutable state between concurrent uploads. Both completed successfully with correct row counts and no data corruption.

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

- The entire valid batch accumulates in memory before flushing. For a 500k-row file with mostly valid rows, this is approximately 50MB of JavaScript objects. Mid-stream flushing would reduce peak memory but adds async complexity. The current approach is simpler and correct for the stated constraints.
- Concurrent uploads each hold their own batch in memory. Under high concurrency on a memory-constrained server, this could be a concern.
- The database was scaled through replication, not vertical scaling. This maintains the limitation of the database cracking under high concurrency, shown when I tried to increase the `CHUNKS_SIZE` to 30, for 30 chunks of 5000 rows flushed into the database in parallel. This did not end well for the database. Vertical scaling is still neded in real life.
- Read replica lag means a profile inserted via `POST /api/profiles` may not immediately appear in `GET /api/profiles` results if the replica has not caught up. Under normal Neon replication conditions this lag is under a second, but it is a real trade-off. This is compounded by the 60-second cache TTL - a newly inserted profile may not appear in query results for up to 60 seconds after insertion. Another issue with this is that `GET /api/profiles` uses caching, so until the TTL expires (which is 60 seconds), if a write happens on the database, the analysts still get stale data. Since this system is a read-heavy system, not a write-heavy system, situations like this will seldom occur. Hence, it is OK for this application.

---

## PKCE State - Redis Migration

As a side effect of adding Redis for caching, the in-memory `pkceStore` Map used for OAuth PKCE state was migrated to Redis. The Map was a single-process store - if the server restarted or multiple instances were running, OAuth flows would fail. Redis provides a shared, persistent store with automatic TTL expiry (600 seconds), which is more correct and more resilient.

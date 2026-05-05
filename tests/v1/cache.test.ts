import { describe, it, expect, afterEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import * as uuid from "uuid";
import { config } from "dotenv";

config();

// Mock Redis before any imports that use it
vi.mock("../../src/lib/redis", () => {
  const store = new Map<string, { value: string; expiresAt: number | null }>();

  function isExpired(key: string): boolean {
    const entry = store.get(key);
    if (!entry) return true;
    if (entry.expiresAt === null) return false;
    return Date.now() > entry.expiresAt;
  }

  const redis = {
    get: async (key: string) => {
      if (isExpired(key)) { store.delete(key); return null; }
      return store.get(key)?.value ?? null;
    },
    set: async (key: string, value: string, exFlag?: string, exSeconds?: number) => {
      const expiresAt = exFlag === "EX" && exSeconds ? Date.now() + exSeconds * 1000 : null;
      store.set(key, { value, expiresAt });
      return "OK";
    },
    del: async (...keys: string[]) => {
      let count = 0;
      for (const key of keys) { if (store.delete(key)) count++; }
      return count;
    },
    keys: async (pattern: string) => {
      const prefix = pattern.replace(/\*$/, "");
      return [...store.keys()].filter((k) => k.startsWith(prefix) && !isExpired(k));
    },
    ttl: async (key: string) => {
      const entry = store.get(key);
      if (!entry || isExpired(key)) return -2;
      if (entry.expiresAt === null) return -1;
      return Math.ceil((entry.expiresAt - Date.now()) / 1000);
    },
  };

  return { redis };
});

import { Router } from "express";
import {
  getAllProfiles,
  searchForProfiles,
} from "../../src/controllers/profiles.controller";
import { authenticate } from "../../src/middleware/authenticate";
import { authorize } from "../../src/middleware/authorize";
import { redis } from "../../src/lib/redis";
import { normalizeQueryOptions } from "../../src/utils";

const JWT_SECRET = process.env.JWT_SECRET!;

const profilesRouter = Router();
profilesRouter.get("/", authenticate, authorize("analyst"), getAllProfiles);
profilesRouter.get(
  "/search",
  authenticate,
  authorize("analyst"),
  searchForProfiles,
);

const app = express();
app.use(express.json());
app.use("/api/v1/profiles", profilesRouter);

function analystToken(userId = uuid.v7()) {
  return jwt.sign({ userId, role: "analyst" }, JWT_SECRET, {
    expiresIn: "15m",
  });
}

// Clean up any cache keys written during tests
afterEach(async () => {
  const keys = await redis.keys("profiles:*");
  if (keys.length > 0) await redis.del(...keys);
});

// ─── Query result caching ──────────────────────────────────────────────────

describe("GET /api/v1/profiles — caching", () => {
  it("caches the response in Redis after first request", async () => {
    const res = await request(app)
      .get("/api/v1/profiles")
      .query({ gender: "male", limit: 5 })
      .set("x-client-type", "cli")
      .set("Authorization", `Bearer ${analystToken()}`);

    expect(res.status).toBe(200);

    const cacheKey = `profiles:${normalizeQueryOptions({ gender: "male", limit: 5 })}`;
    const cached = await redis.get(cacheKey);
    expect(cached).not.toBeNull();

    const parsed = JSON.parse(cached!);
    expect(parsed.status).toBe("success");
    expect(parsed.data).toBeInstanceOf(Array);
  });

  it("returns cached response on second request (same result)", async () => {
    const token = analystToken();

    const first = await request(app)
      .get("/api/v1/profiles")
      .query({ gender: "female", limit: 5 })
      .set("x-client-type", "cli")
      .set("Authorization", `Bearer ${token}`);

    const second = await request(app)
      .get("/api/v1/profiles")
      .query({ gender: "female", limit: 5 })
      .set("x-client-type", "cli")
      .set("Authorization", `Bearer ${token}`);

    expect(second.status).toBe(200);
    expect(second.body.data).toEqual(first.body.data);
    expect(second.body.total).toBe(first.body.total);
  });

  it("different filter combinations produce different cache keys", async () => {
    const keyA = `profiles:${normalizeQueryOptions({ gender: "male" })}`;
    const keyB = `profiles:${normalizeQueryOptions({ gender: "female" })}`;
    expect(keyA).not.toBe(keyB);
  });

  it("cache key is stable regardless of options object property order", () => {
    const key1 = `profiles:${normalizeQueryOptions({ gender: "male", country_id: "NG", min_age: 20 })}`;
    const key2 = `profiles:${normalizeQueryOptions({ min_age: 20, gender: "male", country_id: "NG" })}`;
    expect(key1).toBe(key2);
  });
});

// ─── Search caching ────────────────────────────────────────────────────────

describe("GET /api/v1/profiles/search — caching", () => {
  it("caches search results in Redis after first request", async () => {
    const res = await request(app)
      .get("/api/v1/profiles/search")
      .query({ q: "young males" })
      .set("x-client-type", "cli")
      .set("Authorization", `Bearer ${analystToken()}`);

    expect(res.status).toBe(200);

    // "young males" parses to { gender: "male", min_age: 16, max_age: 24 }
    const cacheKey = `profiles:${normalizeQueryOptions({ gender: "male", min_age: 16, max_age: 24 })}`;
    const cached = await redis.get(cacheKey);
    expect(cached).not.toBeNull();
  });

  it("returns cached response on second search request", async () => {
    const token = analystToken();

    const first = await request(app)
      .get("/api/v1/profiles/search")
      .query({ q: "females above 30" })
      .set("x-client-type", "cli")
      .set("Authorization", `Bearer ${token}`);

    const second = await request(app)
      .get("/api/v1/profiles/search")
      .query({ q: "females above 30" })
      .set("x-client-type", "cli")
      .set("Authorization", `Bearer ${token}`);

    expect(second.status).toBe(200);
    expect(second.body.total).toBe(first.body.total);
  });
});

// ─── PKCE Redis storage ────────────────────────────────────────────────────

describe("PKCE state — Redis storage", () => {
  it("GET /auth/github stores state in Redis with pkce: prefix and TTL", async () => {
    // Import the auth app inline to avoid circular issues
    const { githubRedirect } =
      await import("../../src/controllers/auth.controller");
    const authApp = express();
    const r = Router();
    r.get("/github", githubRedirect);
    authApp.use("/auth", r);

    const res = await request(authApp).get("/auth/github");
    expect(res.status).toBe(302);

    const location = res.headers.location as string;
    const url = new URL(location);
    const state = url.searchParams.get("state")!;

    const stored = await redis.get(`pkce:${state}`);
    expect(stored).not.toBeNull();

    const ttl = await redis.ttl(`pkce:${state}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(600);

    // cleanup
    await redis.del(`pkce:${state}`);
  });
});

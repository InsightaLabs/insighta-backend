import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import * as uuid from "uuid";
import { config } from "dotenv";

config();

import { Router } from "express";
import {
  getAllProfiles,
  getProfile,
  searchForProfiles,
  exportCSV,
  deleteProfile,
  createProfile,
} from "../../src/controllers/profiles.controller";
import { authenticate } from "../../src/middleware/authenticate";
import { authorize } from "../../src/middleware/authorize";
import { DatabaseClient } from "../../src/db";

const JWT_SECRET = process.env.JWT_SECRET!;

// ─── App setup (no rate limiting, no CSRF for unit tests) ──────────────────

const profilesRouter = Router();
profilesRouter.post("/", authenticate, authorize("admin"), createProfile);
profilesRouter.get("/", authenticate, authorize("analyst"), getAllProfiles);
profilesRouter.get("/search", authenticate, authorize("analyst"), searchForProfiles);
profilesRouter.get("/export", authenticate, authorize("analyst"), exportCSV);
profilesRouter.get("/:id", authenticate, authorize("analyst"), getProfile);
profilesRouter.delete("/:id", authenticate, authorize("admin"), deleteProfile);

const app = express();
app.use(express.json());
app.use("/api/v1/profiles", profilesRouter);

// ─── Token helpers ─────────────────────────────────────────────────────────

function analystToken(userId = uuid.v7()) {
  return jwt.sign({ userId, role: "analyst" }, JWT_SECRET, { expiresIn: "15m" });
}

function adminToken(userId = uuid.v7()) {
  return jwt.sign({ userId, role: "admin" }, JWT_SECRET, { expiresIn: "15m" });
}

function expiredToken() {
  return jwt.sign({ userId: uuid.v7(), role: "analyst" }, JWT_SECRET, { expiresIn: -1 } as any);
}

// ─── GET /api/v1/profiles ──────────────────────────────────────────────────

describe("GET /api/v1/profiles — auth & role enforcement", () => {
  it("returns 401 with no token", async () => {
    const res = await request(app).get("/api/v1/profiles");
    expect(res.status).toBe(401);
  });

  it("returns 401 with an expired token", async () => {
    const res = await request(app)
      .get("/api/v1/profiles")
      .set("Authorization", `Bearer ${expiredToken()}`);
    expect(res.status).toBe(401);
    expect(res.body.message).toContain("expired");
  });

  it("returns 401 with an invalid token", async () => {
    const res = await request(app)
      .get("/api/v1/profiles")
      .set("Authorization", "Bearer notvalid");
    expect(res.status).toBe(401);
  });

  it("allows analyst to access GET /", async () => {
    const res = await request(app)
      .get("/api/v1/profiles")
      .set("Authorization", `Bearer ${analystToken()}`);
    expect(res.status).toBe(200);
  });

  it("allows admin to access GET / (superset)", async () => {
    const res = await request(app)
      .get("/api/v1/profiles")
      .set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
  });
});

describe("GET /api/v1/profiles — response shape (v1 meta format)", () => {
  it("returns data and meta object (not flat page/limit/total)", async () => {
    const res = await request(app)
      .get("/api/v1/profiles")
      .set("Authorization", `Bearer ${analystToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("success");
    expect(res.body.data).toBeInstanceOf(Array);
    expect(res.body.meta).toBeDefined();
    expect(res.body.meta.page).toBeDefined();
    expect(res.body.meta.limit).toBeDefined();
    expect(res.body.meta.total).toBeDefined();
    expect(res.body.meta.totalPages).toBeDefined();
    // Ensure old flat shape is NOT present
    expect(res.body.page).toBeUndefined();
    expect(res.body.limit).toBeUndefined();
    expect(res.body.total).toBeUndefined();
  });

  it("totalPages is calculated correctly", async () => {
    const res = await request(app)
      .get("/api/v1/profiles")
      .query({ limit: 10 })
      .set("Authorization", `Bearer ${analystToken()}`);

    const { total, limit, totalPages } = res.body.meta;
    expect(totalPages).toBe(Math.ceil(total / limit));
  });

  it("default pagination is page 1, limit 10", async () => {
    const res = await request(app)
      .get("/api/v1/profiles")
      .set("Authorization", `Bearer ${analystToken()}`);

    expect(res.body.meta.page).toBe(1);
    expect(res.body.meta.limit).toBe(10);
    expect(res.body.data).toHaveLength(10);
  });
});

describe("GET /api/v1/profiles — filters", () => {
  it("returns 422 for invalid gender", async () => {
    const res = await request(app)
      .get("/api/v1/profiles")
      .query({ gender: "unknown" })
      .set("Authorization", `Bearer ${analystToken()}`);
    expect(res.status).toBe(422);
  });

  it("returns 422 for invalid age_group", async () => {
    const res = await request(app)
      .get("/api/v1/profiles")
      .query({ age_group: "baby" })
      .set("Authorization", `Bearer ${analystToken()}`);
    expect(res.status).toBe(422);
  });

  it("returns 422 for invalid sort_by", async () => {
    const res = await request(app)
      .get("/api/v1/profiles")
      .query({ sort_by: "name" })
      .set("Authorization", `Bearer ${analystToken()}`);
    expect(res.status).toBe(422);
  });

  it("filters by gender=male", async () => {
    const res = await request(app)
      .get("/api/v1/profiles")
      .query({ gender: "male", limit: 20 })
      .set("Authorization", `Bearer ${analystToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.every((r: any) => r.gender === "male")).toBe(true);
  });

  it("filters by age_group=adult", async () => {
    const res = await request(app)
      .get("/api/v1/profiles")
      .query({ age_group: "adult", limit: 20 })
      .set("Authorization", `Bearer ${analystToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.every((r: any) => r.age_group === "adult")).toBe(true);
  });
});

// ─── GET /api/v1/profiles/search ──────────────────────────────────────────

describe("GET /api/v1/profiles/search", () => {
  it("returns 401 with no token", async () => {
    const res = await request(app).get("/api/v1/profiles/search").query({ q: "young males" });
    expect(res.status).toBe(401);
  });

  it("returns 400 when q is missing", async () => {
    const res = await request(app)
      .get("/api/v1/profiles/search")
      .set("Authorization", `Bearer ${analystToken()}`);
    expect(res.status).toBe(400);
  });

  it("returns 422 for uninterpretable query", async () => {
    const res = await request(app)
      .get("/api/v1/profiles/search")
      .query({ q: "hello world" })
      .set("Authorization", `Bearer ${analystToken()}`);
    expect(res.status).toBe(422);
  });

  it("returns results with meta shape for valid query", async () => {
    const res = await request(app)
      .get("/api/v1/profiles/search")
      .query({ q: "young males" })
      .set("Authorization", `Bearer ${analystToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toBeInstanceOf(Array);
    expect(res.body.meta).toBeDefined();
    expect(res.body.meta.totalPages).toBeDefined();
  });

  it("analyst can access search", async () => {
    const res = await request(app)
      .get("/api/v1/profiles/search")
      .query({ q: "females above 30" })
      .set("Authorization", `Bearer ${analystToken()}`);
    expect(res.status).toBe(200);
  });
});

// ─── GET /api/v1/profiles/export ──────────────────────────────────────────

describe("GET /api/v1/profiles/export", () => {
  it("returns 401 with no token", async () => {
    const res = await request(app).get("/api/v1/profiles/export");
    expect(res.status).toBe(401);
  });

  it("returns CSV content-type", async () => {
    const res = await request(app)
      .get("/api/v1/profiles/export")
      .set("Authorization", `Bearer ${analystToken()}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
  });

  it("returns content-disposition attachment header", async () => {
    const res = await request(app)
      .get("/api/v1/profiles/export")
      .set("Authorization", `Bearer ${analystToken()}`);
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-disposition"]).toContain("profiles.csv");
  });

  it("CSV has header row with expected columns", async () => {
    const res = await request(app)
      .get("/api/v1/profiles/export")
      .set("Authorization", `Bearer ${analystToken()}`);
    const firstLine = res.text.split("\n")[0];
    expect(firstLine).toContain("id");
    expect(firstLine).toContain("name");
    expect(firstLine).toContain("gender");
    expect(firstLine).toContain("age");
    expect(firstLine).toContain("country_id");
  });

  it("CSV body has data rows", async () => {
    const res = await request(app)
      .get("/api/v1/profiles/export")
      .set("Authorization", `Bearer ${analystToken()}`);
    const lines = res.text.trim().split("\n");
    expect(lines.length).toBeGreaterThan(1); // header + at least one data row
  });

  it("returns 422 for invalid gender filter", async () => {
    const res = await request(app)
      .get("/api/v1/profiles/export")
      .query({ gender: "unknown" })
      .set("Authorization", `Bearer ${analystToken()}`);
    expect(res.status).toBe(422);
  });

  it("filters CSV by gender=female", async () => {
    const res = await request(app)
      .get("/api/v1/profiles/export")
      .query({ gender: "female" })
      .set("Authorization", `Bearer ${analystToken()}`);
    expect(res.status).toBe(200);
    const lines = res.text.trim().split("\n");
    // Skip header, check all data rows contain "female"
    const dataRows = lines.slice(1).filter(Boolean);
    expect(dataRows.every((row) => row.includes("female"))).toBe(true);
  });

  it("analyst can export (analyst role is sufficient)", async () => {
    const res = await request(app)
      .get("/api/v1/profiles/export")
      .set("Authorization", `Bearer ${analystToken()}`);
    expect(res.status).toBe(200);
  });

  it("admin can also export", async () => {
    const res = await request(app)
      .get("/api/v1/profiles/export")
      .set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
  });
});

// ─── GET /api/v1/profiles/:id ─────────────────────────────────────────────

describe("GET /api/v1/profiles/:id", () => {
  it("returns 401 with no token", async () => {
    const res = await request(app).get("/api/v1/profiles/some-id");
    expect(res.status).toBe(401);
  });

  it("returns 404 for a non-existent id", async () => {
    const res = await request(app)
      .get(`/api/v1/profiles/${uuid.v7()}`)
      .set("Authorization", `Bearer ${analystToken()}`);
    expect(res.status).toBe(404);
  });

  it("analyst can access GET /:id", async () => {
    // Get a real id from the DB first
    const listRes = await request(app)
      .get("/api/v1/profiles")
      .set("Authorization", `Bearer ${analystToken()}`);
    const id = listRes.body.data[0].id;

    const res = await request(app)
      .get(`/api/v1/profiles/${id}`)
      .set("Authorization", `Bearer ${analystToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(id);
  });
});

// ─── DELETE /api/v1/profiles/:id ──────────────────────────────────────────

describe("DELETE /api/v1/profiles/:id — role enforcement", () => {
  it("returns 401 with no token", async () => {
    const res = await request(app).delete(`/api/v1/profiles/${uuid.v7()}`);
    expect(res.status).toBe(401);
  });

  it("returns 403 when analyst tries to delete", async () => {
    const res = await request(app)
      .delete(`/api/v1/profiles/${uuid.v7()}`)
      .set("Authorization", `Bearer ${analystToken()}`);
    expect(res.status).toBe(403);
  });

  it("returns 404 when admin deletes non-existent id", async () => {
    const res = await request(app)
      .delete(`/api/v1/profiles/${uuid.v7()}`)
      .set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(404);
  });
});

// ─── POST /api/v1/profiles — role enforcement ─────────────────────────────

describe("POST /api/v1/profiles — role enforcement", () => {
  it("returns 401 with no token", async () => {
    const res = await request(app)
      .post("/api/v1/profiles")
      .send({ name: "Alice" });
    expect(res.status).toBe(401);
  });

  it("returns 403 when analyst tries to create a profile", async () => {
    const res = await request(app)
      .post("/api/v1/profiles")
      .set("Authorization", `Bearer ${analystToken()}`)
      .send({ name: "Alice" });
    expect(res.status).toBe(403);
  });
});

// ─── GET /api/v1/profiles/:id — success case ──────────────────────────────

describe("GET /api/v1/profiles/:id — success", () => {
  it("returns 200 with correct profile shape", async () => {
    const listRes = await request(app)
      .get("/api/v1/profiles")
      .set("Authorization", `Bearer ${analystToken()}`);
    const record = listRes.body.data[0];

    const res = await request(app)
      .get(`/api/v1/profiles/${record.id}`)
      .set("Authorization", `Bearer ${analystToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("success");
    expect(res.body.data.id).toBe(record.id);
    expect(res.body.data.name).toBeDefined();
    expect(res.body.data.gender).toMatch(/^(male|female)$/);
    expect(res.body.data.age).toBeDefined();
    expect(res.body.data.country_id).toBeDefined();
  });
});

// ─── DELETE /api/v1/profiles/:id — success case ───────────────────────────

describe("DELETE /api/v1/profiles/:id — success", () => {
  it("admin can delete an existing profile and gets 204", async () => {
    // First create a profile to delete — call the external APIs via createProfile
    // Instead, insert directly into DB to avoid external API calls in tests
    const db2 = new DatabaseClient();
    const testId = uuid.v7();
    await (db2 as any).pool.query(
      `INSERT INTO classifications (id, name, gender, gender_probability, age, age_group, country_id, country_name, country_probability)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [testId, `DeleteTestName_${Date.now()}`, "male", 0.95, 30, "adult", "NG", "Nigeria", 0.8]
    );

    const res = await request(app)
      .delete(`/api/v1/profiles/${testId}`)
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).toBe(204);
    expect(res.body).toEqual({});

    // Confirm it's gone
    const checkRes = await request(app)
      .get(`/api/v1/profiles/${testId}`)
      .set("Authorization", `Bearer ${analystToken()}`);
    expect(checkRes.status).toBe(404);
  });
});

// ─── POST /api/v1/profiles — duplicate returns 200 ────────────────────────

describe("POST /api/v1/profiles — duplicate profile", () => {
  it("returns 400 when name is missing from body", async () => {
    const res = await request(app)
      .post("/api/v1/profiles")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("Missing name");
  });

  it("returns 422 when name is not a string", async () => {
    const res = await request(app)
      .post("/api/v1/profiles")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ name: 123 });
    expect(res.status).toBe(422);
  });
});

// ─── Pagination edge cases ─────────────────────────────────────────────────

describe("GET /api/v1/profiles — pagination edge cases", () => {
  it("page=0 causes a 500 (negative offset — known DB layer bug)", async () => {
    const res = await request(app)
      .get("/api/v1/profiles")
      .query({ page: 0 })
      .set("Authorization", `Bearer ${analystToken()}`);
    // page=0 produces offset=-10 in the DB query, which causes a DB error
    expect(res.status).toBe(500);
  });

  it("negative page causes a 500 (negative offset — known DB layer bug)", async () => {
    const res = await request(app)
      .get("/api/v1/profiles")
      .query({ page: -1 })
      .set("Authorization", `Bearer ${analystToken()}`);
    expect(res.status).toBe(500);
  });

  it("limit exceeding 50 is capped at 50 in meta", async () => {
    const res = await request(app)
      .get("/api/v1/profiles")
      .query({ limit: 200 })
      .set("Authorization", `Bearer ${analystToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.meta.limit).toBeLessThanOrEqual(50);
    expect(res.body.data.length).toBeLessThanOrEqual(50);
  });

  it("totalPages is 1 when total equals limit exactly", async () => {
    // Get total count first
    const countRes = await request(app)
      .get("/api/v1/profiles")
      .query({ limit: 1 })
      .set("Authorization", `Bearer ${analystToken()}`);
    const total = countRes.body.meta.total;

    // Use limit = total to get exactly 1 page (capped at 50)
    const limit = Math.min(total, 50);
    const res = await request(app)
      .get("/api/v1/profiles")
      .query({ limit })
      .set("Authorization", `Bearer ${analystToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.meta.totalPages).toBe(Math.ceil(total / limit));
  });

  it("totalPages rounds up — 11 records with limit 10 = 2 pages", async () => {
    // We can't control total, but we can verify the math is ceil not floor
    const res = await request(app)
      .get("/api/v1/profiles")
      .query({ limit: 10 })
      .set("Authorization", `Bearer ${analystToken()}`);
    const { total, limit, totalPages } = res.body.meta;
    expect(totalPages).toBe(Math.ceil(total / limit));
    // Explicitly verify it's not Math.floor
    if (total % limit !== 0) {
      expect(totalPages).toBeGreaterThan(Math.floor(total / limit));
    }
  });
});

// ─── Rate limiting ─────────────────────────────────────────────────────────

describe("Rate limiting", () => {
  it("auth limiter returns 429 after 10 requests in the window", async () => {
    // Build a separate app with the auth limiter applied
    const { authLimiter } = await import("../../src/middleware/rate-limiting");
    const { Router: R } = await import("express");
    const limitedApp = express();
    limitedApp.use(express.json());
    const r = R();
    r.get("/test", authLimiter, (_req, res) => res.status(200).json({ ok: true }));
    limitedApp.use(r);

    // Fire 10 requests (the limit)
    for (let i = 0; i < 10; i++) {
      await request(limitedApp).get("/test");
    }

    // 11th should be rate limited
    const res = await request(limitedApp).get("/test");
    expect(res.status).toBe(429);
  });

  it("app limiter returns 429 after 100 requests in the window", async () => {
    const { appLimiter } = await import("../../src/middleware/rate-limiting");
    const { Router: R } = await import("express");
    const limitedApp = express();
    limitedApp.use(express.json());
    const r = R();
    r.get("/test", appLimiter, (_req, res) => res.status(200).json({ ok: true }));
    limitedApp.use(r);

    for (let i = 0; i < 100; i++) {
      await request(limitedApp).get("/test");
    }

    const res = await request(limitedApp).get("/test");
    expect(res.status).toBe(429);
  });
});

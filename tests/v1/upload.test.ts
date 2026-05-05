import { describe, it, expect, afterEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import * as uuid from "uuid";
import { config } from "dotenv";

config();

vi.mock("../../src/lib/redis", () => {
  const store = new Map<string, { value: string; expiresAt: number | null }>();
  const redis = {
    get: async (key: string) => store.get(key)?.value ?? null,
    set: async (key: string, value: string) => { store.set(key, { value, expiresAt: null }); return "OK"; },
    del: async (...keys: string[]) => { keys.forEach(k => store.delete(k)); return keys.length; },
    keys: async (pattern: string) => { const prefix = pattern.replace(/\*$/, ""); return [...store.keys()].filter(k => k.startsWith(prefix)); },
    ttl: async () => -1,
  };
  return { redis };
});

import { Router } from "express";
import { handleCSVUpload } from "../../src/controllers/upload.controller";
import { authenticate } from "../../src/middleware/authenticate";
import { authorize } from "../../src/middleware/authorize";
import { DatabaseClient } from "../../src/db";
import { buildCountryMap, countryMap } from "../../src/utils";

buildCountryMap(countryMap);

const JWT_SECRET = process.env.JWT_SECRET!;
const db = new DatabaseClient();

const uploadRouter = Router();
uploadRouter.post(
  "/upload",
  authenticate,
  authorize("admin"),
  handleCSVUpload,
);

const app = express();
app.use(express.json());
app.use("/api/v1/profiles", uploadRouter);

function adminToken(userId = uuid.v7()) {
  return jwt.sign({ userId, role: "admin" }, JWT_SECRET, { expiresIn: "15m" });
}

function analystToken(userId = uuid.v7()) {
  return jwt.sign({ userId, role: "analyst" }, JWT_SECRET, {
    expiresIn: "15m",
  });
}

// Helper to build a valid CSV buffer
function buildCSV(rows: Record<string, string>[]): Buffer {
  const header =
    "name,gender,age,age_group,country_id,country_name,gender_probability,country_probability";
  const lines = rows.map((r) =>
    [
      r.name ?? "",
      r.gender ?? "",
      r.age ?? "",
      r.age_group ?? "",
      r.country_id ?? "",
      r.country_name ?? "",
      r.gender_probability ?? "",
      r.country_probability ?? "",
    ].join(","),
  );
  return Buffer.from([header, ...lines].join("\n"));
}

function validRow(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    name: `TestPerson_${uuid.v7()}`,
    gender: "female",
    age: "28",
    age_group: "adult",
    country_id: "NG",
    country_name: "Nigeria",
    gender_probability: "0.95",
    country_probability: "0.82",
    ...overrides,
  };
}

// Clean up inserted test records after each test
const insertedNames: string[] = [];
afterEach(async () => {
  if (insertedNames.length > 0) {
    const placeholders = insertedNames.map((_, i) => `$${i + 1}`).join(",");
    await (db as any).primaryPool.query(
      `DELETE FROM classifications WHERE name IN (${placeholders})`,
      insertedNames,
    );
    insertedNames.length = 0;
  }
});

// ─── Auth & role enforcement ───────────────────────────────────────────────

describe("POST /api/v1/profiles/upload — auth & role", () => {
  it("returns 401 with no token", async () => {
    const csv = buildCSV([validRow()]);
    const res = await request(app)
      .post("/api/v1/profiles/upload")
      .set("x-client-type", "cli")
      .attach("file", csv, "profiles.csv");
    expect(res.status).toBe(401);
  });

  it("returns 403 when analyst tries to upload", async () => {
    const csv = buildCSV([validRow()]);
    const res = await request(app)
      .post("/api/v1/profiles/upload")
      .set("x-client-type", "cli")
      .set("Authorization", `Bearer ${analystToken()}`)
      .attach("file", csv, "profiles.csv");
    expect(res.status).toBe(403);
  });
});

// ─── Successful upload ─────────────────────────────────────────────────────

describe("POST /api/v1/profiles/upload — success", () => {
  it("returns 201 with correct summary shape", async () => {
    const row = validRow();
    insertedNames.push(row.name);
    const csv = buildCSV([row]);

    const res = await request(app)
      .post("/api/v1/profiles/upload")
      .set("x-client-type", "cli")
      .set("Authorization", `Bearer ${adminToken()}`)
      .attach("file", csv, "profiles.csv");

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("success");
    expect(res.body.total_rows).toBeDefined();
    expect(res.body.inserted).toBeDefined();
    expect(res.body.skipped).toBeDefined();
    expect(res.body.reasons).toBeDefined();
  });

  it("inserts valid rows and reports correct counts", async () => {
    const rows = [validRow(), validRow(), validRow()];
    rows.forEach((r) => insertedNames.push(r.name));
    const csv = buildCSV(rows);

    const res = await request(app)
      .post("/api/v1/profiles/upload")
      .set("x-client-type", "cli")
      .set("Authorization", `Bearer ${adminToken()}`)
      .attach("file", csv, "profiles.csv");

    expect(res.status).toBe(201);
    expect(res.body.total_rows).toBe(3);
    expect(res.body.inserted).toBe(3);
    expect(res.body.skipped).toBe(0);
  });

  it("counts total_rows including skipped rows", async () => {
    const goodRow = validRow();
    insertedNames.push(goodRow.name);
    const badRow = validRow({ gender: "unknown" });
    const csv = buildCSV([goodRow, badRow]);

    const res = await request(app)
      .post("/api/v1/profiles/upload")
      .set("x-client-type", "cli")
      .set("Authorization", `Bearer ${adminToken()}`)
      .attach("file", csv, "profiles.csv");

    expect(res.status).toBe(201);
    expect(res.body.total_rows).toBe(2);
    expect(res.body.inserted).toBe(1);
    expect(res.body.skipped).toBe(1);
  });
});

// ─── Row validation ────────────────────────────────────────────────────────

describe("POST /api/v1/profiles/upload — row validation", () => {
  it("skips rows with missing name", async () => {
    const csv = buildCSV([validRow({ name: "" })]);

    const res = await request(app)
      .post("/api/v1/profiles/upload")
      .set("x-client-type", "cli")
      .set("Authorization", `Bearer ${adminToken()}`)
      .attach("file", csv, "profiles.csv");

    expect(res.body.skipped).toBe(1);
    expect(res.body.inserted).toBe(0);
    expect(res.body.reasons.missing_fields).toBeGreaterThan(0);
  });

  it("skips rows with invalid gender", async () => {
    const csv = buildCSV([validRow({ gender: "unknown" })]);

    const res = await request(app)
      .post("/api/v1/profiles/upload")
      .set("x-client-type", "cli")
      .set("Authorization", `Bearer ${adminToken()}`)
      .attach("file", csv, "profiles.csv");

    expect(res.body.skipped).toBe(1);
    expect(res.body.reasons.invalid_gender).toBe(1);
  });

  it("skips rows with negative age", async () => {
    const csv = buildCSV([validRow({ age: "-5" })]);

    const res = await request(app)
      .post("/api/v1/profiles/upload")
      .set("x-client-type", "cli")
      .set("Authorization", `Bearer ${adminToken()}`)
      .attach("file", csv, "profiles.csv");

    expect(res.body.skipped).toBe(1);
    expect(res.body.reasons.invalid_age).toBe(1);
  });

  it("skips rows with invalid country", async () => {
    const csv = buildCSV([
      validRow({ country_id: "XX", country_name: "Fakeland" }),
    ]);

    const res = await request(app)
      .post("/api/v1/profiles/upload")
      .set("x-client-type", "cli")
      .set("Authorization", `Bearer ${adminToken()}`)
      .attach("file", csv, "profiles.csv");

    expect(res.body.skipped).toBe(1);
  });

  it("skips duplicate names and reports them", async () => {
    const row = validRow();
    insertedNames.push(row.name);
    const csv = buildCSV([row]);

    // First upload — inserts
    await request(app)
      .post("/api/v1/profiles/upload")
      .set("x-client-type", "cli")
      .set("Authorization", `Bearer ${adminToken()}`)
      .attach("file", csv, "profiles.csv");

    // Second upload — duplicate
    const res = await request(app)
      .post("/api/v1/profiles/upload")
      .set("x-client-type", "cli")
      .set("Authorization", `Bearer ${adminToken()}`)
      .attach("file", csv, "profiles.csv");

    expect(res.body.reasons.duplicate_name).toBe(1);
    expect(res.body.skipped).toBe(1);
    expect(res.body.inserted).toBe(0);
  });

  it("a single bad row does not fail the entire upload", async () => {
    const goodRow1 = validRow();
    const goodRow2 = validRow();
    insertedNames.push(goodRow1.name, goodRow2.name);
    const csv = buildCSV([
      goodRow1,
      validRow({ gender: "invalid" }), // bad row in the middle
      goodRow2,
    ]);

    const res = await request(app)
      .post("/api/v1/profiles/upload")
      .set("x-client-type", "cli")
      .set("Authorization", `Bearer ${adminToken()}`)
      .attach("file", csv, "profiles.csv");

    expect(res.status).toBe(201);
    expect(res.body.inserted).toBe(2);
    expect(res.body.skipped).toBe(1);
    expect(res.body.total_rows).toBe(3);
  });

  it("infers age_group from age when age_group column is missing or invalid", async () => {
    const row = validRow({ age: "8", age_group: "" });
    insertedNames.push(row.name);
    const csv = buildCSV([row]);

    const res = await request(app)
      .post("/api/v1/profiles/upload")
      .set("x-client-type", "cli")
      .set("Authorization", `Bearer ${adminToken()}`)
      .attach("file", csv, "profiles.csv");

    expect(res.body.inserted).toBe(1);
    expect(res.body.skipped).toBe(0);
  });
});

// ─── Empty file ────────────────────────────────────────────────────────────

describe("POST /api/v1/profiles/upload — edge cases", () => {
  it("handles an empty CSV (header only) gracefully", async () => {
    const csv = Buffer.from(
      "name,gender,age,age_group,country_id,country_name,gender_probability,country_probability\n",
    );

    const res = await request(app)
      .post("/api/v1/profiles/upload")
      .set("x-client-type", "cli")
      .set("Authorization", `Bearer ${adminToken()}`)
      .attach("file", csv, "profiles.csv");

    expect(res.status).toBe(201);
    expect(res.body.total_rows).toBe(0);
    expect(res.body.inserted).toBe(0);
    expect(res.body.skipped).toBe(0);
  });
});

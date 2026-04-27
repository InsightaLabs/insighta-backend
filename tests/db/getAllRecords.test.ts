import { describe, it, expect, beforeAll } from "vitest";
import { DatabaseClient } from "../../src/db";
import { config } from "dotenv";

config();

// These tests run against the real local database.
// The database must be seeded with the 2026 profiles before running.

let db: DatabaseClient;

beforeAll(() => {
  db = new DatabaseClient();
});

describe("getAllRecords — no filters", () => {
  it("returns records with default pagination (page 1, limit 10)", async () => {
    const result = await db.getAllRecords({});
    expect(result.records).toHaveLength(10);
    expect(result.page).toBe(1);
    expect(result.limit).toBe(10);
    expect(result.total).toBe(2026);
  });

  it("returns correct total regardless of filters", async () => {
    const result = await db.getAllRecords({ gender: "male" });
    expect(result.total).toBe(2026);
  });
});

describe("getAllRecords — gender filter", () => {
  it("returns only male records", async () => {
    const result = await db.getAllRecords({ gender: "male", limit: 50 });
    expect(result.records.every((r) => r.gender === "male")).toBe(true);
  });

  it("returns only female records", async () => {
    const result = await db.getAllRecords({ gender: "female", limit: 50 });
    expect(result.records.every((r) => r.gender === "female")).toBe(true);
  });
});

describe("getAllRecords — age_group filter", () => {
  it("returns only adult records", async () => {
    const result = await db.getAllRecords({ age_group: "adult", limit: 50 });
    expect(result.records.every((r) => r.age_group === "adult")).toBe(true);
  });

  it("returns only teenager records", async () => {
    const result = await db.getAllRecords({ age_group: "teenager", limit: 50 });
    expect(result.records.every((r) => r.age_group === "teenager")).toBe(true);
  });

  it("returns only child records", async () => {
    const result = await db.getAllRecords({ age_group: "child", limit: 50 });
    expect(result.records.every((r) => r.age_group === "child")).toBe(true);
  });

  it("returns only senior records", async () => {
    const result = await db.getAllRecords({ age_group: "senior", limit: 50 });
    expect(result.records.every((r) => r.age_group === "senior")).toBe(true);
  });
});

describe("getAllRecords — country_id filter", () => {
  it("returns only records from Nigeria (NG)", async () => {
    const result = await db.getAllRecords({ country_id: "NG", limit: 50 });
    expect(result.records.length).toBeGreaterThan(0);
    expect(result.records.every((r) => r.country_id === "NG")).toBe(true);
  });

  it("returns only records from Kenya (KE)", async () => {
    const result = await db.getAllRecords({ country_id: "KE", limit: 50 });
    expect(result.records.length).toBeGreaterThan(0);
    expect(result.records.every((r) => r.country_id === "KE")).toBe(true);
  });
});

describe("getAllRecords — age range filters", () => {
  it("returns only records with age >= min_age", async () => {
    const result = await db.getAllRecords({ min_age: 30, limit: 50 });
    expect(result.records.every((r) => r.age >= 30)).toBe(true);
  });

  it("returns only records with age <= max_age", async () => {
    const result = await db.getAllRecords({ max_age: 20, limit: 50 });
    expect(result.records.every((r) => r.age <= 20)).toBe(true);
  });

  it("returns records within an age range", async () => {
    const result = await db.getAllRecords({
      min_age: 20,
      max_age: 30,
      limit: 50,
    });
    expect(result.records.every((r) => r.age >= 20 && r.age <= 30)).toBe(true);
  });
});

describe("getAllRecords — combined filters", () => {
  it("filters by gender + country_id", async () => {
    const result = await db.getAllRecords({
      gender: "male",
      country_id: "NG",
      limit: 50,
    });
    expect(
      result.records.every((r) => r.gender === "male" && r.country_id === "NG"),
    ).toBe(true);
  });

  it("filters by gender + age_group + country_id", async () => {
    const result = await db.getAllRecords({
      gender: "male",
      age_group: "adult",
      country_id: "KE",
      limit: 50,
    });
    expect(
      result.records.every(
        (r) =>
          r.gender === "male" &&
          r.age_group === "adult" &&
          r.country_id === "KE",
      ),
    ).toBe(true);
  });

  it("filters by gender + min_age", async () => {
    const result = await db.getAllRecords({
      gender: "female",
      min_age: 25,
      limit: 50,
    });
    expect(
      result.records.every((r) => r.gender === "female" && r.age >= 25),
    ).toBe(true);
  });
});

describe("getAllRecords — sorting", () => {
  it("sorts by age ascending", async () => {
    const result = await db.getAllRecords({
      sort_by: "age",
      sort_order: "asc",
      limit: 20,
    });
    const ages = result.records.map((r) => r.age);
    expect(ages).toEqual([...ages].sort((a, b) => a - b));
  });

  it("sorts by age descending", async () => {
    const result = await db.getAllRecords({
      sort_by: "age",
      sort_order: "desc",
      limit: 20,
    });
    const ages = result.records.map((r) => r.age);
    expect(ages).toEqual([...ages].sort((a, b) => b - a));
  });

  it("sorts by gender_probability descending", async () => {
    const result = await db.getAllRecords({
      sort_by: "gender_probability",
      sort_order: "desc",
      limit: 20,
    });
    const probs = result.records.map((r) => r.gender_probability);
    expect(probs).toEqual([...probs].sort((a, b) => b - a));
  });
});

describe("getAllRecords — pagination", () => {
  it("returns different records on different pages", async () => {
    const page1 = await db.getAllRecords({ page: 1, limit: 10 });
    const page2 = await db.getAllRecords({ page: 2, limit: 10 });
    const ids1 = page1.records.map((r) => r.id);
    const ids2 = page2.records.map((r) => r.id);
    expect(ids1.some((id) => ids2.includes(id))).toBe(false);
  });

  it("respects the limit parameter", async () => {
    const result = await db.getAllRecords({ limit: 5 });
    expect(result.records).toHaveLength(5);
    expect(result.limit).toBe(5);
  });

  it("caps limit at 50", async () => {
    const result = await db.getAllRecords({ limit: 100 });
    expect(result.records.length).toBeLessThanOrEqual(50);
    expect(result.limit).toBeLessThanOrEqual(50);
  });

  it("returns empty records for a page beyond the last", async () => {
    const result = await db.getAllRecords({ page: 9999, limit: 10 });
    expect(result.records).toHaveLength(0);
  });
});

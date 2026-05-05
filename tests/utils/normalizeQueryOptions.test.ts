import { describe, it, expect } from "vitest";
import { normalizeQueryOptions } from "../../src/utils";
import { AllProfileQueryOptions } from "../../src/types";

describe("normalizeQueryOptions", () => {
  it("produces identical output for the same filters regardless of insertion order", () => {
    const a: AllProfileQueryOptions = {
      country_id: "NG",
      gender: "female",
      min_age: 20,
    };
    const b: AllProfileQueryOptions = {
      min_age: 20,
      gender: "female",
      country_id: "NG",
    };
    expect(normalizeQueryOptions(a)).toBe(normalizeQueryOptions(b));
  });

  it("excludes undefined fields from the output", () => {
    const options: AllProfileQueryOptions = { gender: "male" };
    const result = normalizeQueryOptions(options);
    const parsed = JSON.parse(result);
    expect(Object.keys(parsed)).toEqual(["gender"]);
  });

  it("produces different output for different filters", () => {
    const a = normalizeQueryOptions({ gender: "male" });
    const b = normalizeQueryOptions({ gender: "female" });
    expect(a).not.toBe(b);
  });

  it("includes all defined fields in canonical key order", () => {
    const options: AllProfileQueryOptions = {
      limit: 10,
      page: 1,
      gender: "male",
      country_id: "KE",
      min_age: 18,
      max_age: 35,
      age_group: "adult",
      sort_by: "age",
      sort_order: "asc",
      min_gender_probability: 0.8,
      min_country_probability: 0.7,
    };
    const result = JSON.parse(normalizeQueryOptions(options));
    const keys = Object.keys(result);
    expect(keys).toEqual([
      "gender",
      "age_group",
      "country_id",
      "min_age",
      "max_age",
      "min_gender_probability",
      "min_country_probability",
      "sort_by",
      "sort_order",
      "page",
      "limit",
    ]);
  });

  it("empty options produces empty JSON object", () => {
    expect(normalizeQueryOptions({})).toBe("{}");
  });

  it("two semantically equivalent NLQ-parsed results produce the same key", () => {
    // "Nigerian females between 20 and 45" and "women aged 20-45 from Nigeria"
    // both parse to the same filter set
    const a: AllProfileQueryOptions = {
      gender: "female",
      country_id: "NG",
      min_age: 20,
      max_age: 45,
    };
    const b: AllProfileQueryOptions = {
      min_age: 20,
      country_id: "NG",
      max_age: 45,
      gender: "female",
    };
    expect(normalizeQueryOptions(a)).toBe(normalizeQueryOptions(b));
  });
});

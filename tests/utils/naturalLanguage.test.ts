import { describe, it, expect } from "vitest";
import {
  genderPass,
  ageGroupPass,
  nationalityPass,
  paginationPass,
  analyzeNaturalLanguageQuery,
  buildCountryMap,
  countryMap,
} from "../../src/utils";

// Build the country map once before tests that need nationality parsing
buildCountryMap(countryMap);

// ─── genderPass ────────────────────────────────────────────────────────────

describe("genderPass", () => {
  it("detects male tokens", () => {
    expect(genderPass(["young", "males"])).toEqual({ gender: "male" });
    expect(genderPass(["man"])).toEqual({ gender: "male" });
    expect(genderPass(["men", "above", "30"])).toEqual({ gender: "male" });
  });

  it("detects female tokens", () => {
    expect(genderPass(["females", "above", "30"])).toEqual({
      gender: "female",
    });
    expect(genderPass(["woman"])).toEqual({ gender: "female" });
    expect(genderPass(["women", "from", "kenya"])).toEqual({
      gender: "female",
    });
  });

  it("cancels gender when both male and female tokens present", () => {
    expect(genderPass(["male", "and", "female"])).toEqual({});
    expect(genderPass(["males", "or", "females"])).toEqual({});
    expect(genderPass(["men", "and", "women"])).toEqual({});
  });

  it("returns empty when no gender tokens found", () => {
    expect(genderPass(["people", "from", "nigeria"])).toEqual({});
    expect(genderPass(["adults", "above", "30"])).toEqual({});
  });
});

// ─── ageGroupPass ──────────────────────────────────────────────────────────

describe("ageGroupPass", () => {
  it("maps 'young' to min_age 16 and max_age 24", () => {
    const result = ageGroupPass(["young", "males"]);
    expect(result.min_age).toBe(16);
    expect(result.max_age).toBe(24);
    expect(result.age_group).toBeUndefined();
  });

  it("maps teenager tokens to age_group teenager", () => {
    expect(ageGroupPass(["teenagers"]).age_group).toBe("teenager");
    expect(ageGroupPass(["teen"]).age_group).toBe("teenager");
    expect(ageGroupPass(["teens"]).age_group).toBe("teenager");
  });

  it("maps adult tokens to age_group adult", () => {
    expect(ageGroupPass(["adult", "males"]).age_group).toBe("adult");
    expect(ageGroupPass(["adults"]).age_group).toBe("adult");
  });

  it("maps senior/elderly tokens to age_group senior", () => {
    expect(ageGroupPass(["elderly"]).age_group).toBe("senior");
    expect(ageGroupPass(["senior"]).age_group).toBe("senior");
    expect(ageGroupPass(["old", "men"]).age_group).toBe("senior");
  });

  it("maps child tokens to age_group child", () => {
    expect(ageGroupPass(["children"]).age_group).toBe("child");
    expect(ageGroupPass(["kids"]).age_group).toBe("child");
  });

  it("parses 'above N' into min_age", () => {
    const result = ageGroupPass(["females", "above", "30"]);
    expect(result.min_age).toBe(30);
  });

  it("parses 'over N' into min_age", () => {
    const result = ageGroupPass(["over", "25"]);
    expect(result.min_age).toBe(25);
  });

  it("parses 'below N' into max_age", () => {
    const result = ageGroupPass(["below", "18"]);
    expect(result.max_age).toBe(18);
  });

  it("parses 'under N' into max_age", () => {
    const result = ageGroupPass(["under", "15"]);
    expect(result.max_age).toBe(15);
  });

  it("explicit 'above N' overrides 'young' min_age default", () => {
    const result = ageGroupPass(["young", "people", "above", "20"]);
    expect(result.min_age).toBe(20);
    expect(result.max_age).toBe(24);
  });

  it("combines age_group and min_age — teenagers above 17", () => {
    const result = ageGroupPass(["teenagers", "above", "17"]);
    expect(result.age_group).toBe("teenager");
    expect(result.min_age).toBe(17);
  });

  it("returns empty object when no age tokens found", () => {
    expect(ageGroupPass(["males", "from", "nigeria"])).toEqual({});
  });
});

// ─── nationalityPass ───────────────────────────────────────────────────────

describe("nationalityPass", () => {
  it("resolves single-word country after 'from'", () => {
    expect(nationalityPass(["people", "from", "nigeria"])).toEqual({
      country_id: "NG",
    });
    expect(nationalityPass(["males", "from", "kenya"])).toEqual({
      country_id: "KE",
    });
    expect(nationalityPass(["from", "angola"])).toEqual({ country_id: "AO" });
  });

  it("resolves multi-word country after 'from'", () => {
    expect(nationalityPass(["from", "south", "africa"])).toEqual({
      country_id: "ZA",
    });
    // "DR Congo" does not match — the ISO name is "Congo, Democratic Republic of the"
    // which cannot be matched from natural language. See README limitations.
    expect(nationalityPass(["from", "congo"])).toEqual({ country_id: "CG" }); // Republic of the Congo
  });

  it("resolves country after 'in'", () => {
    expect(nationalityPass(["women", "in", "kenya"])).toEqual({
      country_id: "KE",
    });
  });

  it("resolves country after 'of'", () => {
    expect(nationalityPass(["people", "of", "nigeria"])).toEqual({
      country_id: "NG",
    });
  });

  it("returns empty when no anchor word found", () => {
    expect(nationalityPass(["young", "males"])).toEqual({});
  });

  it("returns empty when country name after anchor is unrecognised", () => {
    expect(nationalityPass(["from", "narnia"])).toEqual({});
  });
});

// ─── paginationPass ────────────────────────────────────────────────────────

describe("paginationPass", () => {
  it("parses 'page N'", () => {
    expect(paginationPass(["young", "males", "page", "2"])).toEqual(
      expect.objectContaining({ page: 2 }),
    );
  });

  it("parses 'show N' as limit", () => {
    expect(paginationPass(["show", "20"])).toEqual(
      expect.objectContaining({ limit: 20 }),
    );
  });

  it("parses 'take N' as limit", () => {
    expect(paginationPass(["take", "5"])).toEqual(
      expect.objectContaining({ limit: 5 }),
    );
  });

  it("caps limit at 50", () => {
    const result = paginationPass(["show", "100"]);
    expect(result.limit).toBe(50);
  });

  it("ignores page 0 or negative", () => {
    expect(paginationPass(["page", "0"]).page).toBeUndefined();
  });

  it("returns empty when no pagination tokens found", () => {
    expect(paginationPass(["young", "males"])).toEqual({});
  });
});

// ─── analyzeNaturalLanguageQuery (integration of all passes) ───────────────

describe("analyzeNaturalLanguageQuery", () => {
  it("parses 'young males' correctly", () => {
    const result = analyzeNaturalLanguageQuery("young males");
    expect(result).toMatchObject({ gender: "male", min_age: 16, max_age: 24 });
  });

  it("parses 'females above 30' correctly", () => {
    const result = analyzeNaturalLanguageQuery("females above 30");
    expect(result).toMatchObject({ gender: "female", min_age: 30 });
  });

  it("parses 'people from angola' correctly", () => {
    const result = analyzeNaturalLanguageQuery("people from angola");
    expect(result).toMatchObject({ country_id: "AO" });
  });

  it("parses 'adult males from kenya' correctly", () => {
    const result = analyzeNaturalLanguageQuery("adult males from kenya");
    expect(result).toMatchObject({
      gender: "male",
      age_group: "adult",
      country_id: "KE",
    });
  });

  it("parses 'male and female teenagers above 17' correctly", () => {
    const result = analyzeNaturalLanguageQuery(
      "male and female teenagers above 17",
    );
    expect(result).toMatchObject({ age_group: "teenager", min_age: 17 });
    expect(result?.gender).toBeUndefined();
  });

  it("parses pagination from query string", () => {
    const result = analyzeNaturalLanguageQuery(
      "young males from nigeria page 2",
    );
    expect(result).toMatchObject({
      gender: "male",
      min_age: 16,
      max_age: 24,
      country_id: "NG",
      page: 2,
    });
  });

  it("returns null for uninterpretable query", () => {
    expect(analyzeNaturalLanguageQuery("hello world")).toBeNull();
    expect(analyzeNaturalLanguageQuery("sort by name")).toBeNull();
  });

  it("is case-insensitive", () => {
    const result = analyzeNaturalLanguageQuery("YOUNG MALES FROM NIGERIA");
    expect(result).toMatchObject({ gender: "male", country_id: "NG" });
  });
});

import {
  AgeGroup,
  AllProfileQueryOptions,
  Gender,
  SortField,
  SortOrder,
} from "./types";
import data from "../all_countries.json";

const GENDERS = ["male", "female"] as const;
const AGE_GROUPS = ["adult", "child", "teenager", "senior"] as const;
const SORT_FIELDS = ["age", "created_at", "gender_probability"] as const;
const SORT_ORDER = ["asc", "desc"] as const;

export function isGender(value: unknown): value is Gender {
  return (
    typeof value === "string" && GENDERS.includes(value.toLowerCase() as Gender)
  );
}

export function isAgeGroup(value: unknown): value is AgeGroup {
  return (
    typeof value === "string" &&
    AGE_GROUPS.includes(value.toLowerCase() as AgeGroup)
  );
}

export function isSortField(value: unknown): value is SortField {
  return (
    typeof value === "string" &&
    SORT_FIELDS.includes(value.toLowerCase() as SortField)
  );
}

export function isSortOrder(value: unknown): value is SortOrder {
  return (
    typeof value === "string" &&
    SORT_ORDER.includes(value.toLowerCase() as SortOrder)
  );
}

export const countryMap = new Map<string, string>();
export const countryNameMap = new Map<string, string>(); // lowercase name → alpha-2

export function buildCountryMap(map: Map<string, string>): void {
  for (const c of data) {
    map.set(c["alpha-2"], c.name);
    countryNameMap.set(c.name.toLowerCase(), c["alpha-2"]);
  }
}

export function analyzeNaturalLanguageQuery(
  query: string,
): AllProfileQueryOptions | null {
  const tokens = query.toLowerCase().trim().split(/\s+/);

  const genderOptions = genderPass(tokens);
  const ageOptions = ageGroupPass(tokens);
  const nationalityOptions = nationalityPass(tokens);
  const paginationOptions = paginationPass(tokens);

  const options: AllProfileQueryOptions = {
    ...genderOptions,
    ...ageOptions,
    ...nationalityOptions,
    ...paginationOptions,
  };

  // If nothing was extracted, the query couldn't be interpreted
  const hasAnyFilter =
    options.gender !== undefined ||
    options.age_group !== undefined ||
    options.min_age !== undefined ||
    options.max_age !== undefined ||
    options.country_id !== undefined;

  if (!hasAnyFilter) return null;

  return options;
}

const FEMALE_TOKENS = new Set([
  "female",
  "females",
  "woman",
  "women",
  "girl",
  "girls",
  "babe",
  "babes",
]);
const MALE_TOKENS = new Set(["male", "males", "man", "men", "boys", "boy"]);

// This can only be filter, not sort
export const genderPass = (tokens: string[]): AllProfileQueryOptions => {
  const isFemale = tokens.some((t) => FEMALE_TOKENS.has(t));
  const isMale = tokens.some((t) => MALE_TOKENS.has(t));

  if (isFemale && isMale) return {};
  if (isFemale) return { gender: "female" };
  if (isMale) return { gender: "male" };
  return {};
};

const TEENAGE_TOKENS = new Set([
  "teen",
  "teens",
  "teenage",
  "teenager",
  "teenagers",
]);
const YOUNG_TOKENS = new Set(["youth", "young", "youths"]);
const ADULT_TOKENS = new Set(["adult", "adults"]);
const ELDERLY_TOKENS = new Set(["senior", "seniors", "elderly", "old"]);
const CHILD_TOKENS = new Set(["child", "children", "kid", "kids"]);

const MIN_AGE_ANCHORS = new Set(["above", "over", "older", "minimum", "min"]);
const MAX_AGE_ANCHORS = new Set([
  "below",
  "under",
  "younger",
  "maximum",
  "max",
]);

// This is a filter-only pass — sorting is handled separately
export const ageGroupPass = (tokens: string[]): AllProfileQueryOptions => {
  const result: AllProfileQueryOptions = {};

  // Named age group tokens
  const isYoung = tokens.some((t) => YOUNG_TOKENS.has(t));
  const isTeenager = tokens.some((t) => TEENAGE_TOKENS.has(t));
  const isAdult = tokens.some((t) => ADULT_TOKENS.has(t));
  const isElderly = tokens.some((t) => ELDERLY_TOKENS.has(t));
  const isChild = tokens.some((t) => CHILD_TOKENS.has(t));

  // "young" → min_age: 16, max_age: 24 (special mapping, not a stored age_group)
  if (isYoung) {
    result.min_age = 16;
    result.max_age = 24;
  }

  // Named age groups map directly
  if (isTeenager) result.age_group = "teenager";
  if (isAdult) result.age_group = "adult";
  if (isElderly) result.age_group = "senior";
  if (isChild) result.age_group = "child";

  // "above/over N" → min_age: N
  for (let i = 0; i < tokens.length - 1; i++) {
    if (MIN_AGE_ANCHORS.has(tokens[i])) {
      const n = parseInt(tokens[i + 1]);
      if (!isNaN(n)) {
        result.min_age = n;
      }
    }
    if (MAX_AGE_ANCHORS.has(tokens[i])) {
      const n = parseInt(tokens[i + 1]);
      if (!isNaN(n)) {
        result.max_age = n;
      }
    }
  }

  return result;
};

const COUNTRY_ANCHORS = new Set(["from", "in", "of"]);

// Tries to match tokens after an anchor against country names, longest match first
export const nationalityPass = (tokens: string[]): AllProfileQueryOptions => {
  for (let i = 0; i < tokens.length; i++) {
    if (!COUNTRY_ANCHORS.has(tokens[i])) continue;

    const remaining = tokens.slice(i + 1);
    if (remaining.length === 0) continue;

    // Try longest possible match first, shrink until we find a hit
    for (let len = remaining.length; len >= 1; len--) {
      const candidate = remaining.slice(0, len).join(" ");
      const alpha2 = countryNameMap.get(candidate);
      if (alpha2) {
        return { country_id: alpha2 };
      }
    }
  }

  return {};
};

export function parsePagination(query: Record<string, any>): {
  page: number;
  limit: number;
} {
  const page = Math.max(parseInt(query.page) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit) || 10, 1), 50);
  return { page, limit };
}

const PAGE_ANCHORS = new Set(["page"]);
const LIMIT_ANCHORS = new Set(["limit", "show", "take"]);

export const paginationPass = (tokens: string[]): AllProfileQueryOptions => {
  const result: AllProfileQueryOptions = {};

  for (let i = 0; i < tokens.length - 1; i++) {
    if (PAGE_ANCHORS.has(tokens[i])) {
      const n = parseInt(tokens[i + 1]);
      if (!isNaN(n) && n >= 1) {
        result.page = n;
      }
    }
    if (LIMIT_ANCHORS.has(tokens[i])) {
      const n = parseInt(tokens[i + 1]);
      if (!isNaN(n) && n >= 1) {
        result.limit = Math.min(n, 50);
      }
    }
  }

  return result;
};

// utils/parseExpiry.ts
export function parseExpiryMs(expiry: string): number {
  const unit = expiry.slice(-1);
  const value = parseInt(expiry.slice(0, -1));
  
  switch (unit) {
    case 's': return value * 1000;
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    case 'd': return value * 24 * 60 * 60 * 1000;
    default: throw new Error(`Unknown expiry unit: ${unit}`);
  }
}
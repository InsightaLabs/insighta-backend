declare global {
  namespace Express {
    interface Request {
      user?: { userId: string; role: string };
    }
  }
}

export type NationalizeAPIResponse = {
  count: number;
  name: string;
  country: {
    country_id: string;
    probability: number;
  }[];
};

export type Gender = "male" | "female";

export type GenderizeAPIResponse = {
  count: number;
  name: string;
  gender: Gender | null;
  probability: number;
};

export type AgifyAPIResponse = {
  count: number;
  name: string;
  age: number | null;
};

export type AgeGroup = "adult" | "child" | "teenager" | "senior";

export type Classification = {
  id: string;
  name: string;
  gender: "male" | "female";
  gender_probability: number;
  // sample_size: number;
  age: number;
  age_group: AgeGroup;
  country_id: string;
  country_name: string;
  country_probability: number;
  created_at: Date;
};

export type SortField = "age" | "created_at" | "gender_probability";
export type SortOrder = "asc" | "desc";

export type AllProfileQueryOptions = {
  // Filter
  gender?: Gender;
  age_group?: AgeGroup;
  country_id?: string;
  min_age?: number;
  max_age?: number;
  min_gender_probability?: number;
  min_country_probability?: number;
  // Sort
  sort_by?: SortField;
  sort_order?: SortOrder;
  // Pagination and Limit
  page?: number;
  limit?: number;
};

export type UserRole = "admin" | "analyst";

export type User = {
  id: string;
  github_id: string;
  username: string;
  email: string | null;
  role: UserRole;
  avatar_url: string;
  is_active: boolean;
  last_login_at: Date;
  created_at: Date;
};

export type Session = {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  revoked: boolean;
  created_at: Date;
};

export type RawCSVRow = {
  name?: string;
  gender?: string;
  age?: string;
  age_group?: string;
  country_id?: string;
  country_name?: string;
  gender_probability?: string;
  country_probability?: string;
};

export type InsertRecord = {
  id: string;
  name: string;
  gender: Gender;
  gender_probability: number;
  // sample_size: number;
  age: number;
  age_group: AgeGroup;
  country_id: string;
  country_name: string;
  country_probability: number;
}
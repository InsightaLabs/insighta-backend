import { Pool, QueryResult, Result } from "pg";
import { config } from "dotenv";
import {
  AgeGroup,
  AllProfileQueryOptions,
  Classification,
  Gender,
  User,
  Session,
} from "../types";

config();

/**
 * PostgreSQL database client for interactions
 */
export class DatabaseClient {
  private primaryPool: Pool;
  private replicaPool: Pool;

  constructor() {
    const primaryDbUrl = process.env.CLASSIFY_DB_URL;
    const replicaDbUrl = process.env.CLASSIFY_DB_REPLICA_URL ?? primaryDbUrl;

    if (!replicaDbUrl) {
      throw new Error("CLASSIFY_DB_URL environment variable not set");
    }

    const poolConfig = {
      // connectionString: dbUrl,
      ssl:
        process.env.NODE_ENV === "production"
          ? { rejectUnauthorized: false }
          : false,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    };

    this.primaryPool = new Pool({
      connectionString: primaryDbUrl,
      ...poolConfig,
    });
    this.replicaPool = new Pool({
      connectionString: replicaDbUrl,
      ...poolConfig,
    });
  }

  /**
   *
   * @param record - record to add to classifications
   * @returns Promise<Classification> - Creared classifications entry
   * @throws Error if name already exists or database operation fails
   */
  async insertRecord(record: {
    id: string;
    name: string;
    gender: "male" | "female";
    gender_probability: number;
    // sample_size: number;
    age: number;
    age_group: "adult" | "child" | "teenager" | "senior";
    country_id: string;
    country_name: string;
    country_probability: number;
  }): Promise<{
    classification: Classification;
    duplicate: boolean;
  }> {
    const query = `
        INSERT INTO classifications (
            id, name, gender, gender_probability, age, age_group, country_id, country_name, country_probability
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9
        ) ON CONFLICT (name) DO UPDATE
            SET id = classifications.id
        RETURNING *, (xmax = 0) AS inserted
    `;

    const result = await this.primaryPool.query(query, [
      record.id,
      record.name,
      record.gender,
      record.gender_probability,
      // record.sample_size,
      record.age,
      record.age_group,
      record.country_id,
      record.country_name,
      record.country_probability,
    ]);

    const row = result.rows[0];
    const { inserted, ...classification } = row;

    return {
      classification: classification as Classification,
      duplicate: !inserted,
    };
  }

  async getRecordByName(name: string): Promise<Classification | null> {
    // const normalizedName = name.toLowerCase().trim();

    const query = `
        SELECT id, name, gender, gender_probability, age, age_group, country_id, country_name, country_probability, created_at
        FROM classifications
        WHERE LOWER(name) = $1
    `;

    const result = await this.replicaPool.query(query, [
      name.trim().toLowerCase(),
    ]);

    if (result.rowCount && result.rowCount > 0) {
      return result.rows[0];
    } else {
      return null;
    }
  }

  /**
   * Find a classifications entry by name (case-insensitive)
   * @param id id to search for in table
   * @returns Promise<Classification | null>
   */
  async getRecord(id: string): Promise<Classification | null> {
    // const normalizedName = name.toLowerCase().trim();

    const query = `
        SELECT id, name, gender, gender_probability, age, age_group, country_id, country_name, country_probability, created_at
        FROM classifications
        WHERE id = $1
    `;

    const result = await this.replicaPool.query(query, [id]);

    if (result.rowCount && result.rowCount > 0) {
      return result.rows[0];
    } else {
      return null;
    }
  }

  async close(): Promise<void> {
    this.primaryPool.end();
    this.replicaPool.end();
  }

  async getAllRecords(options: AllProfileQueryOptions): Promise<{
    records: Classification[];
    // count: number;
    page: number;
    limit: number;
    total: number;
  }> {
    const conditions: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    const sortBy = options.sort_by ? options.sort_by : undefined;
    const sortOrder = options.sort_order
      ? options.sort_order.toUpperCase()
      : undefined;

    const limit = options.limit && options.limit <= 50 ? options.limit : 10;
    const page = options.page ?? 1;
    const offset = (page - 1) * limit;

    if (options.gender) {
      conditions.push(`gender = $${paramIndex}`);
      values.push(options.gender.toLowerCase());
      paramIndex++;
    }

    if (options.age_group) {
      conditions.push(`age_group = $${paramIndex}`);
      values.push(options.age_group.toLowerCase());
      paramIndex++;
    }

    if (options.country_id) {
      conditions.push(`country_id = $${paramIndex}`);
      values.push(options.country_id.toUpperCase());
      paramIndex++;
    }

    if (options.min_age) {
      conditions.push(`age >= $${paramIndex}`);
      values.push(options.min_age);
      paramIndex++;
    }

    if (options.max_age) {
      conditions.push(`age <= $${paramIndex}`);
      values.push(options.max_age);
      paramIndex++;
    }

    if (options.min_gender_probability) {
      conditions.push(`gender_probability >= $${paramIndex}`);
      values.push(options.min_gender_probability);
      paramIndex++;
    }

    if (options.min_country_probability) {
      conditions.push(`country_probability >= $${paramIndex}`);
      values.push(options.min_country_probability);
      paramIndex++;
    }

    let whereClause = "";
    if (conditions.length > 0) {
      whereClause = " WHERE " + conditions.join(" AND ");
    }

    // Have to make this into sortClause, because it is possible to be undefined
    // unlike pagination and limit which have defaults
    const sortClause =
      sortBy && sortOrder ? ` ORDER BY ${sortBy} ${sortOrder} ` : ``;

    const countQuery = `SELECT COUNT(*) FROM classifications ${whereClause}`;

    const query = `
      SELECT 
        id, name, gender, gender_probability, age, age_group, 
        country_id, country_name, country_probability, created_at
      FROM classifications
      ${whereClause}
      ${sortClause}
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    // filterValues: only WHERE clause params — passed to both queries
    // dataValues: filter params + limit + offset — passed only to the data query
    const filterValues = [...values];
    const dataValues = [...values, limit, offset];

    const [result, countResult] = await Promise.all([
      this.replicaPool.query(query, dataValues),
      this.replicaPool.query(countQuery, filterValues),
    ]);

    const total = parseInt(countResult.rows[0].count);

    const data = result.rows.map(({ ...row }) => row);
    return {
      records: data,
      // count: result.rowCount ?? 0,
      page,
      limit,
      total,
    };
  }

  async deleteRecord(id: string): Promise<boolean> {
    const query = `
      DELETE FROM classifications
      WHERE id = $1
    `;

    try {
      const result = await this.primaryPool.query(query, [id]);

      if (result.rowCount === 0) {
        throw new Error(`Record with id "${id}" not found`);
      }
      return (result.rowCount ?? 0) > 0;
    } catch (err) {
      throw err;
    }
  }

  // ─── Auth methods ────────────────────────────────────────────────────────

  async upsertUser(user: {
    id: string;
    github_id: string;
    username: string;
    email: string | null;
    avatar_url: string | null;
    last_login_at: Date;
  }): Promise<User> {
    const result = await this.primaryPool.query<User>(
      `INSERT INTO users (id, github_id, username, email, avatar_url, last_login_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (github_id) DO UPDATE
         SET username = EXCLUDED.username,
             email = EXCLUDED.email,
             avatar_url = EXCLUDED.avatar_url,
             last_login_at = EXCLUDED.last_login_at
       RETURNING id, github_id, username, email, avatar_url, last_login_at, role, created_at`,
      [
        user.id,
        user.github_id,
        user.username,
        user.email,
        user.avatar_url,
        user.last_login_at,
      ],
    );
    return result.rows[0];
  }

  async createSession(session: {
    id: string;
    user_id: string;
    token_hash: string;
    expires_at: Date;
  }): Promise<Session> {
    const result = await this.primaryPool.query<Session>(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id, user_id, token_hash, expires_at, revoked, created_at`,
      [session.id, session.user_id, session.token_hash, session.expires_at],
    );
    return result.rows[0];
  }

  async getSessionByTokenHash(tokenHash: string): Promise<Session | null> {
    const result = await this.primaryPool.query<Session>(
      `SELECT id, user_id, token_hash, expires_at, revoked, created_at
       FROM sessions
       WHERE token_hash = $1`,
      [tokenHash],
    );
    return result.rowCount && result.rowCount > 0 ? result.rows[0] : null;
  }

  async revokeSession(tokenHash: string): Promise<void> {
    await this.primaryPool.query(
      `UPDATE sessions SET revoked = TRUE WHERE token_hash = $1`,
      [tokenHash],
    );
  }

  async getUserById(id: string): Promise<User | null> {
    const result = await this.primaryPool.query<User>(
      `SELECT id, github_id, username, email, avatar_url, role, is_active, last_login_at, created_at
       FROM users WHERE id = $1`,
      [id],
    );
    return result.rowCount && result.rowCount > 0 ? result.rows[0] : null;
  }

  async batchInsertRecords(
    records: {
      id: string;
      name: string;
      gender: "male" | "female";
      gender_probability: number;
      // sample_size: number;
      age: number;
      age_group: "adult" | "child" | "teenager" | "senior";
      country_id: string;
      country_name: string;
      country_probability: number;
    }[],
  ): Promise<{
    inserted: number;
    duplicates: number;
  }> {
    if (records.length === 0) return { inserted: 0, duplicates: 0 };

    const values: any[] = [];
    const placeholders = records.map((record, i) => {
      const base = i * 9;
      values.push(
        record.id,
        record.name,
        record.gender,
        record.gender_probability,
        record.age,
        record.age_group,
        record.country_id,
        record.country_name,
        record.country_probability,
      );
      return `($${base+1}, $${base+2}, $${base+3}, $${base+4}, $${base+5},$${base+6},$${base+7},$${base+8},$${base+9})`
    });

    const query = `
      INSERT INTO classifications
        (id, name, gender, gender_probability, age, age_group, country_id, country_name, country_probability)
      VALUES ${placeholders.join(",")}
      ON CONFLICT (name) DO NOTHING
    `;

    const result = await this.primaryPool.query(query, values);
    const inserted = result.rowCount ?? 0;
    const duplicates = records.length - inserted;

    return { inserted, duplicates }
  }
}

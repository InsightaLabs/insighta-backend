import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DatabaseClient } from "../../src/db";
import { config } from "dotenv";
import crypto from "crypto";
import * as uuid from "uuid";

config();

// These tests run against the real local database.
// They create and clean up their own users/sessions.

let db: DatabaseClient;

const testGithubId = `test_gh_${Date.now()}`;
const testUserId = uuid.v7();

beforeAll(() => {
  db = new DatabaseClient();
});

afterAll(async () => {
  // Clean up test user (cascades to sessions)
  await (db as any).primaryPool.query(
    `DELETE FROM users WHERE github_id = $1`,
    [testGithubId],
  );
});

// ─── upsertUser ────────────────────────────────────────────────────────────

describe("upsertUser", () => {
  it("creates a new user and returns it", async () => {
    const user = await db.upsertUser({
      id: testUserId,
      github_id: testGithubId,
      username: "testuser",
      email: "test@example.com",
    });

    expect(user.id).toBe(testUserId);
    expect(user.github_id).toBe(testGithubId);
    expect(user.username).toBe("testuser");
    expect(user.email).toBe("test@example.com");
    expect(user.role).toBe("analyst"); // default role
    expect(user.created_at).toBeInstanceOf(Date);
  });

  it("updates username and email on conflict (same github_id)", async () => {
    const updated = await db.upsertUser({
      id: uuid.v7(), // different id — should be ignored on conflict
      github_id: testGithubId,
      username: "updateduser",
      email: "updated@example.com",
    });

    expect(updated.github_id).toBe(testGithubId);
    expect(updated.username).toBe("updateduser");
    expect(updated.email).toBe("updated@example.com");
    expect(updated.id).toBe(testUserId); // original id preserved
  });

  it("handles null email", async () => {
    const githubId = `test_gh_null_email_${Date.now()}`;
    const user = await db.upsertUser({
      id: uuid.v7(),
      github_id: githubId,
      username: "noemail",
      email: null,
    });

    expect(user.email).toBeNull();

    // cleanup
    await (db as any).primaryPool.query(
      `DELETE FROM users WHERE github_id = $1`,
      [githubId],
    );
  });

  it("preserves the role field (does not reset to default on update)", async () => {
    // Manually set role to admin
    await (db as any).primaryPool.query(
      `UPDATE users SET role = 'admin' WHERE github_id = $1`,
      [testGithubId],
    );

    const updated = await db.upsertUser({
      id: uuid.v7(),
      github_id: testGithubId,
      username: "testuser",
      email: "test@example.com",
    });

    expect(updated.role).toBe("admin"); // role not overwritten by upsert

    // reset back to analyst
    await (db as any).primaryPool.query(
      `UPDATE users SET role = 'analyst' WHERE github_id = $1`,
      [testGithubId],
    );
  });
});

// ─── getUserById ───────────────────────────────────────────────────────────

describe("getUserById", () => {
  it("returns the user by id", async () => {
    const user = await db.getUserById(testUserId);
    expect(user).not.toBeNull();
    expect(user!.id).toBe(testUserId);
    expect(user!.github_id).toBe(testGithubId);
  });

  it("returns null for a non-existent id", async () => {
    const user = await db.getUserById(uuid.v7());
    expect(user).toBeNull();
  });
});

// ─── createSession ─────────────────────────────────────────────────────────

describe("createSession", () => {
  it("creates a session and returns it", async () => {
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto
      .createHash("sha256")
      .update(rawToken)
      .digest("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const sessionId = uuid.v7();

    const session = await db.createSession({
      id: sessionId,
      user_id: testUserId,
      token_hash: tokenHash,
      expires_at: expiresAt,
    });

    expect(session.id).toBe(sessionId);
    expect(session.user_id).toBe(testUserId);
    expect(session.token_hash).toBe(tokenHash);
    expect(session.revoked).toBe(false);
    expect(session.created_at).toBeInstanceOf(Date);
  });

  it("throws on duplicate token_hash", async () => {
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto
      .createHash("sha256")
      .update(rawToken)
      .digest("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await db.createSession({
      id: uuid.v7(),
      user_id: testUserId,
      token_hash: tokenHash,
      expires_at: expiresAt,
    });

    await expect(
      db.createSession({
        id: uuid.v7(),
        user_id: testUserId,
        token_hash: tokenHash,
        expires_at: expiresAt,
      }),
    ).rejects.toThrow();
  });
});

// ─── getSessionByTokenHash ─────────────────────────────────────────────────

describe("getSessionByTokenHash", () => {
  it("returns the session by token hash", async () => {
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto
      .createHash("sha256")
      .update(rawToken)
      .digest("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await db.createSession({
      id: uuid.v7(),
      user_id: testUserId,
      token_hash: tokenHash,
      expires_at: expiresAt,
    });

    const session = await db.getSessionByTokenHash(tokenHash);
    expect(session).not.toBeNull();
    expect(session!.token_hash).toBe(tokenHash);
    expect(session!.user_id).toBe(testUserId);
    expect(session!.revoked).toBe(false);
  });

  it("returns null for a non-existent token hash", async () => {
    const fakeHash = crypto.randomBytes(32).toString("hex");
    const session = await db.getSessionByTokenHash(fakeHash);
    expect(session).toBeNull();
  });
});

// ─── revokeSession ─────────────────────────────────────────────────────────

describe("revokeSession", () => {
  it("marks the session as revoked", async () => {
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto
      .createHash("sha256")
      .update(rawToken)
      .digest("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await db.createSession({
      id: uuid.v7(),
      user_id: testUserId,
      token_hash: tokenHash,
      expires_at: expiresAt,
    });

    await db.revokeSession(tokenHash);

    const session = await db.getSessionByTokenHash(tokenHash);
    expect(session!.revoked).toBe(true);
  });

  it("is idempotent — revoking an already-revoked session does not throw", async () => {
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto
      .createHash("sha256")
      .update(rawToken)
      .digest("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await db.createSession({
      id: uuid.v7(),
      user_id: testUserId,
      token_hash: tokenHash,
      expires_at: expiresAt,
    });

    await db.revokeSession(tokenHash);
    await expect(db.revokeSession(tokenHash)).resolves.not.toThrow();

    const session = await db.getSessionByTokenHash(tokenHash);
    expect(session!.revoked).toBe(true);
  });

  it("does not affect other sessions for the same user", async () => {
    const rawToken1 = crypto.randomBytes(32).toString("hex");
    const hash1 = crypto.createHash("sha256").update(rawToken1).digest("hex");
    const rawToken2 = crypto.randomBytes(32).toString("hex");
    const hash2 = crypto.createHash("sha256").update(rawToken2).digest("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await db.createSession({
      id: uuid.v7(),
      user_id: testUserId,
      token_hash: hash1,
      expires_at: expiresAt,
    });
    await db.createSession({
      id: uuid.v7(),
      user_id: testUserId,
      token_hash: hash2,
      expires_at: expiresAt,
    });

    await db.revokeSession(hash1);

    const session2 = await db.getSessionByTokenHash(hash2);
    expect(session2!.revoked).toBe(false);
  });
});

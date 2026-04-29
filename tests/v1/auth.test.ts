import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import * as uuid from "uuid";
import { config } from "dotenv";

config();

import { Router } from "express";
import {
  githubCallback,
  refresh,
  logout,
  me,
  githubRedirect,
  pkceStore,
} from "../../src/controllers/auth.controller";
import { authenticate, checkActive } from "../../src/middleware/authenticate";
import { DatabaseClient } from "../../src/db";

const JWT_SECRET = process.env.JWT_SECRET!;

const authRouter = Router();
authRouter.get("/github", githubRedirect);
authRouter.get("/github/callback", githubCallback);
authRouter.post("/refresh", refresh);
authRouter.post("/logout", logout);
authRouter.get("/me", authenticate, checkActive, me);

const app = express();
app.use(express.json());
app.use("/api/v1/auth", authRouter);

// ─── Helpers ───────────────────────────────────────────────────────────────

const db = new DatabaseClient();

function signToken(payload: object, expiresIn: string | number = "15m") {
  return jwt.sign(payload, JWT_SECRET, { expiresIn } as any);
}

async function createTestUser(role: "analyst" | "admin" = "analyst") {
  const githubId = `test_gh_${Date.now()}_${Math.random()}`;
  const user = await db.upsertUser({
    id: uuid.v7(),
    github_id: githubId,
    username: "testuser",
    email: "test@example.com",
    avatar_url: "https://avatars.githubusercontent.com/u/0",
    last_login_at: new Date(),
  });
  if (role === "admin") {
    await (db as any).pool.query(
      `UPDATE users SET role = 'admin' WHERE id = $1`,
      [user.id],
    );
    return { ...user, role: "admin" as const };
  }
  return user;
}

async function createTestSession(userId: string) {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await db.createSession({
    id: uuid.v7(),
    user_id: userId,
    token_hash: tokenHash,
    expires_at: expiresAt,
  });
  return rawToken;
}

const createdUserIds: string[] = [];

afterAll(async () => {
  for (const id of createdUserIds) {
    await (db as any).pool.query(`DELETE FROM users WHERE id = $1`, [id]);
  }
});

// ─── GET /api/v1/auth/github ───────────────────────────────────────────────

describe("GET /api/v1/auth/github", () => {
  it("redirects to GitHub OAuth URL", async () => {
    const res = await request(app).get("/api/v1/auth/github");
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("github.com/login/oauth/authorize");
  });

  it("includes client_id, state, code_challenge in redirect URL", async () => {
    const res = await request(app).get("/api/v1/auth/github");
    const location = res.headers.location as string;
    expect(location).toContain("client_id=");
    expect(location).toContain("state=");
    expect(location).toContain("code_challenge=");
    expect(location).toContain("code_challenge_method=S256");
  });

  it("stores state in pkceStore", async () => {
    const sizeBefore = pkceStore.size;
    await request(app).get("/api/v1/auth/github");
    expect(pkceStore.size).toBe(sizeBefore + 1);
  });
});

// ─── GET /api/v1/auth/github/callback ─────────────────────────────────────

describe("GET /api/v1/auth/github/callback", () => {
  it("returns 400 when state is missing", async () => {
    const res = await request(app)
      .get("/api/v1/auth/github/callback")
      .query({ code: "somecode" });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("state");
  });

  it("returns 400 when state is invalid (not in pkceStore)", async () => {
    const res = await request(app)
      .get("/api/v1/auth/github/callback")
      .query({ code: "somecode", state: "invalidstate" });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("Invalid or expired state");
  });

  it("returns 400 when state is expired", async () => {
    const expiredState = "expiredstate123";
    pkceStore.set(expiredState, {
      codeVerifier: "verifier",
      expiresAt: Date.now() - 1000,
    });

    const res = await request(app)
      .get("/api/v1/auth/github/callback")
      .query({ code: "somecode", state: expiredState });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("expired");
  });

  it("returns 400 when code is missing but state is valid", async () => {
    const state = "validstate123";
    pkceStore.set(state, {
      codeVerifier: "verifier",
      expiresAt: Date.now() + 60_000,
    });

    const res = await request(app)
      .get("/api/v1/auth/github/callback")
      .query({ state });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("authorization code");
  });

  it("consumes state from pkceStore (one-time use)", async () => {
    const state = "onetimestate";
    pkceStore.set(state, {
      codeVerifier: "verifier",
      expiresAt: Date.now() + 60_000,
    });

    await request(app)
      .get("/api/v1/auth/github/callback")
      .query({ code: "fakecode", state });

    expect(pkceStore.has(state)).toBe(false);
  });
});

// ─── POST /api/v1/auth/refresh ─────────────────────────────────────────────

describe("POST /api/v1/auth/refresh", () => {
  it("returns 400 when refresh_token is missing", async () => {
    const res = await request(app).post("/api/v1/auth/refresh").send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("refresh_token");
  });

  it("returns 401 for an invalid (non-existent) refresh token", async () => {
    const res = await request(app)
      .post("/api/v1/auth/refresh")
      .send({ refresh_token: crypto.randomBytes(32).toString("hex") });
    expect(res.status).toBe(401);
    expect(res.body.message).toContain("Invalid refresh token");
  });

  it("returns new access_token and refresh_token for a valid token", async () => {
    const user = await createTestUser();
    createdUserIds.push(user.id);
    const rawToken = await createTestSession(user.id);

    const res = await request(app)
      .post("/api/v1/auth/refresh")
      .send({ refresh_token: rawToken });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("success");
    expect(res.body.access_token).toBeDefined();
    expect(res.body.refresh_token).toBeDefined();
    expect(res.body.refresh_token).not.toBe(rawToken);
    expect(res.body.token_type).toBe("Bearer");
    expect(res.body.expires_in).toBe(180); // JWT_EXPIRY=3m = 180s
  });

  it("old refresh token is revoked after rotation", async () => {
    const user = await createTestUser();
    createdUserIds.push(user.id);
    const rawToken = await createTestSession(user.id);

    await request(app)
      .post("/api/v1/auth/refresh")
      .send({ refresh_token: rawToken });

    const res = await request(app)
      .post("/api/v1/auth/refresh")
      .send({ refresh_token: rawToken });

    expect(res.status).toBe(401);
    expect(res.body.message).toContain("revoked");
  });

  it("returns 401 for a revoked refresh token", async () => {
    const user = await createTestUser();
    createdUserIds.push(user.id);
    const rawToken = await createTestSession(user.id);
    const tokenHash = crypto
      .createHash("sha256")
      .update(rawToken)
      .digest("hex");
    await db.revokeSession(tokenHash);

    const res = await request(app)
      .post("/api/v1/auth/refresh")
      .send({ refresh_token: rawToken });

    expect(res.status).toBe(401);
    expect(res.body.message).toContain("revoked");
  });

  it("returns 401 for an expired refresh token", async () => {
    const user = await createTestUser();
    createdUserIds.push(user.id);
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto
      .createHash("sha256")
      .update(rawToken)
      .digest("hex");
    const expiredAt = new Date(Date.now() - 1000);

    await db.createSession({
      id: uuid.v7(),
      user_id: user.id,
      token_hash: tokenHash,
      expires_at: expiredAt,
    });

    const res = await request(app)
      .post("/api/v1/auth/refresh")
      .send({ refresh_token: rawToken });

    expect(res.status).toBe(401);
    expect(res.body.message).toContain("expired");
  });

  it("new access token contains correct userId and role", async () => {
    const user = await createTestUser("analyst");
    createdUserIds.push(user.id);
    const rawToken = await createTestSession(user.id);

    const res = await request(app)
      .post("/api/v1/auth/refresh")
      .send({ refresh_token: rawToken });

    const decoded = jwt.verify(res.body.access_token, JWT_SECRET) as any;
    expect(decoded.userId).toBe(user.id);
    expect(decoded.role).toBe("analyst");
  });
});

// ─── POST /api/v1/auth/logout ──────────────────────────────────────────────

describe("POST /api/v1/auth/logout", () => {
  it("returns 400 when refresh_token is missing", async () => {
    const res = await request(app).post("/api/v1/auth/logout").send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("refresh_token");
  });

  it("returns 200 and revokes a valid session", async () => {
    const user = await createTestUser();
    createdUserIds.push(user.id);
    const rawToken = await createTestSession(user.id);

    const res = await request(app)
      .post("/api/v1/auth/logout")
      .send({ refresh_token: rawToken });

    expect(res.status).toBe(200);
    expect(res.body.message).toContain("Logged out");

    const tokenHash = crypto
      .createHash("sha256")
      .update(rawToken)
      .digest("hex");
    const session = await db.getSessionByTokenHash(tokenHash);
    expect(session!.revoked).toBe(true);
  });

  it("is idempotent — returns 200 even if already logged out", async () => {
    const user = await createTestUser();
    createdUserIds.push(user.id);
    const rawToken = await createTestSession(user.id);

    await request(app)
      .post("/api/v1/auth/logout")
      .send({ refresh_token: rawToken });
    const res = await request(app)
      .post("/api/v1/auth/logout")
      .send({ refresh_token: rawToken });

    expect(res.status).toBe(200);
  });

  it("returns 200 for a non-existent token (no info leakage)", async () => {
    const res = await request(app)
      .post("/api/v1/auth/logout")
      .send({ refresh_token: crypto.randomBytes(32).toString("hex") });
    expect(res.status).toBe(200);
  });
});

// ─── GET /api/v1/auth/me ───────────────────────────────────────────────────

describe("GET /api/v1/auth/me", () => {
  it("returns 401 when no Authorization header", async () => {
    const res = await request(app).get("/api/v1/auth/me");
    expect(res.status).toBe(401);
  });

  it("returns 401 for an expired token", async () => {
    const token = jwt.sign({ userId: "u1", role: "analyst" }, JWT_SECRET, {
      expiresIn: -1,
    } as any);
    const res = await request(app)
      .get("/api/v1/auth/me")
      .set("x-client-type", "cli")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.message).toContain("expired");
  });

  it("returns 401 for an invalid token", async () => {
    const res = await request(app)
      .get("/api/v1/auth/me")
      .set("x-client-type", "cli")
      .set("Authorization", "Bearer notavalidtoken");
    expect(res.status).toBe(401);
  });

  // it("returns 401 when user in token does not exist in DB", async () => {
  //   const token = signToken({ userId: uuid.v7(), role: "analyst" });
  //   const res = await request(app)
  //     .get("/api/v1/auth/me")
  //     .set("x-client-type", "cli")
  //     .set("Authorization", `Bearer ${token}`);
  //   expect(res.status).toBe(401);
  // });

  it("returns user profile for a valid token", async () => {
    const user = await createTestUser();
    createdUserIds.push(user.id);
    const token = signToken({ userId: user.id, role: user.role });

    const res = await request(app)
      .get("/api/v1/auth/me")
      .set("x-client-type", "cli")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("success");
    expect(res.body.user.id).toBe(user.id);
    expect(res.body.user.username).toBe("testuser");
    expect(res.body.user.role).toBe("analyst");
    expect(res.body.user).not.toHaveProperty("github_id");
  });

  it("returns admin user profile correctly", async () => {
    const user = await createTestUser("admin");
    createdUserIds.push(user.id);
    const token = signToken({ userId: user.id, role: "admin" });

    const res = await request(app)
      .get("/api/v1/auth/me")
      .set("x-client-type", "cli")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe("admin");
  });
});

// ─── GET /api/v1/auth/github/callback — success path (mocked GitHub) ──────

describe("GET /api/v1/auth/github/callback — success path", () => {
  it("CLI path: returns access_token and refresh_token as JSON", async () => {
    const state = `success_state_${Date.now()}`;
    pkceStore.set(state, {
      codeVerifier: "test-verifier",
      expiresAt: Date.now() + 60_000,
    });

    const githubUserId = Math.floor(Math.random() * 1_000_000);

    const originalFetch = global.fetch;
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        json: async () => ({ access_token: "gh_mock_token" }),
      } as any)
      .mockResolvedValueOnce({
        json: async () => ({
          id: githubUserId,
          login: "mockuser",
          email: "mock@example.com",
        }),
      } as any);

    const res = await request(app)
      .get("/api/v1/auth/github/callback")
      .set("x-client-type", "cli")
      .query({ code: "mock_code", state });

    global.fetch = originalFetch;

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("success");
    expect(res.body.access_token).toBeDefined();
    expect(res.body.refresh_token).toBeDefined();
    expect(res.body.token_type).toBe("Bearer");
    expect(res.body.expires_in).toBe(180); // JWT_EXPIRY=3m = 180s

    const db2 = new DatabaseClient();
    await (db2 as any).pool.query(`DELETE FROM users WHERE github_id = $1`, [
      String(githubUserId),
    ]);
  });

  it("CLI path: access token contains correct userId and role", async () => {
    const state = `success_state_role_${Date.now()}`;
    pkceStore.set(state, {
      codeVerifier: "test-verifier",
      expiresAt: Date.now() + 60_000,
    });

    const githubUserId = Math.floor(Math.random() * 1_000_000) + 2_000_000;

    const originalFetch = global.fetch;
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        json: async () => ({ access_token: "gh_mock_token" }),
      } as any)
      .mockResolvedValueOnce({
        json: async () => ({
          id: githubUserId,
          login: "roleuser",
          email: null,
        }),
      } as any);

    const res = await request(app)
      .get("/api/v1/auth/github/callback")
      .set("x-client-type", "cli")
      .query({ code: "mock_code", state });

    global.fetch = originalFetch;

    const decoded = jwt.verify(res.body.access_token, JWT_SECRET) as any;
    expect(decoded.userId).toBeDefined();
    expect(decoded.role).toBe("analyst");

    const db2 = new DatabaseClient();
    await (db2 as any).pool.query(`DELETE FROM users WHERE github_id = $1`, [
      String(githubUserId),
    ]);
  });

  it("returns 502 when GitHub token exchange fails", async () => {
    const state = `fail_state_${Date.now()}`;
    pkceStore.set(state, {
      codeVerifier: "test-verifier",
      expiresAt: Date.now() + 60_000,
    });

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValueOnce({
      json: async () => ({ error: "bad_verification_code" }),
    } as any);

    const res = await request(app)
      .get("/api/v1/auth/github/callback")
      .query({ code: "bad_code", state });

    global.fetch = originalFetch;

    expect(res.status).toBe(502);
    expect(res.body.message).toContain("GitHub access token");
  });

  it("returns 502 when GitHub user fetch fails (no id)", async () => {
    const state = `fail_user_state_${Date.now()}`;
    pkceStore.set(state, {
      codeVerifier: "test-verifier",
      expiresAt: Date.now() + 60_000,
    });

    const originalFetch = global.fetch;
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        json: async () => ({ access_token: "gh_mock_token" }),
      } as any)
      .mockResolvedValueOnce({
        json: async () => ({ login: "nouser" }),
      } as any);

    const res = await request(app)
      .get("/api/v1/auth/github/callback")
      .query({ code: "mock_code", state });

    global.fetch = originalFetch;

    expect(res.status).toBe(502);
    expect(res.body.message).toContain("GitHub user");
  });

  it("browser path: redirects to portal callback with tokens in query params", async () => {
    const state = `browser_state_${Date.now()}`;
    pkceStore.set(state, {
      codeVerifier: "test-verifier",
      expiresAt: Date.now() + 60_000,
    });

    const githubUserId = Math.floor(Math.random() * 1_000_000) + 4_000_000;

    const originalFetch = global.fetch;
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        json: async () => ({ access_token: "gh_mock_token" }),
      } as any)
      .mockResolvedValueOnce({
        json: async () => ({
          id: githubUserId,
          login: "browseruser",
          email: "browser@example.com",
        }),
      } as any);

    const res = await request(app)
      .get("/api/v1/auth/github/callback")
      .query({ code: "mock_code", state });

    global.fetch = originalFetch;

    // Browser path redirects to portal callback with tokens as query params
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("/api/auth/callback");
    expect(res.headers.location).toContain("access_token=");
    expect(res.headers.location).toContain("refresh_token=");
    expect(res.headers.location).toContain("csrf_token=");

    const db2 = new DatabaseClient();
    await (db2 as any).pool.query(`DELETE FROM users WHERE github_id = $1`, [
      String(githubUserId),
    ]);
  });
});

// ─── GET /api/v1/auth/me — malformed token payload ────────────────────────

describe("GET /api/v1/auth/me — malformed payload", () => {
  it("returns 401 when token has no userId field", async () => {
    // Valid JWT but missing userId — checkActive gets undefined userId → user not found → 401
    const token = jwt.sign({ role: "analyst" }, JWT_SECRET, {
      expiresIn: "15m",
    });
    const res = await request(app)
      .get("/api/v1/auth/me")
      .set("x-client-type", "cli")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it("returns 401 for a completely empty payload token", async () => {
    const token = jwt.sign({}, "wrong-secret");
    const res = await request(app)
      .get("/api/v1/auth/me")
      .set("x-client-type", "cli")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
  });
});

// ─── POST /api/v1/auth/refresh — deleted user mid-session ─────────────────

describe("POST /api/v1/auth/refresh — user deleted mid-session", () => {
  it("returns 401 when the user no longer exists but session is valid", async () => {
    const githubId = `ghost_user_${Date.now()}`;
    const user = await db.upsertUser({
      id: uuid.v7(),
      github_id: githubId,
      username: "ghostuser",
      email: null,
      avatar_url: "https://avatars.githubusercontent.com/u/0",
      last_login_at: new Date(),
    });

    const rawToken2 = await createTestSession(user.id);
    await (db as any).pool.query(`DELETE FROM users WHERE id = $1`, [user.id]);

    const res = await request(app)
      .post("/api/v1/auth/refresh")
      .send({ refresh_token: rawToken2 });

    expect(res.status).toBe(401);
  });
});

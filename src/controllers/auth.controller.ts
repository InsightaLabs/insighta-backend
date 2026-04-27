import { type Request, type Response } from "express";
import { URLSearchParams } from "url";
import { config } from "dotenv";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import * as uuid from "uuid";
import { DatabaseClient } from "../db";

config();

const githubClientId = process.env.GITHUB_CLIENT_ID;
const githubSecret = process.env.GITHUB_SECRET;
const githubCallbackUrl = process.env.GITHUB_CALLBACK_URL;
const jwtSecret = process.env.JWT_SECRET;

if (!githubClientId || !githubCallbackUrl || !githubSecret || !jwtSecret) {
  throw new Error(
    "Missing required environment variables: GITHUB_CLIENT_ID, GITHUB_SECRET, GITHUB_CALLBACK_URL, JWT_SECRET",
  );
}

const dbClient = new DatabaseClient();

// Temporary in-memory store for PKCE verifiers and state
// key: state string, value: { codeVerifier, expiresAt }
const pkceStore = new Map<
  string,
  { codeVerifier: string; expiresAt: number }
>();

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

export async function toGithubRedirect(req: Request, res: Response) {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = crypto.randomBytes(16).toString("hex");

  // Store verifier keyed by state — expires in 10 minutes
  pkceStore.set(state, {
    codeVerifier,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });

  const params = new URLSearchParams({
    client_id: githubClientId as string,
    redirect_uri: githubCallbackUrl as string,
    scope: "read:user user:email",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    response_type: "code",
  });

  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
}

export async function githubCallback(req: Request, res: Response) {
  const { code, state } = req.query;

  // 1. Validate state and retrieve PKCE verifier
  if (!state || typeof state !== "string") {
    return res
      .status(400)
      .json({ status: "error", message: "Missing state parameter" });
  }

  const pkceEntry = pkceStore.get(state);
  if (!pkceEntry) {
    return res
      .status(400)
      .json({ status: "error", message: "Invalid or expired state" });
  }
  if (Date.now() > pkceEntry.expiresAt) {
    pkceStore.delete(state);
    return res
      .status(400)
      .json({ status: "error", message: "State expired, please try again" });
  }

  pkceStore.delete(state); // one-time use

  if (!code || typeof code !== "string") {
    return res
      .status(400)
      .json({ status: "error", message: "Missing authorization code" });
  }

  try {
    // 2. Exchange code + verifier for GitHub access token
    const tokenRes = await fetch(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: githubClientId,
          client_secret: githubSecret,
          code,
          redirect_uri: githubCallbackUrl,
          code_verifier: pkceEntry.codeVerifier,
        }),
      },
    );

    const tokenData = (await tokenRes.json()) as {
      access_token?: string;
      error?: string;
    };

    if (!tokenData.access_token) {
      return res
        .status(502)
        .json({
          status: "error",
          message: "Failed to obtain GitHub access token",
        });
    }

    // 3. Fetch GitHub user info
    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: "application/vnd.github+json",
      },
    });

    const githubUser = (await userRes.json()) as {
      id: number;
      login: string;
      email?: string;
    };

    if (!githubUser.id) {
      return res
        .status(502)
        .json({ status: "error", message: "Failed to fetch GitHub user" });
    }

    // 4. Upsert user in DB
    const user = await dbClient.upsertUser({
      id: uuid.v7(),
      github_id: String(githubUser.id),
      username: githubUser.login,
      email: githubUser.email ?? null,
    });

    // 5. Issue access token (JWT, 15 min)
    const accessToken = jwt.sign(
      { userId: user.id, role: user.role },
      jwtSecret as string,
      { expiresIn: "15m" },
    );

    // 6. Issue refresh token (opaque, stored hashed in sessions table)
    const rawRefreshToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto
      .createHash("sha256")
      .update(rawRefreshToken)
      .digest("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await dbClient.createSession({
      id: uuid.v7(),
      user_id: user.id,
      token_hash: tokenHash,
      expires_at: expiresAt,
    });

    return res.status(200).json({
      status: "success",
      access_token: accessToken,
      refresh_token: rawRefreshToken,
      token_type: "Bearer",
      expires_in: 900, // 15 minutes in seconds
    });
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ status: "error", message: "Internal server error" });
  }
}

export async function refresh(req: Request, res: Response) {
  const { refresh_token } = req.body;

  if (!refresh_token || typeof refresh_token !== "string") {
    return res
      .status(400)
      .json({ status: "error", message: "Missing refresh_token" });
  }

  try {
    // 1. Hash the refresh token to look it up
    const tokenHash = crypto
      .createHash("sha256")
      .update(refresh_token)
      .digest("hex");

    // 2. Look up the session
    const session = await dbClient.getSessionByTokenHash(tokenHash);

    if (!session) {
      return res
        .status(401)
        .json({ status: "error", message: "Invalid refresh token" });
    }

    // 3. Check if session is revoked
    if (session.revoked) {
      return res
        .status(401)
        .json({ status: "error", message: "Refresh token has been revoked" });
    }

    // 4. Check if session is expired
    if (new Date() > new Date(session.expires_at)) {
      return res
        .status(401)
        .json({ status: "error", message: "Refresh token expired" });
    }

    // 5. Get user details
    const user = await dbClient.getUserById(session.user_id);

    if (!user) {
      return res
        .status(401)
        .json({ status: "error", message: "User not found" });
    }

    // 6. Revoke the old refresh token
    await dbClient.revokeSession(tokenHash);

    // 7. Issue new access token (JWT, 15 min)
    const accessToken = jwt.sign(
      { userId: user.id, role: user.role },
      jwtSecret as string,
      { expiresIn: "15m" },
    );

    // 8. Issue new refresh token (opaque, stored hashed in sessions table)
    const newRawRefreshToken = crypto.randomBytes(32).toString("hex");
    const newTokenHash = crypto
      .createHash("sha256")
      .update(newRawRefreshToken)
      .digest("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await dbClient.createSession({
      id: uuid.v7(),
      user_id: user.id,
      token_hash: newTokenHash,
      expires_at: expiresAt,
    });

    return res.status(200).json({
      status: "success",
      access_token: accessToken,
      refresh_token: newRawRefreshToken,
      token_type: "Bearer",
      expires_in: 900, // 15 minutes in seconds
    });
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ status: "error", message: "Internal server error" });
  }
}

export async function logout(req: Request, res: Response) {
  const { refresh_token } = req.body;

  if (!refresh_token || typeof refresh_token !== "string") {
    return res
      .status(400)
      .json({ status: "error", message: "Missing refresh_token" });
  }

  try {
    const tokenHash = crypto
      .createHash("sha256")
      .update(refresh_token)
      .digest("hex");
    const session = await dbClient.getSessionByTokenHash(tokenHash);

    if (!session || session.revoked) {
      // Idempotent — already logged out or never existed
      return res.status(200).json({ status: "success", message: "Logged out" });
    }

    await dbClient.revokeSession(tokenHash);

    return res.status(200).json({ status: "success", message: "Logged out" });
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ status: "error", message: "Internal server error" });
  }
}

export async function me(req: Request, res: Response) {
  // req.user is populated by the authenticate middleware
  const authUser = req.user;

  if (!authUser) {
    return res.status(401).json({ status: "error", message: "Unauthorized" });
  }

  try {
    const user = await dbClient.getUserById(authUser.userId);

    if (!user) {
      return res
        .status(404)
        .json({ status: "error", message: "User not found" });
    }

    return res.status(200).json({
      status: "success",
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        created_at: user.created_at,
      },
    });
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ status: "error", message: "Internal server error" });
  }
}

export { pkceStore };

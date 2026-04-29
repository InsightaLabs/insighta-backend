import { type Request, type Response, type NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "dotenv";
import { DatabaseClient } from "../db";

config();

const jwtSecret = process.env.JWT_SECRET;

if (!jwtSecret) {
  throw new Error("Missing required environment variable: JWT_SECRET");
}

let dbClient: DatabaseClient | null = null;

function getDbClient(): DatabaseClient {
  if (!dbClient) {
    dbClient = new DatabaseClient();
  }
  return dbClient;
}

export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const isCLI = req.headers["x-client-type"] === "cli";

  let token: string;
  if (isCLI) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        status: "error",
        message: "Missing or invalid Authorization header",
      });
    }
    token = authHeader.slice(7);
  } else {
    token = req.cookies?.access_token;
    if (!token) {
      return res.status(401).json({
        status: "error",
        message: "Missing access token",
      });
    }
  }

  try {
    const payload = jwt.verify(token, jwtSecret as string) as {
      userId: string;
      role: string;
    };
    req.user = { userId: payload.userId, role: payload.role };
    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return res
        .status(401)
        .json({ status: "error", message: "Access token expired" });
    }
    return res
      .status(401)
      .json({ status: "error", message: "Invalid access token" });
  }
}

/**
 * Checks that the authenticated user exists in the DB and is active.
 * Apply this after `authenticate` in production routes.
 * Kept separate so unit tests can use `authenticate` without a real DB.
 */
export async function checkActive(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (!req.user) {
    return res.status(401).json({ status: "error", message: "Unauthorized" });
  }
  const user = await getDbClient().getUserById(req.user.userId);
  if (!user) {
    return res.status(401).json({ status: "error", message: "Invalid access token" });
  }
  if (!user.is_active) {
    return res.status(403).json({ status: "error", message: "Deactivated User" });
  }
  next();
}

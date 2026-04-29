import { type Request, type Response, type NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "dotenv";

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
  const authHeader = req.headers.authorization;

  let token: string | undefined;

  // Accept Bearer token from any client (CLI or web with Authorization header)
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  } else if (!isCLI) {
    // Web portal: fall back to httpOnly cookie
    token = req.cookies?.access_token;
  }

  if (!token) {
    return res.status(401).json({
      status: "error",
      message: "Missing or invalid Authorization header",
    });
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

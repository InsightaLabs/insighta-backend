import { type Request, type Response, type NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "dotenv";

config();

const jwtSecret = process.env.JWT_SECRET;

if (!jwtSecret) {
  throw new Error("Missing required environment variable: JWT_SECRET");
}

export function authenticate(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res
      .status(401)
      .json({
        status: "error",
        message: "Missing or invalid Authorization header",
      });
  }

  const token = authHeader.slice(7);

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

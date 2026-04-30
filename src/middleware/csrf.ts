import { type Request, type Response, type NextFunction } from "express";

export const csrfProtection = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  // Skip CSRF for safe (read-only) methods
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();

  // Skip CSRF if request is using Bearer token (CLI)
  if (req.headers.authorization?.startsWith("Bearer ")) return next();

  const token = req.headers["x-csrf-token"];
  const storedToken = req.cookies["csrf_token"];

  if (!token || token !== storedToken) {
    return res
      .status(403)
      .json({ status: "error", message: "Invalid CSRF token" });
  }
  next();
};

import { type Request, type Response, type NextFunction } from "express";

/**
 * Request logger middleware.
 * Logs: method, endpoint, status code, and response time on every request.
 *
 * Example output:
 *   GET /api/profiles 200 45ms
 *   POST /auth/refresh 401 12ms
 */
export function requestLogger(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const start = Date.now();

  res.on("finish", () => {
    const duration = Date.now() - start;
    console.log(
      `${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`,
    );
  });

  next();
}

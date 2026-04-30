import rateLimit from "express-rate-limit";

export const authLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  limit: 10,
});

export const appLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  limit: 60,
});

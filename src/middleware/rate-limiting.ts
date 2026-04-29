import rateLimit from 'express-rate-limit';

export const authLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, limit: process.env.NODE_ENV === 'development' ? 1000 : 10
});

export const appLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, limit: process.env.NODE_ENV === 'development' ? 1000 : 60
})
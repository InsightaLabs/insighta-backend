import { type Request, type Response, type NextFunction } from "express";

export const csrfProtection = (req: Request, res: Response, next: NextFunction) => {
    // skip CSRF if request is using Bearer token (CLI)
    if (req.headers.authorization?.startsWith('Bearer ')) return next();
  const token = req.headers['x-csrf-token'];
  const storedToken = req.cookies['csrf_token']; // you set this on login

  if (!token || token !== storedToken) {
    return res.status(403).json({ status: 'error', message: 'Invalid CSRF token' });
  }
  next();
};
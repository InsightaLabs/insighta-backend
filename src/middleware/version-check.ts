import type { Request, Response, NextFunction } from "express";

export const versionCheck = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const header = req.headers["x-api-version"];

  if (!header || typeof header !== "string") {
    return res.status(400).json({
      status: "error",
      message: "API version header required",
    });
  }

  let headerNumber = parseInt(header);

  if (Number.isNaN(headerNumber) || headerNumber !== 1) {
    return res.status(400).json({
      status: "error",
      message: "Invalid API version header",
    });
  }

  next();
};

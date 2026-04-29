import { NextFunction, Request, Response } from "express";
import { UserRole } from "../types";

const ROLE_HIERARCHY: UserRole[] = ["analyst", "admin"];

export function authorize(requiredRole: UserRole) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ status: "error", message: "Unauthorized" });
    }

    const userRoleIndex = ROLE_HIERARCHY.indexOf(req.user.role as UserRole);
    const requiredRoleIndex = ROLE_HIERARCHY.indexOf(requiredRole);

    if (userRoleIndex >= requiredRoleIndex) {
      return next();
    }

    return res.status(403).json({
      status: "error",
      message: "Forbidden: insufficient permissions",
    });
  };
}

import type { NextFunction, Request, Response } from "express";
import { forbidden, unauthorized } from "../errors/api-error.js";

export const requireRole = (...roleKeys: string[]) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) return next(unauthorized());
    if (!roleKeys.includes(req.auth.roleKey)) return next(forbidden("ROLE_REQUIRED", "This operation requires a different platform role."));
    next();
  };

export const requirePermission = (...permissionKeys: string[]) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) return next(unauthorized());
    const missing = permissionKeys.find((permission) => !req.auth!.permissions.has(permission));
    if (missing) return next(forbidden("PERMISSION_REQUIRED", "Your platform role does not grant this operation."));
    next();
  };

export const requireSuperAdmin = requireRole("super_admin");

import type { NextFunction, Request, Response } from "express";
import { getConfig } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { unauthorized } from "../errors/api-error.js";
import { verifyAccessToken } from "./tokens.js";

export const requireAuth = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
  try {
    const authorization = req.get("authorization");
    if (!authorization?.startsWith("Bearer ") || authorization.includes(",")) throw unauthorized();
    const token = authorization.slice("Bearer ".length).trim();
    if (!token) throw unauthorized();

    const config = getConfig();
    const claims = verifyAccessToken(token, config.auth);
    const session = await prisma.userSession.findUnique({
      where: { authSessionId: claims.authSessionId },
      select: {
        id: true,
        userId: true,
        authSessionId: true,
        expiresAt: true,
        revokedAt: true,
        deviceIdHash: true,
        deviceBindingVersion: true,
        lastSeenAt: true,
        user: {
          select: {
            email: true,
            fullName: true,
            status: true,
            deletedAt: true,
            role: {
              select: {
                key: true,
                isActive: true,
                rolePermissions: { select: { permission: { select: { key: true } } } },
              },
            },
            deviceBinding: { select: { bindingVersion: true, deviceIdHash: true } },
          },
        },
      },
    });

    const now = new Date();
    if (
      !session ||
      session.userId !== claims.userId ||
      session.revokedAt ||
      session.expiresAt <= now ||
      session.user.deletedAt ||
      session.user.status !== "ACTIVE" ||
      !session.user.role.isActive
      || (session.deviceBindingVersion !== null && session.deviceBindingVersion !== session.user.deviceBinding?.bindingVersion)
      || (session.deviceIdHash !== null && session.deviceIdHash !== session.user.deviceBinding?.deviceIdHash)
    ) {
      throw unauthorized("The session is invalid or expired.");
    }

    req.auth = {
      userId: session.userId,
      sessionId: session.id,
      authSessionId: session.authSessionId,
      email: session.user.email,
      fullName: session.user.fullName,
      roleKey: session.user.role.key,
      permissions: new Set(session.user.role.rolePermissions.map(({ permission }) => permission.key)),
    };

    if (now.getTime() - session.lastSeenAt.getTime() > 5 * 60_000) {
      void prisma.userSession.update({ where: { id: session.id }, data: { lastSeenAt: now } }).catch(() => undefined);
    }
    next();
  } catch (error) {
    next(error);
  }
};

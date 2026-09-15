import cors from "cors";
import express from "express";
import helmet from "helmet";
import { requireAuth } from "../auth/auth-middleware.js";
import { requireRole, requireSuperAdmin } from "../auth/authorization.js";
import type { AppConfig } from "../config/env.js";
import { getConfig } from "../config/env.js";
import { forbidden } from "../errors/api-error.js";
import { requireJsonContentType } from "../middleware/content-type.js";
import { errorHandler, notFoundHandler } from "../middleware/error-handler.js";
import { createRateLimiter } from "../middleware/rate-limit.js";
import { requestContext } from "../middleware/request-context.js";
import { requestLogger } from "../middleware/request-logger.js";
import { academyAdminRouter } from "../routes/academyAdminRoutes.js";
import { studentAdmissionsRouter } from "../routes/academyAdmissionsRoutes.js";
import { studentNotificationRouter } from "../routes/academyNotificationRoutes.js";
import { createAuthRouter } from "../routes/authRoutes.js";
import { healthRouter } from "../routes/healthRoutes.js";
import { adminRouter } from "../routes/adminRoutes.js";
import { catalogRouter, contactRouter } from "../routes/publicRoutes.js";
import { checkoutRouter, paymentWebhookRouter } from "../routes/commerceRoutes.js";
import { studentDomainRouter } from "../routes/studentRoutes.js";
import { protectedViewerRouter } from "../routes/protectedViewerRoutes.js";

export const createApp = (config: AppConfig = getConfig()) => {
  const app = express();
  app.disable("x-powered-by");
  app.set("json replacer", (_key: string, value: unknown) => {
    if (typeof value !== "bigint") return value;
    const numeric = Number(value);
    return Number.isSafeInteger(numeric) ? numeric : value.toString();
  });
  app.set("trust proxy", config.server.trustProxy);
  app.use(requestContext);
  app.use(requestLogger);
  app.use(helmet({ crossOriginResourcePolicy: { policy: "same-site" } }));
  app.use(cors({
    credentials: false,
    maxAge: 600,
    origin(origin, callback) {
      if (!origin || config.corsOrigins.has(origin)) callback(null, true);
      else callback(forbidden("CORS_ORIGIN_DENIED", "This request origin is not allowed."));
    },
  }));

  app.use("/health", healthRouter);
  app.use("/api", createRateLimiter({
    windowMs: config.rateLimit.windowMs,
    maxRequests: config.rateLimit.maxRequests,
    namespace: "api",
  }));
  app.use("/api/payments", express.raw({ type: "application/json", limit: "256kb" }), paymentWebhookRouter);
  app.use("/api/protected-viewer", protectedViewerRouter);
  app.use("/api", requireJsonContentType);
  app.use("/api", express.json({ limit: config.server.jsonBodyLimit, type: ["application/json", "application/*+json"] }));

  app.use("/api/auth", createAuthRouter());

  app.use("/api/admin", requireAuth, requireSuperAdmin, adminRouter);

  app.use("/api/academy", requireAuth, academyAdminRouter);

  const studentRouter = express.Router();
  studentRouter.use(requireAuth, requireRole("student"));
  studentRouter.use("/admissions", studentAdmissionsRouter);
  studentRouter.use("/notifications", studentNotificationRouter);
  studentRouter.use(studentDomainRouter);
  app.use("/api/student", studentRouter);

  app.use("/api/catalog", catalogRouter);
  app.use("/api/checkout", requireAuth, checkoutRouter);
  app.use("/api/contact", contactRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
};

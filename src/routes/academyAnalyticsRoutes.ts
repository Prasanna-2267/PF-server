import { Router, type Request } from "express";
import { asyncRoute } from "../middleware/async-route.js";
import * as analyticsService from "../services/academyAnalyticsService.js";

const optionsFrom = (req: Request) => ({
  rangeType: typeof req.query.rangeType === "string" ? req.query.rangeType : undefined,
  startDate: typeof req.query.startDate === "string" ? req.query.startDate : undefined,
  endDate: typeof req.query.endDate === "string" ? req.query.endDate : undefined,
});

export const academyAnalyticsRouter = Router();
academyAnalyticsRouter.get("/overview", asyncRoute(async (req, res) => {
  res.json(await analyticsService.getAnalyticsOverview(req.tenantContext!, optionsFrom(req)));
}));
academyAnalyticsRouter.get("/students", asyncRoute(async (req, res) => {
  res.json(await analyticsService.getStudentAnalytics(req.tenantContext!, optionsFrom(req)));
}));
academyAnalyticsRouter.get("/admissions", asyncRoute(async (req, res) => {
  res.json(await analyticsService.getAdmissionAnalytics(req.tenantContext!, optionsFrom(req)));
}));
academyAnalyticsRouter.get("/courses", asyncRoute(async (req, res) => {
  res.json(await analyticsService.getCourseAnalytics(req.tenantContext!, optionsFrom(req)));
}));
academyAnalyticsRouter.get("/content", asyncRoute(async (req, res) => {
  res.json(await analyticsService.getContentAnalytics(req.tenantContext!, optionsFrom(req)));
}));

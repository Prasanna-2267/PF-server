import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../db/prisma.js";
import { badRequest, conflict, notFound } from "../errors/api-error.js";
import { enqueueJob } from "./backgroundJobService.js";
import { fanoutPlatformBroadcastToUnaffiliatedLearners } from "./learnerNotificationService.js";
import { dispatchQueuedNotification } from "./academyNotificationService.js";

interface Input { title: string; subtitle?: string; message: string; type?: "ANNOUNCEMENT" | "IMPORTANT_NOTICE" | "UPDATE" | "PROMOTION" | "MAINTENANCE" | "FEATURE_UPDATE" | "ACADEMIC" | "STORE" | "GENERAL" | "CRITICAL_ALERT"; priority?: "LOW" | "NORMAL" | "HIGH" | "CRITICAL"; targetAcademyIds?: string[]; startAt?: string; endAt?: string }
export async function listBroadcasts(input: { page: number; limit: number; status?: "DRAFT" | "SCHEDULED" | "ACTIVE" | "EXPIRED" | "ARCHIVED" | "DISABLED" }) {
  const where: Prisma.BroadcastWhereInput = { academyId: null, deletedAt: null, ...(input.status ? { status: input.status } : {}) };
  const [data, total] = await Promise.all([prisma.broadcast.findMany({ where, skip: (input.page - 1) * input.limit, take: input.limit, orderBy: [{ createdAt: "desc" }, { id: "desc" }], include: { academyTargets: { include: { academy: { select: { id: true, name: true } } } } } }), prisma.broadcast.count({ where })]);
  return { data, pagination: { page: input.page, limit: input.limit, total, totalPages: Math.ceil(total / input.limit) } };
}
export async function getBroadcast(id: string) { const item = await prisma.broadcast.findFirst({ where: { id, academyId: null }, include: { placements: true, cta: true, image: true, academyTargets: true, timeline: { orderBy: { timestamp: "desc" }, take: 100 } } }); if (!item) throw notFound("BROADCAST_NOT_FOUND", "The platform broadcast was not found."); return item; }
export async function createBroadcast(actorId: string, input: Input) {
  const targets = [...new Set(input.targetAcademyIds ?? [])];
  if (targets.length && await prisma.academy.count({ where: { id: { in: targets }, status: "ACTIVE", deletedAt: null } }) !== targets.length) throw badRequest("INVALID_ACADEMY_TARGETS", "Every target academy must be active.");
  return prisma.$transaction(async (tx) => {
    const broadcast = await tx.broadcast.create({ data: { title: input.title.trim(), subtitle: input.subtitle?.trim() ?? "", message: input.message.trim(), type: input.type ?? "ANNOUNCEMENT", priority: input.priority ?? "NORMAL", status: "DRAFT", platform: "APP", audienceKind: targets.length ? "ACADEMIES" : "EVERYONE", startAt: input.startAt ? new Date(input.startAt) : null, endAt: input.endAt ? new Date(input.endAt) : null, placements: { create: [{ placement: "NOTIFICATION" }, { placement: "HOME" }] }, academyTargets: targets.length ? { create: targets.map((academyId) => ({ academyId })) } : undefined, timeline: { create: { actorId, action: "CREATED", description: "Created platform broadcast." } } }, include: { academyTargets: true } });
    await tx.systemAuditLog.create({ data: { actorId, action: "PLATFORM_BROADCAST_CREATED", entityType: "Broadcast", entityId: broadcast.id, description: `Created platform broadcast ${broadcast.title}.` } });
    return broadcast;
  });
}
export async function updateBroadcast(actorId: string, id: string, input: Partial<Input>) {
  return prisma.$transaction(async (tx) => {
    const current = await tx.broadcast.findFirst({ where: { id, academyId: null, deletedAt: null, status: { in: ["DRAFT", "SCHEDULED"] } } });
    if (!current) throw conflict("BROADCAST_NOT_EDITABLE", "Only draft or scheduled platform broadcasts can be edited.");
    if (input.targetAcademyIds) { const targets = [...new Set(input.targetAcademyIds)]; if (await tx.academy.count({ where: { id: { in: targets }, status: "ACTIVE", deletedAt: null } }) !== targets.length) throw badRequest("INVALID_ACADEMY_TARGETS", "Every target academy must be active."); await tx.broadcastAcademyTarget.deleteMany({ where: { broadcastId: id } }); if (targets.length) await tx.broadcastAcademyTarget.createMany({ data: targets.map((academyId) => ({ broadcastId: id, academyId })) }); }
    const updated = await tx.broadcast.update({ where: { id }, data: { ...(input.title !== undefined ? { title: input.title.trim() } : {}), ...(input.subtitle !== undefined ? { subtitle: input.subtitle.trim() } : {}), ...(input.message !== undefined ? { message: input.message.trim() } : {}), ...(input.type !== undefined ? { type: input.type } : {}), ...(input.priority !== undefined ? { priority: input.priority } : {}), ...(input.startAt !== undefined ? { startAt: new Date(input.startAt) } : {}), ...(input.endAt !== undefined ? { endAt: new Date(input.endAt) } : {}), ...(input.targetAcademyIds !== undefined ? { audienceKind: input.targetAcademyIds.length ? "ACADEMIES" : "EVERYONE" } : {}), timeline: { create: { actorId, action: "UPDATED", description: "Updated platform broadcast." } } }, include: { academyTargets: true } });
    return updated;
  });
}
export async function publishBroadcast(actorId: string, id: string) {
  const result = await prisma.$transaction(async (tx) => {
    const current = await tx.broadcast.findFirst({ where: { id, academyId: null, deletedAt: null, status: { in: ["DRAFT", "SCHEDULED"] } }, include: { academyTargets: true } });
    if (!current) throw conflict("BROADCAST_NOT_PUBLISHABLE", "The platform broadcast is not publishable.");
    const activeAcademies = current.academyTargets.length ? [] : await tx.academy.findMany({ where: { status: "ACTIVE", deletedAt: null }, select: { id: true }, take: 10_001 });
    if (activeAcademies.length > 10_000) throw badRequest("BROADCAST_AUDIENCE_TOO_LARGE", "Platform-wide broadcast publication exceeds the 10,000 academy safety limit.");
    const academyIds = current.academyTargets.length ? current.academyTargets.map((target) => target.academyId) : activeAcademies.map((academy) => academy.id);
    const notificationIds: Array<{ academyId: string; notificationId: string; jobId: string }> = [];
    for (const academyId of academyIds) { const notification = await tx.notification.create({ data: { academyId, senderId: actorId, title: current.title, body: current.message, type: current.type === "ACADEMIC" ? "ACADEMIC_UPDATE" : current.priority === "CRITICAL" ? "ALERT" : "ANNOUNCEMENT", priority: current.priority === "CRITICAL" ? "URGENT" : current.priority === "HIGH" ? "HIGH" : "NORMAL", targetType: "ALL_STUDENTS", status: "DRAFT" } }); const job = await enqueueJob({ kind: "NOTIFICATION_SEND", payload: { notificationId: notification.id, academyId, actorId }, academyId, createdById: actorId, deduplicationKey: notification.id }, tx); notificationIds.push({ academyId, notificationId: notification.id, jobId: job.id }); }
    const updated = await tx.broadcast.update({ where: { id }, data: { status: "ACTIVE", publishedAt: new Date(), startAt: current.startAt ?? new Date(), timeline: { create: { actorId, action: "PUBLISHED", description: `Published to ${academyIds.length} academies.` } } } });
    return { updated, notificationIds };
  });
  const deliveryResults = await Promise.allSettled(result.notificationIds.map((target) => dispatchQueuedNotification(target.notificationId, target.academyId, actorId)));
  const mobileAudience = await fanoutPlatformBroadcastToUnaffiliatedLearners(id);
  return {
    ...result.updated,
    deliveries: result.notificationIds.map((target, index) => ({ ...target, status: deliveryResults[index]?.status === "fulfilled" ? "SENT" as const : "QUEUED" as const })),
    mobilePush: { status: "QUEUED" as const, directLearners: mobileAudience.created },
  };
}
export async function scheduleBroadcast(actorId: string, id: string, startAt: string) { const date = new Date(startAt); if (date <= new Date()) throw badRequest("INVALID_BROADCAST_SCHEDULE", "startAt must be in the future."); return prisma.$transaction(async (tx) => { const changed = await tx.broadcast.updateMany({ where: { id, academyId: null, deletedAt: null, status: { in: ["DRAFT", "SCHEDULED"] } }, data: { status: "SCHEDULED", startAt: date } }); if (!changed.count) throw conflict("BROADCAST_NOT_SCHEDULABLE", "The broadcast is not schedulable."); await enqueueJob({ kind: "GLOBAL_BROADCAST_PUBLISH", payload: { broadcastId: id, actorId }, createdById: actorId, runAt: date, deduplicationKey: id }, tx); return tx.broadcast.findUniqueOrThrow({ where: { id } }); }); }
export async function lifecycleBroadcast(actorId: string, id: string, action: "cancel" | "archive" | "restore" | "delete") { return prisma.$transaction(async (tx) => { const current = await tx.broadcast.findFirst({ where: { id, academyId: null, deletedAt: null } }); if (!current) throw notFound("BROADCAST_NOT_FOUND", "The platform broadcast was not found."); if (action === "cancel" && current.status !== "SCHEDULED") throw conflict("BROADCAST_NOT_CANCELLABLE", "Only scheduled broadcasts can be cancelled."); const data = action === "cancel" ? { status: "DRAFT" as const, startAt: null } : action === "archive" ? { status: "ARCHIVED" as const } : action === "restore" ? { status: "DRAFT" as const, publishedAt: null } : { status: "ARCHIVED" as const, deletedAt: new Date() }; const updated = await tx.broadcast.update({ where: { id }, data }); if (action === "cancel" || action === "delete") await tx.backgroundJob.updateMany({ where: { kind: "GLOBAL_BROADCAST_PUBLISH", deduplicationKey: id, status: { in: ["PENDING", "PROCESSING"] } }, data: { status: "CANCELLED", lockedAt: null, lockedBy: null } }); await tx.systemAuditLog.create({ data: { actorId, action: `PLATFORM_BROADCAST_${action.toUpperCase()}`, entityType: "Broadcast", entityId: id, description: `${action} platform broadcast ${current.title}.` } }); return updated; }); }

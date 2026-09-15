import type { TenantContext } from "../auth/tenant-auth.js";
import { prisma } from "../db/prisma.js";
import { notFound } from "../errors/api-error.js";

const academyId = (context: TenantContext) => context.academyId!;
export async function listTemplates(context: TenantContext, category?: string) {
  return prisma.notificationTemplate.findMany({ where: { academyId: academyId(context), ...(category ? { category } : {}) }, orderBy: [{ category: "asc" }, { title: "asc" }], take: 500 });
}
export async function createTemplate(context: TenantContext, input: { title: string; body: string; category?: string }) {
  return prisma.$transaction(async (tx) => {
    const template = await tx.notificationTemplate.create({ data: { academyId: academyId(context), title: input.title.trim(), body: input.body.trim(), category: input.category?.trim().toUpperCase() ?? "GENERAL" } });
    await tx.systemAuditLog.create({ data: { actorId: context.user.id, academyId: academyId(context), action: "NOTIFICATION_TEMPLATE_CREATED", entityType: "NotificationTemplate", entityId: template.id, description: `Created notification template ${template.title}.` } });
    return template;
  });
}
export async function updateTemplate(context: TenantContext, templateId: string, input: { title?: string; body?: string; category?: string }) {
  const current = await prisma.notificationTemplate.findFirst({ where: { id: templateId, academyId: academyId(context) } });
  if (!current) throw notFound("NOTIFICATION_TEMPLATE_NOT_FOUND", "The notification template was not found in this academy.");
  return prisma.notificationTemplate.update({ where: { id: templateId }, data: { ...(input.title !== undefined ? { title: input.title.trim() } : {}), ...(input.body !== undefined ? { body: input.body.trim() } : {}), ...(input.category !== undefined ? { category: input.category.trim().toUpperCase() } : {}) } });
}
export async function deleteTemplate(context: TenantContext, templateId: string) {
  const deleted = await prisma.notificationTemplate.deleteMany({ where: { id: templateId, academyId: academyId(context) } });
  if (!deleted.count) throw notFound("NOTIFICATION_TEMPLATE_NOT_FOUND", "The notification template was not found in this academy.");
  return { id: templateId, deleted: true };
}
const substitute = (value: string, variables: Record<string, string>) => value.replace(/\{\{\s*([a-zA-Z0-9_.-]{1,50})\s*\}\}/g, (_match, key: string) => variables[key] ?? "");
export async function previewTemplate(context: TenantContext, templateId: string, variables: Record<string, string>) {
  const template = await prisma.notificationTemplate.findFirst({ where: { id: templateId, academyId: academyId(context) } });
  if (!template) throw notFound("NOTIFICATION_TEMPLATE_NOT_FOUND", "The notification template was not found in this academy.");
  return { title: substitute(template.title, variables), body: substitute(template.body, variables), variables: Object.keys(variables) };
}

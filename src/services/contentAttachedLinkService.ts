import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../db/prisma.js";
import { badRequest, conflict, notFound } from "../errors/api-error.js";
import type { ContentScope } from "./contentService.js";

export interface ContentAttachedLinkInput {
  url: string;
  description: string;
}

const linkSelect = {
  id: true,
  contentItemId: true,
  url: true,
  description: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ContentAttachedLinkSelect;

const scopedContentWhere = (scope: ContentScope, contentItemId: string): Prisma.ContentItemWhereInput => ({
  id: contentItemId,
  deletedAt: null,
  course: scope.academyId !== undefined ? { academyId: scope.academyId } : undefined,
});

async function requireScopedContent(scope: ContentScope, contentItemId: string, tx: Prisma.TransactionClient | typeof prisma = prisma) {
  const item = await tx.contentItem.findFirst({
    where: scopedContentWhere(scope, contentItemId),
    select: { id: true, courseId: true, kind: true, name: true },
  });
  if (!item) throw notFound("CONTENT_NOT_FOUND", "The content item was not found in the current scope.");
  return item;
}

export const normalizeContentAttachedLinkInput = (input: ContentAttachedLinkInput) => {
  const rawUrl = input.url.trim();
  const description = input.description.trim();
  if (!rawUrl) throw badRequest("CONTENT_LINK_URL_REQUIRED", "A link is required.");
  if (rawUrl.length > 2_048) throw badRequest("CONTENT_LINK_URL_TOO_LONG", "The link must be 2,048 characters or fewer.");
  if (!description) throw badRequest("CONTENT_LINK_DESCRIPTION_REQUIRED", "A description is required.");
  if (description.length > 2_000) throw badRequest("CONTENT_LINK_DESCRIPTION_TOO_LONG", "The description must be 2,000 characters or fewer.");

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw badRequest("CONTENT_LINK_URL_INVALID", "Enter a valid HTTP or HTTPS link.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw badRequest("CONTENT_LINK_PROTOCOL_UNSUPPORTED", "Only HTTP and HTTPS links are supported.");
  }
  return { url: parsed.toString(), description };
};

async function audit(
  tx: Prisma.TransactionClient,
  scope: ContentScope,
  action: string,
  entityId: string,
  description: string,
  before?: Prisma.InputJsonValue,
  after?: Prisma.InputJsonValue,
) {
  await tx.systemAuditLog.create({
    data: {
      action,
      entityType: "ContentAttachedLink",
      entityId,
      actorId: scope.actorId,
      academyId: scope.academyId,
      description,
      before,
      after,
    },
  });
}

export async function listContentAttachedLinks(scope: ContentScope, contentItemId: string) {
  await requireScopedContent(scope, contentItemId);
  return prisma.contentAttachedLink.findMany({
    where: { contentItemId, deletedAt: null },
    select: linkSelect,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

export async function createContentAttachedLink(scope: ContentScope, contentItemId: string, input: ContentAttachedLinkInput) {
  const data = normalizeContentAttachedLinkInput(input);
  return prisma.$transaction(async (tx) => {
    const item = await requireScopedContent(scope, contentItemId, tx);
    const duplicate = await tx.contentAttachedLink.findFirst({ where: { contentItemId, url: data.url, deletedAt: null }, select: { id: true } });
    if (duplicate) throw conflict("CONTENT_LINK_ALREADY_ATTACHED", "This link is already attached to the content item.");
    const attachedLink = await tx.contentAttachedLink.create({
      data: { contentItemId, createdById: scope.actorId, ...data },
      select: linkSelect,
    });
    await audit(tx, scope, "CONTENT_LINK_ATTACHED", attachedLink.id, `Attached a link to ${item.kind.toLowerCase()} ${item.name}.`, undefined, attachedLink);
    return attachedLink;
  });
}

export async function updateContentAttachedLink(scope: ContentScope, contentItemId: string, linkId: string, input: ContentAttachedLinkInput) {
  const data = normalizeContentAttachedLinkInput(input);
  return prisma.$transaction(async (tx) => {
    await requireScopedContent(scope, contentItemId, tx);
    const existing = await tx.contentAttachedLink.findFirst({ where: { id: linkId, contentItemId, deletedAt: null }, select: linkSelect });
    if (!existing) throw notFound("CONTENT_LINK_NOT_FOUND", "The attached link was not found in the current scope.");
    const duplicate = await tx.contentAttachedLink.findFirst({ where: { contentItemId, url: data.url, deletedAt: null, id: { not: linkId } }, select: { id: true } });
    if (duplicate) throw conflict("CONTENT_LINK_ALREADY_ATTACHED", "This link is already attached to the content item.");
    const attachedLink = await tx.contentAttachedLink.update({ where: { id: linkId }, data, select: linkSelect });
    await audit(tx, scope, "CONTENT_LINK_UPDATED", linkId, "Updated an attached content link.", existing, attachedLink);
    return attachedLink;
  });
}

export async function deleteContentAttachedLink(scope: ContentScope, contentItemId: string, linkId: string) {
  return prisma.$transaction(async (tx) => {
    await requireScopedContent(scope, contentItemId, tx);
    const existing = await tx.contentAttachedLink.findFirst({ where: { id: linkId, contentItemId, deletedAt: null }, select: linkSelect });
    if (!existing) throw notFound("CONTENT_LINK_NOT_FOUND", "The attached link was not found in the current scope.");
    const deletedAt = new Date();
    await tx.contentAttachedLink.update({ where: { id: linkId }, data: { deletedAt } });
    await audit(tx, scope, "CONTENT_LINK_REMOVED", linkId, "Removed an attached content link.", existing, { ...existing, deletedAt: deletedAt.toISOString() });
    return { success: true };
  });
}

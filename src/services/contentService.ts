import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../db/prisma.js";
import { ApiError, badRequest, conflict, notFound } from "../errors/api-error.js";
import { getStorageProvider } from "../integrations/provider-registry.js";
import { sanitizeRichText } from "../utils/sanitize-html.js";
import { assertFileNameMatchesMime, isAllowedContentMimeType } from "../utils/upload-validation.js";
import { generatePdfFirstPageCover } from "./pdfCoverService.js";
import { normalizeAccessDurationPolicy } from "./resourceValidityService.js";

export interface ContentScope { academyId?: string | null; actorId: string }
export interface PageInput { page: number; limit: number; courseId: string; parentId?: string | null; search?: string; includeArchived?: boolean }

const MAX_FILE_SIZE = 500 * 1024 * 1024;
const contentSelect = {
  id: true, courseId: true, parentId: true, kind: true, name: true, size: true, mimeType: true,
  description: true, entityType: true, accessType: true, price: true, validityMode: true, validityOffsetDays: true, status: true, displayOrder: true,
  createdAt: true, updatedAt: true, deletedAt: true,
} satisfies Prisma.ContentItemSelect;

const apiContent = <T extends { size?: unknown; price?: unknown }>(item: T) => ({
  ...item,
  size: Number(item.size ?? 0),
  price: item.price == null ? null : Number(item.price),
});
const normalizeFileName = (name: string) => {
  const normalized = name.normalize("NFKC").replace(/[\\/\u0000-\u001f\u007f]/g, "-").replace(/\s+/g, " ").trim();
  if (!normalized || normalized === "." || normalized === "..") throw badRequest("INVALID_FILE_NAME", "A safe file name is required.");
  return normalized.slice(0, 180);
};

async function courseForScope(scope: ContentScope, courseId: string, tx: Prisma.TransactionClient | typeof prisma = prisma) {
  const course = await tx.course.findFirst({ where: { id: courseId, deletedAt: null, ...(scope.academyId !== undefined ? { academyId: scope.academyId } : {}) }, select: { id: true, academyId: true } });
  if (!course) throw notFound("COURSE_NOT_FOUND", "The course was not found in the current scope.");
  return course;
}

async function parentForCourse(courseId: string, parentId: string | null | undefined, tx: Prisma.TransactionClient | typeof prisma = prisma) {
  if (!parentId) return null;
  const parent = await tx.contentItem.findFirst({ where: { id: parentId, courseId, kind: "FOLDER", deletedAt: null }, select: { id: true } });
  if (!parent) throw notFound("PARENT_FOLDER_NOT_FOUND", "The parent folder was not found in this course.");
  return parent;
}

async function audit(tx: Prisma.TransactionClient, scope: ContentScope, action: string, entityId: string, description: string, before?: Prisma.InputJsonValue, after?: Prisma.InputJsonValue) {
  await tx.systemAuditLog.create({ data: { action, entityType: "ContentItem", entityId, actorId: scope.actorId, academyId: scope.academyId, description, before, after } });
}

export async function listContent(scope: ContentScope, input: PageInput & { parentId?: string | "all" | null }) {
  await courseForScope(scope, input.courseId);
  if (input.parentId && input.parentId !== "all") await parentForCourse(input.courseId, input.parentId);
  const where: Prisma.ContentItemWhereInput = {
    courseId: input.courseId,
    ...(input.parentId === "all" ? {} : { parentId: input.parentId ?? null }),
    ...(input.includeArchived ? {} : { deletedAt: null }),
    ...(input.search ? { name: { contains: input.search, mode: "insensitive" } } : {}),
    AND: [{ OR: [{ entityType: null }, { entityType: { not: "MONTHLY_REPORT" } }] }],
  };
  const [rows, total] = await Promise.all([
    prisma.contentItem.findMany({ where, select: contentSelect, skip: (input.page - 1) * input.limit, take: input.limit, orderBy: [{ displayOrder: "asc" }, { name: "asc" }, { id: "asc" }] }),
    prisma.contentItem.count({ where }),
  ]);
  return { data: rows.map((row) => apiContent(row)), pagination: { page: input.page, limit: input.limit, total, totalPages: Math.ceil(total / input.limit) } };
}

export async function getContent(scope: ContentScope, contentId: string) {
  const item = await prisma.contentItem.findFirst({ where: { id: contentId, deletedAt: null, course: scope.academyId !== undefined ? { academyId: scope.academyId } : undefined }, select: { ...contentSelect, sampleImages: true, storeSections: true, locations: true, _count: { select: { children: true } } } });
  if (!item) throw notFound("CONTENT_NOT_FOUND", "The content item was not found in the current scope.");
  const provider = getStorageProvider();
  const sampleImages = await Promise.all(item.sampleImages.map(async (image) => ({
    id: image.id,
    role: image.role,
    name: image.name,
    mimeType: image.mimeType,
    size: Number(image.size),
    displayOrder: image.displayOrder,
    url: await provider.createDownloadUrl(image.storagePath, 900),
  })));
  return apiContent({ ...item, sampleImages });
}

export async function createFolder(scope: ContentScope, payload: { courseId: string; parentId?: string | null; name: string; description?: string; displayOrder?: number }) {
  return prisma.$transaction(async (tx) => {
    await courseForScope(scope, payload.courseId, tx);
    await parentForCourse(payload.courseId, payload.parentId, tx);
    const name = normalizeFileName(payload.name);
    const duplicate = await tx.contentItem.findFirst({ where: { courseId: payload.courseId, parentId: payload.parentId ?? null, name: { equals: name, mode: "insensitive" }, deletedAt: null }, select: contentSelect });
    if (duplicate && duplicate.kind === "FOLDER") {
      return apiContent(duplicate);
    }
    if (duplicate) throw conflict("CONTENT_NAME_CONFLICT", "An item with this name already exists in the folder.");
    const folder = await tx.contentItem.create({ data: { courseId: payload.courseId, parentId: payload.parentId ?? null, kind: "FOLDER", name, description: payload.description?.trim() ?? "", displayOrder: payload.displayOrder ?? 0 }, select: contentSelect });
    await audit(tx, scope, "CONTENT_FOLDER_CREATED", folder.id, `Created folder ${name}.`);
    return apiContent(folder);
  });
}

export async function createUploadIntent(scope: ContentScope, payload: { courseId: string; parentId?: string | null; fileName: string; mimeType: string; sizeBytes: number; checksumSha256: string; purpose?: string }) {
  const course = await courseForScope(scope, payload.courseId);
  await parentForCourse(payload.courseId, payload.parentId);

  // Check if this folder location or any ancestor folder (or root page) has a valid Page Heading
  let currentFolderId: string | null = payload.parentId ?? null;
  let effectiveHeading: string | null = null;
  let pageSettingId = "root";

  for (let depth = 0; depth < 50; depth += 1) {
    const setting = await prisma.contentLocationSetting.findFirst({
      where: { courseId: payload.courseId, folderId: currentFolderId },
    });
    if (setting?.pageHeading) {
      const trimmed = setting.pageHeading.trim().toLowerCase();
      if (trimmed && trimmed !== "untitled page" && trimmed !== "untitled_page") {
        effectiveHeading = setting.pageHeading;
        pageSettingId = setting.id;
        break;
      }
    }
    if (!currentFolderId) break;
    const parentFolder = await prisma.contentItem.findUnique({
      where: { id: currentFolderId },
      select: { parentId: true },
    });
    currentFolderId = parentFolder?.parentId ?? null;
  }

  if (!effectiveHeading) {
    throw badRequest("UNNAMED_PAGE_LOCKED", "Content upload is locked until the page heading is given a valid name.");
  }

  if (!isAllowedContentMimeType(payload.mimeType)) throw badRequest("UNSUPPORTED_FILE_TYPE", "This file type is not allowed.");
  if (payload.sizeBytes < 1 || payload.sizeBytes > MAX_FILE_SIZE) throw badRequest("INVALID_FILE_SIZE", `Files must be between 1 byte and ${MAX_FILE_SIZE} bytes.`);
  if (!/^[a-f0-9]{64}$/i.test(payload.checksumSha256)) throw badRequest("INVALID_CHECKSUM", "checksumSha256 must be a 64-character hexadecimal SHA-256 digest.");
  const fileName = normalizeFileName(payload.fileName);
  assertFileNameMatchesMime(fileName, payload.mimeType);
  if (await prisma.contentItem.findFirst({ where: { courseId: payload.courseId, parentId: payload.parentId ?? null, name: { equals: fileName, mode: "insensitive" }, deletedAt: null }, select: { id: true } })) {
    throw conflict("CONTENT_NAME_CONFLICT", "An item with this name already exists in the folder.");
  }

  // Deterministic Object Key: courses/{courseId}/pages/{pageId}/folders/{folderId}/{safeFileName} or .../root/{safeFileName}
  const pageId = pageSettingId;
  const folderSegment = payload.parentId ? `folders/${payload.parentId}` : "root";
  const safeUniqueKey = `${randomUUID().slice(0, 8)}-${fileName}`;
  const objectKey = `courses/${payload.courseId}/pages/${pageId}/${folderSegment}/${safeUniqueKey}`;

  const provider = getStorageProvider();
  const signed = await provider.createUploadUrl({
    academyId: scope.academyId ?? course.academyId ?? "platform",
    objectKey,
    mimeType: payload.mimeType.toLowerCase(),
    sizeBytes: payload.sizeBytes,
    checksumSha256: payload.checksumSha256.toLowerCase(),
  });

  const upload = await prisma.storageUpload.create({
    data: {
      academyId: course.academyId,
      courseId: payload.courseId,
      createdById: scope.actorId,
      objectKey,
      originalName: fileName,
      mimeType: payload.mimeType.toLowerCase(),
      sizeBytes: BigInt(payload.sizeBytes),
      checksumSha256: payload.checksumSha256.toLowerCase(),
      purpose: payload.purpose ?? "CONTENT",
      status: "PENDING",
      expiresAt: signed.expiresAt,
    },
    select: { id: true, objectKey: true, expiresAt: true },
  });

  return { uploadId: upload.id, uploadUrl: signed.uploadUrl, headers: signed.headers, expiresAt: upload.expiresAt, objectKey: upload.objectKey };
}

export async function uploadProxy(scope: ContentScope, uploadId: string, fileBuffer: Buffer) {
  const upload = await prisma.storageUpload.findFirst({ where: { id: uploadId, createdById: scope.actorId, ...(scope.academyId !== undefined ? { academyId: scope.academyId } : {}) } });
  if (!upload) throw notFound("UPLOAD_NOT_FOUND", "The upload session was not found in the current scope.");
  if (upload.status !== "PENDING" || upload.expiresAt <= new Date()) throw conflict("UPLOAD_NOT_FINALIZABLE", "The upload session is expired or no longer pending.");
  if (fileBuffer.byteLength !== Number(upload.sizeBytes)) {
    throw conflict("UPLOAD_SIZE_MISMATCH", "The uploaded file size does not match the upload intent.");
  }
  const actualChecksum = createHash("sha256").update(fileBuffer).digest("hex");
  if (actualChecksum !== upload.checksumSha256.toLowerCase()) {
    throw conflict("UPLOAD_CHECKSUM_MISMATCH", "The uploaded file checksum does not match the upload intent.");
  }

  const provider = getStorageProvider();
  if (provider.putObject) {
    await provider.putObject(upload.objectKey, fileBuffer, upload.mimeType, upload.checksumSha256);
  } else {
    throw badRequest("PROXY_UPLOAD_UNSUPPORTED", "Storage provider does not support proxy uploads.");
  }
  return { uploadId: upload.id, objectKey: upload.objectKey, uploaded: true };
}

export async function finalizeUpload(scope: ContentScope, uploadId: string, payload: { parentId?: string | null; description?: string; entityType?: Prisma.ContentItemCreateInput["entityType"]; accessType?: "FREE" | "PAID"; price?: number | null; accessDurationValue?: number | null; accessDurationUnit?: "DAYS" | "WEEKS" | "MONTHS" | null; displayOrder?: number }) {
  const upload = await prisma.storageUpload.findFirst({ where: { id: uploadId, createdById: scope.actorId }, select: { id: true, courseId: true, objectKey: true, originalName: true, mimeType: true, sizeBytes: true, checksumSha256: true, status: true, expiresAt: true } });
  if (!upload) throw notFound("UPLOAD_NOT_FOUND", "The upload session was not found.");
  if (upload.status === "FINALIZED") {
    const existing = await prisma.contentItem.findFirst({ where: { storagePath: upload.objectKey, deletedAt: null }, select: contentSelect });
    if (existing) return apiContent(existing);
  }
  if (upload.status !== "PENDING" || upload.expiresAt <= new Date()) throw conflict("UPLOAD_NOT_FINALIZABLE", "The upload session is expired or no longer pending.");

  // Verify object actually exists in Cloudflare R2
  const stat = await getStorageProvider().statObject(upload.objectKey);
  if (stat.sizeBytes !== Number(upload.sizeBytes) || stat.mimeType.toLowerCase() !== upload.mimeType.toLowerCase() || (stat.checksumSha256 && stat.checksumSha256.toLowerCase() !== upload.checksumSha256.toLowerCase())) {
    throw conflict("UPLOAD_VERIFICATION_FAILED", "Stored R2 object metadata does not match declared size, MIME type, or checksum.");
  }
  if (payload.accessType === "PAID" && (!payload.price || payload.price <= 0)) throw badRequest("PRICE_REQUIRED", "Paid content requires a positive price.");
  const validity = normalizeAccessDurationPolicy({ accessType: payload.accessType ?? "FREE", accessDurationValue: payload.accessDurationValue, accessDurationUnit: payload.accessDurationUnit });

  try {
    const finalized = await prisma.$transaction(async (tx) => {
      const claimed = await tx.storageUpload.updateMany({ where: { id: upload.id, status: "PENDING" }, data: { status: "FINALIZED", finalizedAt: new Date() } });
      if (claimed.count !== 1) {
        const existing = await tx.contentItem.findFirst({ where: { storagePath: upload.objectKey }, select: contentSelect });
        if (existing) return apiContent(existing);
        throw conflict("UPLOAD_ALREADY_FINALIZED", "The upload was finalized by another request.");
      }
      await courseForScope(scope, upload.courseId!, tx);
      await parentForCourse(upload.courseId!, payload.parentId, tx);
      if (await tx.contentItem.findFirst({ where: { courseId: upload.courseId!, parentId: payload.parentId ?? null, name: { equals: upload.originalName, mode: "insensitive" }, deletedAt: null } })) throw conflict("CONTENT_NAME_CONFLICT", "An item with this name already exists in the folder.");
      const item = await tx.contentItem.create({ data: {
        courseId: upload.courseId!, parentId: payload.parentId ?? null, kind: "FILE", name: upload.originalName,
        size: upload.sizeBytes, mimeType: upload.mimeType, storagePath: upload.objectKey, description: payload.description?.trim() ?? "",
        entityType: payload.entityType, accessType: validity.accessType, price: validity.accessType === "PAID" ? payload.price : null,
        accessDurationValue: validity.accessDurationValue, accessDurationUnit: validity.accessDurationUnit, validityMode: "PERMANENT" as const, validityOffsetDays: null,
        status: "PUBLISHED", displayOrder: payload.displayOrder ?? 0,
      }, select: contentSelect });
      await audit(tx, scope, "CONTENT_UPLOAD_FINALIZED", item.id, `Finalized upload ${item.name}.`);
      return apiContent(item);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    if (finalized.mimeType?.toLowerCase() === "application/pdf") {
      ensurePdfCoverImage(finalized.id).catch(() => undefined);
    }
    return finalized;
  } catch (error) {
    // A deterministic name conflict cannot succeed on retry, so its new object
    // is safe to remove. Transient DB failures keep the object and PENDING
    // upload session intact so the same finalize request remains retryable.
    if (error instanceof ApiError && error.code === "CONTENT_NAME_CONFLICT") {
      try { await getStorageProvider().deleteObject(upload.objectKey); } catch {}
    }
    throw error;
  }
}

export async function getContentAccessUrl(scope: ContentScope, contentId: string, disposition: "download" | "preview") {
  const item = await prisma.contentItem.findFirst({ where: { id: contentId, kind: "FILE", deletedAt: null, storagePath: { not: null }, course: scope.academyId !== undefined ? { academyId: scope.academyId } : undefined }, select: { id: true, name: true, mimeType: true, storagePath: true } });
  if (!item?.storagePath) throw notFound("FILE_NOT_FOUND", "The file was not found in the current scope.");
  return { id: item.id, fileName: item.name, mimeType: item.mimeType, disposition, url: await getStorageProvider().createDownloadUrl(item.storagePath, 300), expiresIn: 300 };
}

export async function updateContent(scope: ContentScope, contentId: string, payload: { name?: string; description?: string; entityType?: Prisma.ContentItemUpdateInput["entityType"]; accessType?: "FREE" | "PAID"; price?: number | null; accessDurationValue?: number | null; accessDurationUnit?: "DAYS" | "WEEKS" | "MONTHS" | null; status?: "PUBLISHED" | "ARCHIVED"; displayOrder?: number; applyToChildren?: boolean; storeSections?: Array<{ heading: string; content: string; displayOrder?: number }> }) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.contentItem.findFirst({ where: { id: contentId, deletedAt: null, course: scope.academyId !== undefined ? { academyId: scope.academyId } : undefined } });
    if (!existing) throw notFound("CONTENT_NOT_FOUND", "The content item was not found in the current scope.");
    const accessType = payload.accessType ?? existing.accessType;
    const price = payload.price === undefined ? existing.price : payload.price;
    if (accessType === "PAID" && (!price || Number(price) <= 0)) throw badRequest("PRICE_REQUIRED", "Paid content requires a positive price.");
    const validity = normalizeAccessDurationPolicy({
      accessType,
      accessDurationValue: payload.accessDurationValue === undefined ? (payload.accessType === "FREE" ? null : existing.accessDurationValue) : payload.accessDurationValue,
      accessDurationUnit: payload.accessDurationUnit === undefined ? (payload.accessType === "FREE" ? null : existing.accessDurationUnit) : payload.accessDurationUnit,
    });
    const updated = await tx.contentItem.update({ where: { id: contentId }, data: {
      ...(payload.name !== undefined ? { name: normalizeFileName(payload.name) } : {}),
      ...(payload.description !== undefined ? { description: payload.description.trim() } : {}),
      ...(payload.entityType !== undefined ? { entityType: payload.entityType } : {}),
      ...(payload.accessType !== undefined ? { accessType: payload.accessType, price: payload.accessType === "FREE" ? null : price } : payload.price !== undefined ? { price } : {}),
      ...((payload.accessType !== undefined || payload.accessDurationValue !== undefined || payload.accessDurationUnit !== undefined)
        ? { accessDurationValue: validity.accessDurationValue, accessDurationUnit: validity.accessDurationUnit, validityMode: "PERMANENT" as const, validityOffsetDays: null }
        : {}),
      ...(payload.status !== undefined ? { status: payload.status } : {}), ...(payload.displayOrder !== undefined ? { displayOrder: payload.displayOrder } : {}),
    }, select: { ...contentSelect, storeSections: { orderBy: { displayOrder: "asc" } }, sampleImages: { orderBy: [{ role: "asc" }, { displayOrder: "asc" }] } } });

    if (payload.storeSections !== undefined) {
      await tx.contentStoreSection.deleteMany({ where: { contentId } });
      const validSections = payload.storeSections.filter((sec) => sec.heading.trim() || sec.content.trim());
      if (validSections.length > 0) {
        await tx.contentStoreSection.createMany({
          data: validSections.map((sec, idx) => ({
            contentId,
            heading: sec.heading.trim(),
            content: sec.content.trim(),
            displayOrder: sec.displayOrder ?? idx,
          })),
        });
      }
    }

    if (existing.kind === "FOLDER" && payload.applyToChildren) {
      let currentParentIds = [existing.id];
      for (let depth = 0; depth < 20 && currentParentIds.length > 0; depth += 1) {
        const children = await tx.contentItem.findMany({
          where: { parentId: { in: currentParentIds }, deletedAt: null },
          select: { id: true },
        });
        if (!children.length) break;
        const childIds = children.map((c) => c.id);
        await tx.contentItem.updateMany({
          where: { id: { in: childIds } },
          data: {
            accessType,
            price: accessType === "FREE" ? null : price,
            accessDurationValue: validity.accessDurationValue,
            accessDurationUnit: validity.accessDurationUnit,
            validityMode: "PERMANENT",
            validityOffsetDays: null,
          },
        });
        currentParentIds = childIds;
      }
    }

    const reloaded = await tx.contentItem.findUnique({
      where: { id: contentId },
      select: { ...contentSelect, storeSections: { orderBy: { displayOrder: "asc" } }, sampleImages: { orderBy: [{ role: "asc" }, { displayOrder: "asc" }] } },
    });

    await audit(tx, scope, "CONTENT_UPDATED", contentId, `Updated content ${updated.name}.`, {
      accessType: existing.accessType,
      price: existing.price?.toString() ?? null,
      validityMode: existing.validityMode,
      validityOffsetDays: existing.validityOffsetDays,
    }, {
      accessType: reloaded?.accessType ?? updated.accessType,
      price: (reloaded?.price ?? updated.price)?.toString() ?? null,
      validityMode: reloaded?.validityMode ?? updated.validityMode,
      validityOffsetDays: reloaded?.validityOffsetDays ?? updated.validityOffsetDays,
    });
    return apiContent(reloaded ?? updated);
  });
}

export async function moveContent(scope: ContentScope, contentId: string, parentId: string | null) {
  return prisma.$transaction(async (tx) => {
    const item = await tx.contentItem.findFirst({ where: { id: contentId, deletedAt: null, course: scope.academyId !== undefined ? { academyId: scope.academyId } : undefined } });
    if (!item) throw notFound("CONTENT_NOT_FOUND", "The content item was not found in the current scope.");
    await parentForCourse(item.courseId, parentId, tx);
    if (parentId === item.id) throw badRequest("CONTENT_CYCLE", "An item cannot be its own parent.");
    let cursor = parentId;
    for (let depth = 0; cursor && depth < 100; depth += 1) {
      if (cursor === item.id) throw badRequest("CONTENT_CYCLE", "Moving this folder would create a hierarchy cycle.");
      cursor = (await tx.contentItem.findUnique({ where: { id: cursor }, select: { parentId: true } }))?.parentId ?? null;
    }
    if (await tx.contentItem.findFirst({ where: { courseId: item.courseId, parentId, id: { not: item.id }, name: { equals: item.name, mode: "insensitive" }, deletedAt: null } })) throw conflict("CONTENT_NAME_CONFLICT", "An item with this name already exists in the destination folder.");
    const updated = await tx.contentItem.update({ where: { id: item.id }, data: { parentId }, select: contentSelect });
    await audit(tx, scope, "CONTENT_MOVED", item.id, `Moved content ${item.name}.`);
    return apiContent(updated);
  });
}

export async function archiveContent(scope: ContentScope, contentId: string, restore = false) {
  return prisma.$transaction(async (tx) => {
    const item = await tx.contentItem.findFirst({ where: { id: contentId, course: scope.academyId !== undefined ? { academyId: scope.academyId } : undefined } });
    if (!item) throw notFound("CONTENT_NOT_FOUND", "The content item was not found in the current scope.");

    if (!restore && item.deletedAt !== null) return apiContent(item);
    if (restore && item.deletedAt === null) return apiContent(item);

    if (item.kind === "FOLDER") {
      let currentParentIds = [item.id];
      for (let depth = 0; depth < 20 && currentParentIds.length > 0; depth += 1) {
        const children = await tx.contentItem.findMany({
          where: { parentId: { in: currentParentIds }, ...(restore ? {} : { deletedAt: null }) },
          select: { id: true },
        });
        if (!children.length) break;
        const childIds = children.map((c) => c.id);
        await tx.contentItem.updateMany({
          where: { id: { in: childIds } },
          data: restore ? { deletedAt: null, status: "PUBLISHED" } : { deletedAt: new Date(), status: "ARCHIVED" },
        });
        currentParentIds = childIds;
      }
    }

    const updated = await tx.contentItem.update({ where: { id: item.id }, data: restore ? { deletedAt: null, status: "PUBLISHED" } : { deletedAt: new Date(), status: "ARCHIVED" }, select: contentSelect });
    await audit(tx, scope, restore ? "CONTENT_RESTORED" : "CONTENT_ARCHIVED", item.id, `${restore ? "Restored" : "Archived"} content ${item.name}.`);

    return apiContent(updated);
  });
}

export async function copyContent(scope: ContentScope, contentId: string, destinationParentId: string | null) {
  const item = await prisma.contentItem.findFirst({ where: { id: contentId, deletedAt: null, course: scope.academyId !== undefined ? { academyId: scope.academyId } : undefined } });
  if (!item) throw notFound("CONTENT_NOT_FOUND", "The content item was not found in the current scope.");
  await parentForCourse(item.courseId, destinationParentId);
  if (item.kind === "FOLDER") {
    const deduplicationKey = createHash("sha256").update(`${scope.actorId}:${contentId}:${destinationParentId ?? "root"}`).digest("hex");
    const job = await prisma.backgroundJob.upsert({ where: { kind_deduplicationKey: { kind: "CONTENT_TREE_COPY", deduplicationKey } }, create: { academyId: scope.academyId, createdById: scope.actorId, kind: "CONTENT_TREE_COPY", deduplicationKey, payload: { contentId, destinationParentId } }, update: {}, select: { id: true, status: true, runAt: true } });
    return { accepted: true, job };
  }
  if (!item.storagePath) throw conflict("SOURCE_OBJECT_MISSING", "The source file has no storage object.");
  const destinationKey = `${item.storagePath}-copy-${randomUUID()}`;
  await getStorageProvider().copyObject(item.storagePath, destinationKey);
  const copy = await prisma.$transaction(async (tx) => {
    const created = await tx.contentItem.create({ data: { courseId: item.courseId, parentId: destinationParentId, kind: item.kind, name: `Copy of ${item.name}`.slice(0, 180), size: item.size, mimeType: item.mimeType, storagePath: destinationKey, description: item.description, entityType: item.entityType, accessType: item.accessType, price: item.price, validityMode: item.validityMode, validityOffsetDays: item.validityOffsetDays, status: item.status, displayOrder: item.displayOrder }, select: contentSelect });
    await audit(tx, scope, "CONTENT_COPIED", created.id, `Copied content ${item.name}.`);
    return created;
  });
  return apiContent(copy);
}

export async function getLocation(scope: ContentScope, courseId: string, folderId?: string | null) {
  const normFolderId = (!folderId || folderId === "null" || folderId === "undefined") ? null : folderId;
  await courseForScope(scope, courseId);
  await parentForCourse(courseId, normFolderId);
  const setting = await prisma.contentLocationSetting.findFirst({ where: { courseId, folderId: normFolderId } });
  return setting ?? { courseId, folderId: normFolderId, pageHeading: "Untitled Page" };
}

export async function updateLocation(scope: ContentScope, courseId: string, folderId: string | null, pageHeading: string) {
  const normFolderId = (!folderId || folderId === "null") ? null : folderId;
  const trimmed = pageHeading.trim();
  const lower = trimmed.toLowerCase();
  if (!trimmed || lower === "untitled page" || lower === "untitled_page") {
    throw badRequest("INVALID_PAGE_HEADING", "Please enter a valid page heading.");
  }
  if (trimmed.length > 160) {
    throw badRequest("INVALID_PAGE_HEADING", "Page heading cannot exceed 160 characters.");
  }
  await courseForScope(scope, courseId);
  await parentForCourse(courseId, normFolderId);
  return prisma.$transaction(async (tx) => {
    const existing = await tx.contentLocationSetting.findFirst({ where: { courseId, folderId: normFolderId } });
    const setting = existing ? await tx.contentLocationSetting.update({ where: { id: existing.id }, data: { pageHeading: trimmed } }) : await tx.contentLocationSetting.create({ data: { courseId, folderId: normFolderId, pageHeading: trimmed } });
    await tx.systemAuditLog.create({ data: { action: "CONTENT_LOCATION_UPDATED", entityType: "ContentLocationSetting", entityId: setting.id, actorId: scope.actorId, academyId: scope.academyId, description: `Updated content page heading to "${trimmed}".` } });
    return setting;
  });
}

export async function updateDisplayOrders(scope: ContentScope, courseId: string, folderId: string | null, itemIds: string[]) {
  const normFolderId = (!folderId || folderId === "null") ? null : folderId;
  await courseForScope(scope, courseId);
  await parentForCourse(courseId, normFolderId);
  return prisma.$transaction(async (tx) => {
    for (let index = 0; index < itemIds.length; index += 1) {
      await tx.contentItem.updateMany({
        where: { id: itemIds[index], courseId, parentId: normFolderId },
        data: { displayOrder: index },
      });
    }
  });
}

export async function ensurePdfCoverImage(contentId: string) {
  const item = await prisma.contentItem.findUnique({
    where: { id: contentId },
    select: { id: true, name: true, mimeType: true, storagePath: true, courseId: true, accessType: true, deletedAt: true },
  });
  if (!item || !item.storagePath || item.deletedAt || item.mimeType?.toLowerCase() !== "application/pdf") {
    return null;
  }

  const provider = getStorageProvider();
  if (!provider.putObject) return null;
  let pdfBuffer: Buffer;
  try {
    // Download the actual PDF from storage using a short-lived signed URL
    const downloadUrl = await provider.createDownloadUrl(item.storagePath, 120);
    const response = await fetch(downloadUrl);
    if (!response.ok) throw new Error(`Failed to fetch PDF: HTTP ${response.status}`);
    pdfBuffer = Buffer.from(await response.arrayBuffer());
  } catch {
    // If download fails, skip cover generation — don't store a fake placeholder
    return null;
  }

  const generated = await generatePdfFirstPageCover(pdfBuffer, item.name);
  const objectKey = `content/${contentId}/samples/${generated.fileName}`;

  // Compute SHA-256 for the generated cover before uploading
  const checksumSha256 = createHash("sha256").update(generated.buffer).digest("hex");
  await provider.putObject(objectKey, generated.buffer, generated.mimeType, checksumSha256);

  return prisma.$transaction(async (tx) => {
    const existingCover = await tx.contentSampleImage.findFirst({
      where: { contentId, role: "PDF_FIRST_PAGE" },
    });

    if (existingCover) {
      if (existingCover.storagePath !== objectKey) {
        try { await provider.deleteObject(existingCover.storagePath); } catch {}
      }
      return tx.contentSampleImage.update({
        where: { id: existingCover.id },
        data: {
          name: generated.fileName,
          mimeType: generated.mimeType,
          size: generated.sizeBytes,
          storagePath: objectKey,
          displayOrder: 0,
        },
      });
    }

    return tx.contentSampleImage.create({
      data: {
        contentId,
        role: "PDF_FIRST_PAGE",
        name: generated.fileName,
        mimeType: generated.mimeType,
        size: generated.sizeBytes,
        storagePath: objectKey,
        displayOrder: 0,
      },
    });
  });
}

export async function createSampleImageUpload(scope: ContentScope, contentId: string, payload: { fileName: string; mimeType: string; sizeBytes: number; checksumSha256: string }) {
  const content = await prisma.contentItem.findFirst({ where: { id: contentId, kind: "FILE", deletedAt: null, course: scope.academyId !== undefined ? { academyId: scope.academyId } : undefined }, select: { id: true, courseId: true, course: { select: { academyId: true } } } });
  if (!content) throw notFound("CONTENT_NOT_FOUND", "The content item was not found in the current scope.");
  
  const adminPreviewsCount = await prisma.contentSampleImage.count({
    where: { contentId, role: "ADMIN_PREVIEW" },
  });
  if (adminPreviewsCount >= 3) {
    throw badRequest("MAX_PREVIEWS_EXCEEDED", "Maximum 3 optional preview images are allowed.");
  }

  if (!/^image\/(jpeg|png|webp|gif)$/i.test(payload.mimeType) || payload.sizeBytes > 10 * 1024 * 1024) throw badRequest("INVALID_SAMPLE_IMAGE", "Sample images must be JPEG, PNG, WebP, or GIF files no larger than 10 MB.");
  assertFileNameMatchesMime(payload.fileName, payload.mimeType);
  const provider = getStorageProvider(); const objectKey = `academies/${scope.academyId ?? content.course.academyId ?? "platform"}/content/${contentId}/samples/${randomUUID()}/${encodeURIComponent(normalizeFileName(payload.fileName))}`;
  const signed = await provider.createUploadUrl({ academyId: scope.academyId ?? content.course.academyId ?? "platform", objectKey, mimeType: payload.mimeType, sizeBytes: payload.sizeBytes, checksumSha256: payload.checksumSha256.toLowerCase() });
  const upload = await prisma.storageUpload.create({ data: { academyId: content.course.academyId, courseId: content.courseId, createdById: scope.actorId, objectKey, originalName: normalizeFileName(payload.fileName), mimeType: payload.mimeType, sizeBytes: BigInt(payload.sizeBytes), checksumSha256: payload.checksumSha256.toLowerCase(), purpose: `CONTENT_SAMPLE:${contentId}`, expiresAt: signed.expiresAt } });
  return { uploadId: upload.id, uploadUrl: signed.uploadUrl, headers: signed.headers, expiresAt: signed.expiresAt };
}

export async function finalizeSampleImage(scope: ContentScope, contentId: string, uploadId: string, displayOrder?: number) {
  const upload = await prisma.storageUpload.findFirst({ where: { id: uploadId, createdById: scope.actorId, purpose: `CONTENT_SAMPLE:${contentId}`, status: "PENDING", ...(scope.academyId !== undefined ? { academyId: scope.academyId } : {}) } });
  if (!upload) throw notFound("UPLOAD_NOT_FOUND", "The sample image upload was not found.");
  
  const adminPreviewsCount = await prisma.contentSampleImage.count({
    where: { contentId, role: "ADMIN_PREVIEW" },
  });
  if (adminPreviewsCount >= 3) {
    throw badRequest("MAX_PREVIEWS_EXCEEDED", "Maximum 3 optional preview images are allowed.");
  }

  const stat = await getStorageProvider().statObject(upload.objectKey);
  if (stat.sizeBytes !== Number(upload.sizeBytes) || stat.mimeType.toLowerCase() !== upload.mimeType.toLowerCase() || stat.checksumSha256?.toLowerCase() !== upload.checksumSha256) throw conflict("UPLOAD_VERIFICATION_FAILED", "Stored sample image metadata does not match the declaration.");
  
  const finalDisplayOrder = displayOrder ?? (adminPreviewsCount + 1);

  return prisma.$transaction(async (tx) => {
    const image = await tx.contentSampleImage.create({ data: { contentId, role: "ADMIN_PREVIEW", name: upload.originalName, mimeType: upload.mimeType, size: upload.sizeBytes, storagePath: upload.objectKey, displayOrder: finalDisplayOrder } });
    await tx.storageUpload.update({ where: { id: upload.id }, data: { status: "FINALIZED", finalizedAt: new Date() } });
    await audit(tx, scope, "CONTENT_SAMPLE_IMAGE_ADDED", contentId, `Added sample image ${image.name}.`);
    return { ...image, size: Number(image.size) };
  });
}

export async function deleteSampleImage(scope: ContentScope, contentId: string, imageId: string) {
  const image = await prisma.contentSampleImage.findFirst({ where: { id: imageId, contentId, contentItem: { course: scope.academyId !== undefined ? { academyId: scope.academyId } : undefined } } });
  if (!image) throw notFound("SAMPLE_IMAGE_NOT_FOUND", "The sample image was not found in the current scope.");
  if (image.role === "PDF_FIRST_PAGE") {
    throw badRequest("CANNOT_DELETE_COVER", "The automatic PDF first-page cover cannot be removed.");
  }
  await getStorageProvider().deleteObject(image.storagePath);
  await prisma.contentSampleImage.delete({ where: { id: image.id } });
  return { id: image.id, deleted: true };
}

export async function createStoreSection(scope: ContentScope, contentId: string, input: { heading: string; content: string; displayOrder?: number }) {
  await getContent(scope, contentId);
  return prisma.contentStoreSection.create({ data: { contentId, heading: input.heading.trim(), content: sanitizeRichText(input.content), displayOrder: input.displayOrder ?? 0 } });
}
export async function updateStoreSection(scope: ContentScope, contentId: string, sectionId: string, input: { heading?: string; content?: string; displayOrder?: number }) {
  await getContent(scope, contentId); const section = await prisma.contentStoreSection.findFirst({ where: { id: sectionId, contentId } }); if (!section) throw notFound("STORE_SECTION_NOT_FOUND", "The store section was not found.");
  return prisma.contentStoreSection.update({ where: { id: sectionId }, data: { ...(input.heading !== undefined ? { heading: input.heading.trim() } : {}), ...(input.content !== undefined ? { content: sanitizeRichText(input.content) } : {}), ...(input.displayOrder !== undefined ? { displayOrder: input.displayOrder } : {}) } });
}
export async function deleteStoreSection(scope: ContentScope, contentId: string, sectionId: string) { await getContent(scope, contentId); const deleted = await prisma.contentStoreSection.deleteMany({ where: { id: sectionId, contentId } }); if (!deleted.count) throw notFound("STORE_SECTION_NOT_FOUND", "The store section was not found."); return { id: sectionId, deleted: true }; }

export async function executeContentTreeCopyJob(input: { jobId: string; actorId: string; academyId?: string; contentId: string; destinationParentId?: string | null }) {
  const completed = await prisma.idempotencyRecord.findUnique({ where: { scope_key: { scope: "content-tree-copy", key: input.jobId } } });
  if (completed) return completed.responseBody;
  const scope: ContentScope = { actorId: input.actorId, academyId: input.academyId };
  const root = await prisma.contentItem.findFirst({ where: { id: input.contentId, deletedAt: null, course: input.academyId ? { academyId: input.academyId } : undefined } });
  if (!root) throw notFound("CONTENT_NOT_FOUND", "The source content tree was not found.");
  await parentForCourse(root.courseId, input.destinationParentId);
  const levels: Array<Array<typeof root>> = [[root]]; const all = [root];
  for (let depth = 0; depth < 100 && levels[depth]?.length; depth += 1) {
    const parents = levels[depth].filter((item) => item.kind === "FOLDER").map((item) => item.id);
    if (!parents.length) break;
    const children = await prisma.contentItem.findMany({ where: { parentId: { in: parents }, courseId: root.courseId, deletedAt: null }, orderBy: [{ displayOrder: "asc" }, { id: "asc" }], take: 5_001 });
    if (children.length > 5_000) throw badRequest("CONTENT_TREE_TOO_LARGE", "A folder copy is limited to 5,000 content items.");
    if (!children.length) break; all.push(...children); levels.push(children);
    if (all.length > 5_000) throw badRequest("CONTENT_TREE_TOO_LARGE", "A folder copy is limited to 5,000 content items.");
  }
  const provider = getStorageProvider();
  const objectKeys = new Map<string, string>();
  for (const item of all) if (item.storagePath) { const destination = `${item.storagePath}-copy-${input.jobId}`; await provider.copyObject(item.storagePath, destination); objectKeys.set(item.id, destination); }
  const related = await prisma.contentItem.findMany({ where: { id: { in: all.map((item) => item.id) } }, take: 5_000, select: { id: true, storeSections: { take: 500 }, sampleImages: { take: 500 } } });
  const sampleKeys = new Map<string, string>();
  for (const item of related) for (const image of item.sampleImages) { const destination = `${image.storagePath}-copy-${input.jobId}`; await provider.copyObject(image.storagePath, destination); sampleKeys.set(image.id, destination); }
  return prisma.$transaction(async (tx) => {
    const ids = new Map<string, string>(); let copiedRootId = "";
    for (const level of levels) for (const source of level) {
      const parentId = source.id === root.id ? input.destinationParentId ?? null : ids.get(source.parentId!);
      const metadata = related.find((item) => item.id === source.id)!;
      const copy = await tx.contentItem.create({ data: { courseId: source.courseId, parentId, kind: source.kind, name: source.id === root.id ? `Copy of ${source.name}`.slice(0, 180) : source.name, size: source.size, mimeType: source.mimeType, storagePath: objectKeys.get(source.id), description: source.description, entityType: source.entityType, accessType: source.accessType, price: source.price, validityMode: source.validityMode, validityOffsetDays: source.validityOffsetDays, status: source.status, displayOrder: source.displayOrder, storeSections: metadata.storeSections.length ? { create: metadata.storeSections.map((section) => ({ heading: section.heading, content: section.content, displayOrder: section.displayOrder })) } : undefined, sampleImages: metadata.sampleImages.length ? { create: metadata.sampleImages.map((image) => ({ name: image.name, mimeType: image.mimeType, size: image.size, storagePath: sampleKeys.get(image.id)!, displayOrder: image.displayOrder })) } : undefined } });
      ids.set(source.id, copy.id); if (source.id === root.id) copiedRootId = copy.id;
    }
    await audit(tx, scope, "CONTENT_TREE_COPIED", copiedRootId, `Copied content tree ${root.name} (${all.length} items).`);
    const response = { copiedRootId, itemCount: all.length };
    await tx.idempotencyRecord.create({ data: { scope: "content-tree-copy", key: input.jobId, requestHash: createHash("sha256").update(JSON.stringify(input)).digest("hex"), responseCode: 201, responseBody: response, expiresAt: new Date(Date.now() + 30 * 86_400_000) } });
    return response;
  });
}

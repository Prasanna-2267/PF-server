import { createHmac } from "node:crypto";
import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../db/prisma.js";
import { notFound } from "../errors/api-error.js";
import { enqueueJob } from "./backgroundJobService.js";
import { getConfig } from "../config/env.js";

import { getStorageProvider } from "../integrations/provider-registry.js";
import { ensurePdfCoverImage } from "./contentService.js";
import { PDF_COVER_FILE_NAME } from "./pdfCoverService.js";

const money = <T extends Record<string, unknown>>(value: T) => ({ ...value, ...(value.price !== undefined ? { price: Number(value.price) } : {}) });
const activePublicCourseWhere = {
  status: "ACTIVE" as const,
  deletedAt: null,
  OR: [
    { academyId: null },
    { academy: { is: { status: "ACTIVE" as const, deletedAt: null } } },
  ],
} satisfies Prisma.CourseWhereInput;

export async function listCatalog(input: { page: number; limit: number; search?: string; academyId?: string }) {
  const courseWhere: Prisma.CourseWhereInput = { ...activePublicCourseWhere, ...(input.academyId ? { academyId: input.academyId } : {}), ...(input.search ? { AND: [{ OR: [{ name: { contains: input.search, mode: "insensitive" } }, { description: { contains: input.search, mode: "insensitive" } }] }] } : {}) };
  // Legacy Question Bank checkout records used a one-to-one Package wrapper.
  // They remain valid for existing orders, but must never leak into the
  // Bundles collection now that Question Banks have their own Store surface.
  const packageWhere: Prisma.PackageWhereInput = { status: "PUBLISHED", deletedAt: null, questionBank: { is: null }, course: courseWhere };
  // Free and paid banks are both discoverable. Access is enforced by the
  // student practice API, not by hiding free products from the catalog.
  const questionBankWhere: Prisma.QuestionBankWhereInput = { status: "PUBLISHED", deletedAt: null, course: courseWhere };
  const paidItemWhere: Prisma.ContentItemWhereInput = { accessType: "PAID", status: "PUBLISHED", deletedAt: null, course: courseWhere };

  const [courses, packages, questionBanks, paidItems, totalCourses, totalPackages, totalQuestionBanks, totalPaidItems] = await Promise.all([
    prisma.course.findMany({ where: courseWhere, skip: (input.page - 1) * input.limit, take: input.limit, orderBy: [{ name: "asc" }, { id: "asc" }], select: { id: true, slug: true, code: true, name: true, description: true, academy: { select: { id: true, name: true, slug: true, logoUrl: true } }, _count: { select: { subjects: true, contentItems: true, packages: true } } } }),
    prisma.package.findMany({ where: packageWhere, skip: (input.page - 1) * input.limit, take: input.limit, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, courseId: true, title: true, slug: true, description: true, price: true, accessDurationValue: true, accessDurationUnit: true, course: { select: { id: true, name: true, slug: true, academy: { select: { id: true, name: true, slug: true } } } }, _count: { select: { items: true, questionBanks: true } } } }),
    prisma.questionBank.findMany({ where: questionBankWhere, skip: (input.page - 1) * input.limit, take: input.limit, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, courseId: true, name: true, slug: true, description: true, accessType: true, status: true, price: true, accessDurationValue: true, accessDurationUnit: true, course: { select: { id: true, name: true, slug: true, academy: { select: { id: true, name: true, slug: true } } } }, packages: { where: { package: { status: "PUBLISHED", deletedAt: null, questionBank: { is: null } } }, orderBy: { displayOrder: "asc" }, select: { package: { select: { id: true, title: true, slug: true } } } }, _count: { select: { questions: { where: { status: "PUBLISHED", deletedAt: null } } } } } }),
    prisma.contentItem.findMany({ where: paidItemWhere, skip: (input.page - 1) * input.limit, take: input.limit, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, courseId: true, name: true, description: true, price: true, accessDurationValue: true, accessDurationUnit: true, entityType: true, kind: true, mimeType: true, size: true, course: { select: { name: true, academy: { select: { id: true, name: true, slug: true } } } }, sampleImages: { orderBy: { displayOrder: "asc" }, select: { id: true, name: true, displayOrder: true } }, storeSections: { orderBy: { displayOrder: "asc" }, select: { id: true, heading: true, content: true, displayOrder: true } } } }),
    prisma.course.count({ where: courseWhere }),
    prisma.package.count({ where: packageWhere }),
    prisma.questionBank.count({ where: questionBankWhere }),
    prisma.contentItem.count({ where: paidItemWhere }),
  ]);

  return {
    courses,
    packages: packages.map((item) => money(item)),
    questionBanks: questionBanks.map((item) => money(item)),
    paidItems: paidItems.map((item) => ({ ...money(item), size: Number(item.size) })),
    pagination: { page: input.page, limit: input.limit, totalCourses, totalPackages, totalQuestionBanks, totalPaidItems },
  };
}

export async function getCatalogCourse(courseId: string) {
  const course = await prisma.course.findFirst({ where: { id: courseId, ...activePublicCourseWhere }, include: { academy: { select: { id: true, name: true, slug: true } }, subjects: { where: { deletedAt: null }, orderBy: { name: "asc" }, take: 500 }, packages: { where: { status: "PUBLISHED", deletedAt: null, questionBank: { is: null } }, orderBy: { title: "asc" }, take: 500, include: { items: { orderBy: { displayOrder: "asc" }, take: 2_000, include: { contentItem: { select: { id: true, name: true, description: true, entityType: true } } } }, questionBanks: { orderBy: { displayOrder: "asc" }, take: 2_000, include: { questionBank: { select: { id: true, name: true, slug: true, description: true, accessType: true, status: true, _count: { select: { questions: { where: { status: "PUBLISHED", deletedAt: null } } } } } } } } } } } });
  if (!course) throw notFound("CATALOG_COURSE_NOT_FOUND", "The published course was not found.");
  return { ...course, packages: course.packages.map((item) => money(item)) };
}

export async function getCatalogPackage(packageId: string) {
  const item = await prisma.package.findFirst({ where: { id: packageId, status: "PUBLISHED", deletedAt: null, questionBank: { is: null }, course: activePublicCourseWhere }, include: { course: { select: { id: true, name: true, slug: true, academy: { select: { id: true, name: true, slug: true } } } }, items: { orderBy: { displayOrder: "asc" }, take: 2_000, include: { contentItem: { select: { id: true, name: true, description: true, entityType: true, mimeType: true, kind: true, size: true, accessType: true, accessDurationValue: true, accessDurationUnit: true } } } }, questionBanks: { orderBy: { displayOrder: "asc" }, take: 2_000, include: { questionBank: { select: { id: true, name: true, slug: true, description: true, accessType: true, price: true, status: true, accessDurationValue: true, accessDurationUnit: true, _count: { select: { questions: { where: { status: "PUBLISHED", deletedAt: null } } } } } } } } } });
  if (!item) throw notFound("CATALOG_PACKAGE_NOT_FOUND", "The published package was not found.");
  return money({
    ...item,
    items: item.items.map((i) => ({ ...i, contentItem: { ...i.contentItem, size: Number(i.contentItem.size) } })),
    questionBanks: item.questionBanks
      .filter((membership) => membership.questionBank.status === "PUBLISHED")
      .map((membership) => ({ ...membership, questionBank: money(membership.questionBank) })),
  });
}

export async function getCatalogContent(contentId: string) {
  let item = await prisma.contentItem.findFirst({
    where: { id: contentId, accessType: "PAID", status: "PUBLISHED", deletedAt: null, course: activePublicCourseWhere },
    include: {
      course: { select: { id: true, name: true, code: true, slug: true, academy: { select: { id: true, name: true, slug: true } } } },
      sampleImages: { orderBy: [{ role: "asc" }, { displayOrder: "asc" }] },
      storeSections: { orderBy: { displayOrder: "asc" } },
    },
  });
  if (!item) throw notFound("CATALOG_CONTENT_NOT_FOUND", "The published paid item was not found.");

  const existingCover = item.sampleImages.find((img) => img.role === "PDF_FIRST_PAGE");
  const needsCover = item.mimeType?.toLowerCase() === "application/pdf" && (
    !existingCover ||
    existingCover.mimeType.toLowerCase() !== "image/png" ||
    existingCover.name !== PDF_COVER_FILE_NAME ||
    // Verify the stored object actually exists — previous broken uploads left orphaned DB rows
    await (async () => {
      try { await getStorageProvider().statObject(existingCover.storagePath); return false; } catch { return true; }
    })()
  );

  if (needsCover) {
    // Delete the broken DB record first so ensurePdfCoverImage can create a fresh one
    if (existingCover) {
      await prisma.contentSampleImage.delete({ where: { id: existingCover.id } }).catch(() => {});
    }
    await ensurePdfCoverImage(contentId);
    item = await prisma.contentItem.findFirst({
      where: { id: contentId },
      include: {
        course: { select: { id: true, name: true, code: true, slug: true, academy: { select: { id: true, name: true, slug: true } } } },
        sampleImages: { orderBy: [{ role: "asc" }, { displayOrder: "asc" }] },
        storeSections: { orderBy: { displayOrder: "asc" } },
      },
    }) as any;
  }

  const sortedSamples = [...(item?.sampleImages || [])].sort((a, b) => {
    if (a.role === "PDF_FIRST_PAGE" && b.role !== "PDF_FIRST_PAGE") return -1;
    if (a.role !== "PDF_FIRST_PAGE" && b.role === "PDF_FIRST_PAGE") return 1;
    return a.displayOrder - b.displayOrder;
  });

  const provider = getStorageProvider();
  const sampleImagesWithUrls = await Promise.all(
    sortedSamples.map(async (img) => ({
      id: img.id,
      role: img.role,
      name: img.name,
      mimeType: img.mimeType,
      displayOrder: img.displayOrder,
      url: await provider.createDownloadUrl(img.storagePath, 3600),
    }))
  );

  return money({
    id: item!.id,
    courseId: item!.courseId,
    name: item!.name,
    description: item!.description,
    price: item!.price,
    accessType: item!.accessType,
    accessDuration: { value: item!.accessDurationValue, unit: item!.accessDurationUnit },
    entityType: item!.entityType,
    kind: item!.kind,
    mimeType: item!.mimeType,
    size: Number(item!.size),
    course: item!.course,
    sampleImages: sampleImagesWithUrls,
    previews: sampleImagesWithUrls,
    storeSections: item!.storeSections,
    highlights: item!.storeSections.map((sec) => ({ id: sec.id, heading: sec.heading, content: sec.content, displayOrder: sec.displayOrder })),
  });
}

export async function getCatalogContentCover(contentId: string) {
  const source = await prisma.contentItem.findFirst({
    where: { id: contentId, kind: "FILE", accessType: "PAID", status: "PUBLISHED", deletedAt: null, course: activePublicCourseWhere },
    select: { mimeType: true, storagePath: true },
  });
  if (!source) throw notFound("CATALOG_CONTENT_NOT_FOUND", "The published paid item was not found.");
  if (source.mimeType?.toLowerCase().startsWith("image/") && source.storagePath) {
    return { mimeType: source.mimeType, url: await getStorageProvider().createDownloadUrl(source.storagePath, 300) };
  }

  const item = await getCatalogContent(contentId);
  const cover = item.sampleImages.find((image) => image.role === "PDF_FIRST_PAGE")
    ?? item.sampleImages.find((image) => image.role === "ADMIN_PREVIEW");
  if (!cover) throw notFound("CATALOG_CONTENT_COVER_NOT_FOUND", "A first-page preview is not available for this item.");
  return cover;
}

export async function getCatalogContentPreviewImage(contentId: string, imageId: string) {
  const image = await prisma.contentSampleImage.findFirst({
    where: {
      id: imageId,
      contentId,
      contentItem: { accessType: "PAID", status: "PUBLISHED", deletedAt: null, course: activePublicCourseWhere },
    },
    select: { mimeType: true, storagePath: true },
  });
  if (!image) throw notFound("CATALOG_PREVIEW_NOT_FOUND", "The content preview was not found.");
  return { mimeType: image.mimeType, url: await getStorageProvider().createDownloadUrl(image.storagePath, 300) };
}
export async function submitContact(input: { name: string; email: string; phone?: string; subject: string; message: string; academyId?: string; ipAddress?: string }) {
  const ipHash = input.ipAddress ? createHmac("sha256", getConfig().auth.jwtSecret).update(input.ipAddress).digest("hex") : undefined;
  const result = await prisma.$transaction(async (tx) => {
    if (input.academyId && !await tx.academy.findFirst({ where: { id: input.academyId, status: "ACTIVE", deletedAt: null } })) throw notFound("ACADEMY_NOT_FOUND", "The selected academy was not found.");
    const submission = await tx.contactSubmission.create({ data: { academyId: input.academyId, name: input.name.trim(), email: input.email.toLowerCase(), phone: input.phone?.trim(), subject: input.subject.trim(), message: input.message.trim(), ipHash } });
    const job = await enqueueJob({ kind: "CONTACT_EMAIL", payload: { submissionId: submission.id }, academyId: input.academyId, runAt: new Date(), deduplicationKey: submission.id }, tx);
    return { submission, job };
  });
  return { id: result.submission.id, status: "RECEIVED", delivery: { status: "QUEUED", jobId: result.job.id } };
}

export async function getStudentUserCourses(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      learnerPreference: {
        select: {
          selectedCourse: {
            select: { id: true, name: true, slug: true, code: true, status: true, deletedAt: true },
          },
        },
      },
      academyEnrollments: {
        where: { course: { status: "ACTIVE", deletedAt: null } },
        select: { course: { select: { id: true, name: true, slug: true, code: true } } },
      },
    },
  });
  const selectedCourse = user?.learnerPreference?.selectedCourse;
  if (selectedCourse?.status === "ACTIVE" && !selectedCourse.deletedAt) {
    const { status: _status, deletedAt: _deletedAt, ...course } = selectedCourse;
    return [course];
  }

  const unique = new Map<string, { id: string; name: string; slug: string; code: string }>();
  for (const enrollment of user?.academyEnrollments ?? []) {
    unique.set(enrollment.course.id, enrollment.course);
  }
  return [...unique.values()];
}

export async function getCatalogQuestionBank(questionBankId: string) {
  const item = await prisma.questionBank.findFirst({
    where: {
      id: questionBankId,
      status: "PUBLISHED",
      deletedAt: null,
      course: activePublicCourseWhere,
    },
    select: {
      id: true,
      courseId: true,
      name: true,
      slug: true,
      description: true,
      accessType: true,
      status: true,
      price: true,
      accessDurationValue: true,
      accessDurationUnit: true,
      course: { select: { id: true, name: true, slug: true, academy: { select: { id: true, name: true, slug: true } } } },
      packages: { where: { package: { status: "PUBLISHED", deletedAt: null, questionBank: { is: null } } }, orderBy: { displayOrder: "asc" }, select: { package: { select: { id: true, title: true, slug: true } } } },
      _count: { select: { questions: { where: { status: "PUBLISHED", deletedAt: null } } } },
    },
  });
  if (!item) throw notFound("CATALOG_QUESTION_BANK_NOT_FOUND", "The published Question Bank was not found.");
  return money(item);
}

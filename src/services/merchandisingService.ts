import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../db/prisma.js";
import { badRequest, notFound } from "../errors/api-error.js";
import { getStorageProvider } from "../integrations/provider-registry.js";

export interface MerchandisingSectionInput {
  title?: string;
  subtitle?: string;
  mode?: "AUTO" | "HYBRID" | "MANUAL";
  limit?: number;
  dateWindowDays?: number | null;
  pinnedItemIds?: string[];
  excludedItemIds?: string[];
  isEnabled?: Boolean;
}

const DEFAULT_SECTIONS = [
  { key: "best-sellers", title: "Best Sellers", subtitle: "Top purchased learning resources", mode: "AUTO" as const, limit: 8, dateWindowDays: 30 },
  { key: "new-releases", title: "New Releases", subtitle: "Recently published notes & packages", mode: "AUTO" as const, limit: 8 },
  { key: "most-popular", title: "Most Popular", subtitle: "High engagement & student favorites", mode: "AUTO" as const, limit: 8 },
  { key: "recommended", title: "Recommended for You", subtitle: "Course-tailored unowned resources", mode: "AUTO" as const, limit: 8 },
  { key: "featured", title: "Featured Spotlight", subtitle: "Handpicked recommendations for your course", mode: "HYBRID" as const, limit: 4 },
];

export async function ensureMerchandisingSectionsSeeded() {
  for (const def of DEFAULT_SECTIONS) {
    await prisma.storeMerchandisingSection.upsert({
      where: { key: def.key },
      create: {
        key: def.key,
        title: def.title,
        subtitle: def.subtitle,
        mode: def.mode,
        limit: def.limit,
        dateWindowDays: def.dateWindowDays ?? null,
      },
      update: {},
    });
  }
}

export async function getMerchandisingSections() {
  await ensureMerchandisingSectionsSeeded();
  return prisma.storeMerchandisingSection.findMany({
    orderBy: { createdAt: "asc" },
  });
}

export async function updateMerchandisingSection(key: string, input: MerchandisingSectionInput) {
  await ensureMerchandisingSectionsSeeded();
  const section = await prisma.storeMerchandisingSection.findUnique({ where: { key } });
  if (!section) throw notFound("SECTION_NOT_FOUND", `Merchandising section '${key}' was not found.`);

  if (input.limit !== undefined && (input.limit < 1 || input.limit > 50)) {
    throw badRequest("INVALID_LIMIT", "Display limit must be between 1 and 50.");
  }

  return prisma.storeMerchandisingSection.update({
    where: { key },
    data: {
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.subtitle !== undefined ? { subtitle: input.subtitle.trim() } : {}),
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.dateWindowDays !== undefined ? { dateWindowDays: input.dateWindowDays } : {}),
      ...(input.pinnedItemIds !== undefined ? { pinnedItemIds: input.pinnedItemIds } : {}),
      ...(input.excludedItemIds !== undefined ? { excludedItemIds: input.excludedItemIds } : {}),
      ...(input.isEnabled !== undefined ? { isEnabled: Boolean(input.isEnabled) } : {}),
    },
  });
}

export async function computeCollectionProducts(key: string, courseSlug = "all", studentUserId?: string) {
  await ensureMerchandisingSectionsSeeded();
  const section = await prisma.storeMerchandisingSection.findUnique({ where: { key } });
  if (!section || !section.isEnabled) {
    return { section: section || { key, title: key, isEnabled: false }, products: [] };
  }

  // 1. Resolve Target Course IDs
  let targetCourseIds: string[] = [];
  let isSpecificCourse = false;

  if (courseSlug && courseSlug !== "all") {
    const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(courseSlug);
    const course = await prisma.course.findFirst({
      where: {
        OR: [
          { slug: courseSlug },
          ...(isUuid ? [{ id: courseSlug }] : []),
        ],
        deletedAt: null,
      },
      select: { id: true },
    });
    if (course) {
      targetCourseIds = [course.id];
      isSpecificCourse = true;
    }
  }

  // 2. Resolve Student Enrolment & Entitlements
  let studentCourseIds: string[] = [];
  let ownedContentIds: Set<string> = new Set();
  let ownedPackageIds: Set<string> = new Set();

  if (studentUserId) {
    const student = await prisma.user.findUnique({
      where: { id: studentUserId },
      include: {
        academyEnrollments: { select: { courseId: true } },
        entitlements: { where: { status: "ACTIVE" }, select: { packageId: true, contentItemId: true } },
      },
    });

    if (student) {
      studentCourseIds = student.academyEnrollments.map((e) => e.courseId).filter((id): id is string => Boolean(id));
      for (const ent of student.entitlements) {
        if (ent.contentItemId) ownedContentIds.add(ent.contentItemId);
        if (ent.packageId) ownedPackageIds.add(ent.packageId);
      }
    }
  }

  // 3. For 'recommended' section when courseSlug === 'all', scope to student's enrolled courses if available
  if (key === "recommended" && !isSpecificCourse && studentCourseIds.length > 0) {
    targetCourseIds = studentCourseIds;
  }

  const courseWhere: Prisma.CourseWhereInput = {
    status: "ACTIVE",
    deletedAt: null,
    ...(targetCourseIds.length ? { id: { in: targetCourseIds } } : {}),
  };

  const packageWhere: Prisma.PackageWhereInput = {
    status: "PUBLISHED",
    deletedAt: null,
    course: courseWhere,
    id: { notIn: section.excludedItemIds },
  };

  const contentWhere: Prisma.ContentItemWhereInput = {
    accessType: "PAID",
    status: "PUBLISHED",
    deletedAt: null,
    course: courseWhere,
    id: { notIn: section.excludedItemIds },
  };

  const provider = getStorageProvider();

  // Helper to format product item
  const mapPackageToProduct = (pkg: any) => ({
    id: pkg.id,
    type: "bundle" as const,
    productType: pkg.questionBank ? "question-bank" : "bundle",
    title: pkg.title,
    slug: pkg.slug || pkg.id,
    courseId: pkg.courseId,
    course: pkg.course,
    price: Number(pkg.price),
    description: pkg.description,
    itemCount: pkg._count?.items ?? (pkg.items?.length || 0),
    isOwned: ownedPackageIds.has(pkg.id),
  });

  const mapContentToProduct = async (item: any) => {
    const sortedSamples = [...(item.sampleImages || [])].sort((a, b) => {
      if (a.role === "PDF_FIRST_PAGE" && b.role !== "PDF_FIRST_PAGE") return -1;
      if (a.role !== "PDF_FIRST_PAGE" && b.role === "PDF_FIRST_PAGE") return 1;
      return a.displayOrder - b.displayOrder;
    });

    const sampleImagesWithUrls = await Promise.all(
      sortedSamples.map(async (img) => ({
        id: img.id,
        role: img.role,
        name: img.name,
        displayOrder: img.displayOrder,
        url: await provider.createDownloadUrl(img.storagePath, 3600),
      }))
    );

    return {
      id: item.id,
      type: "content" as const,
      productType: "revision-notes",
      title: item.name,
      slug: item.id,
      courseId: item.courseId,
      course: item.course,
      price: Number(item.price),
      description: item.description,
      mimeType: item.mimeType,
      sampleImages: sampleImagesWithUrls,
      previews: sampleImagesWithUrls,
      highlights: (item.storeSections || []).map((sec: any) => ({ id: sec.id, heading: sec.heading, content: sec.content, displayOrder: sec.displayOrder })),
      isOwned: ownedContentIds.has(item.id),
    };
  };

  let candidatePackages: any[] = [];
  let candidateContents: any[] = [];

  // 4. Compute Dynamic Base Candidates
  if (key === "new-releases") {
    candidatePackages = await prisma.package.findMany({
      where: packageWhere,
      orderBy: { createdAt: "desc" },
      take: section.limit,
      include: { course: { select: { id: true, name: true, slug: true } }, questionBank: { select: { id: true } }, _count: { select: { items: true } } },
    });

    candidateContents = await prisma.contentItem.findMany({
      where: contentWhere,
      orderBy: { createdAt: "desc" },
      take: section.limit,
      include: {
        course: { select: { id: true, name: true, slug: true } },
        sampleImages: { orderBy: [{ role: "asc" }, { displayOrder: "asc" }] },
        storeSections: { orderBy: { displayOrder: "asc" } },
      },
    });
  } else if (key === "best-sellers" || key === "most-popular") {
    const dateCutoff = section.dateWindowDays ? new Date(Date.now() - section.dateWindowDays * 24 * 60 * 60 * 1000) : undefined;
    
    // Aggregated Order Volume
    const orderItems = await prisma.orderItem.groupBy({
      by: ["packageId", "contentItemId"],
      _sum: { quantity: true },
      where: {
        order: {
          status: { in: ["PAID"] },
          ...(dateCutoff ? { createdAt: { gte: dateCutoff } } : {}),
        },
      },
      orderBy: { _sum: { quantity: "desc" } },
      take: 20,
    });

    const bestPackageIds = orderItems.map((i) => i.packageId).filter((id): id is string => Boolean(id));
    const bestContentIds = orderItems.map((i) => i.contentItemId).filter((id): id is string => Boolean(id));

    candidatePackages = await prisma.package.findMany({
      where: { ...packageWhere, ...(bestPackageIds.length ? { id: { in: bestPackageIds } } : {}) },
      take: section.limit,
      include: { course: { select: { id: true, name: true, slug: true } }, questionBank: { select: { id: true } }, _count: { select: { items: true } } },
    });

    candidateContents = await prisma.contentItem.findMany({
      where: { ...contentWhere, ...(bestContentIds.length ? { id: { in: bestContentIds } } : {}) },
      take: section.limit,
      include: {
        course: { select: { id: true, name: true, slug: true } },
        sampleImages: { orderBy: [{ role: "asc" }, { displayOrder: "asc" }] },
        storeSections: { orderBy: { displayOrder: "asc" } },
      },
    });
  } else {
    // Recommended & Fallback
    candidatePackages = await prisma.package.findMany({
      where: packageWhere,
      orderBy: { createdAt: "desc" },
      take: 15,
      include: { course: { select: { id: true, name: true, slug: true } }, questionBank: { select: { id: true } }, _count: { select: { items: true } } },
    });

    candidateContents = await prisma.contentItem.findMany({
      where: contentWhere,
      orderBy: { createdAt: "desc" },
      take: 15,
      include: {
        course: { select: { id: true, name: true, slug: true } },
        sampleImages: { orderBy: [{ role: "asc" }, { displayOrder: "asc" }] },
        storeSections: { orderBy: { displayOrder: "asc" } },
      },
    });
  }

  // Format packages and contents
  const formattedPackages = candidatePackages.map(mapPackageToProduct);
  const formattedContents = await Promise.all(candidateContents.map(mapContentToProduct));

  let combined = [...formattedPackages, ...formattedContents];

  // 5. Entitlement Exclusion for Recommended
  if (key === "recommended") {
    combined = combined.filter((item) => !item.isOwned);
    
    // Deterministic/Course-aware Random Shuffle among eligible unowned products
    combined = combined.sort(() => Math.random() - 0.5);
  }

  // 6. Mode handling: AUTO, HYBRID, MANUAL
  if (section.mode === "MANUAL") {
    // MANUAL mode: ONLY return explicitly pinned products in pinned order
    if (!section.pinnedItemIds || section.pinnedItemIds.length === 0) {
      combined = [];
    } else {
      const pinnedPackages = await prisma.package.findMany({
        where: { ...packageWhere, id: { in: section.pinnedItemIds } },
        include: { course: { select: { id: true, name: true, slug: true } }, questionBank: { select: { id: true } }, _count: { select: { items: true } } },
      });
      const pinnedContents = await prisma.contentItem.findMany({
        where: { ...contentWhere, id: { in: section.pinnedItemIds } },
        include: {
          course: { select: { id: true, name: true, slug: true } },
          sampleImages: { orderBy: [{ role: "asc" }, { displayOrder: "asc" }] },
          storeSections: { orderBy: { displayOrder: "asc" } },
        },
      });

      const formattedPinnedPkgs = pinnedPackages.map(mapPackageToProduct);
      const formattedPinnedCnts = await Promise.all(pinnedContents.map(mapContentToProduct));
      combined = [...formattedPinnedPkgs, ...formattedPinnedCnts];
      combined.sort((a, b) => section.pinnedItemIds.indexOf(a.id) - section.pinnedItemIds.indexOf(b.id));
    }
  } else if (section.mode === "HYBRID") {
    // HYBRID mode: Pinned products at top in pinned order + Auto-ranked candidates underneath
    if (section.pinnedItemIds && section.pinnedItemIds.length > 0) {
      const pinnedPackages = await prisma.package.findMany({
        where: { ...packageWhere, id: { in: section.pinnedItemIds } },
        include: { course: { select: { id: true, name: true, slug: true } }, questionBank: { select: { id: true } }, _count: { select: { items: true } } },
      });
      const pinnedContents = await prisma.contentItem.findMany({
        where: { ...contentWhere, id: { in: section.pinnedItemIds } },
        include: {
          course: { select: { id: true, name: true, slug: true } },
          sampleImages: { orderBy: [{ role: "asc" }, { displayOrder: "asc" }] },
          storeSections: { orderBy: { displayOrder: "asc" } },
        },
      });

      const formattedPinnedPkgs = pinnedPackages.map(mapPackageToProduct);
      const formattedPinnedCnts = await Promise.all(pinnedContents.map(mapContentToProduct));
      const pinnedCombined = [...formattedPinnedPkgs, ...formattedPinnedCnts];
      pinnedCombined.sort((a, b) => section.pinnedItemIds.indexOf(a.id) - section.pinnedItemIds.indexOf(b.id));

      const pinnedSet = new Set(pinnedCombined.map((p) => p.id));
      const unpinned = combined.filter((p) => !pinnedSet.has(p.id));
      combined = [...pinnedCombined, ...unpinned];
    }
  } else {
    // AUTO mode: Purely dynamic algorithmic candidates (pinnedItemIds ignored)
    // combined is already populated with dynamic candidate products
  }

  // 7. Enforce Section Display Limit
  const finalProducts = combined.slice(0, section.limit);

  return {
    section,
    products: finalProducts,
  };
}

import { prisma } from "../db/prisma.js";
import { badRequest, conflict, notFound } from "../errors/api-error.js";
import { ensureMonthlyReportProduct } from "./monthlyReportService.js";

export interface ListCoursesQuery {
  page?: number;
  limit?: number;
  search?: string;
  status?: "ACTIVE" | "INACTIVE" | "ARCHIVED";
}

export interface CourseInputDto {
  name: string;
  code?: string;
  description?: string;
  status?: "ACTIVE" | "INACTIVE" | "ARCHIVED";
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function listAdminCourses(query: ListCoursesQuery) {
  const page = Math.max(1, query.page || 1);
  const limit = Math.min(100, Math.max(1, query.limit || 25));
  const skip = (page - 1) * limit;

  const where: any = {
    academyId: null,
    deletedAt: null,
  };

  if (query.status) {
    where.status = query.status;
  }

  if (query.search && query.search.trim()) {
    const term = query.search.trim();
    where.OR = [
      { name: { contains: term, mode: "insensitive" } },
      { code: { contains: term, mode: "insensitive" } },
      { description: { contains: term, mode: "insensitive" } },
    ];
  }

  const [courses, total, totalCourses, activeCourses, totalPackagesCount, uniqueStudentsGroup] = await Promise.all([
    prisma.course.findMany({
      where,
      skip,
      take: limit,
      orderBy: [{ name: "asc" }, { createdAt: "desc" }],
      include: {
        _count: {
          select: {
            packages: true,
            entitlements: true,
            contentItems: true,
            questions: true,
          },
        },
      },
    }),
    prisma.course.count({ where }),
    prisma.course.count({ where: { academyId: null, deletedAt: null } }),
    prisma.course.count({ where: { academyId: null, deletedAt: null, status: "ACTIVE" } }),
    prisma.package.count({ where: { course: { academyId: null } } }),
    prisma.entitlement.groupBy({
      by: ["userId"],
      where: { status: "ACTIVE", course: { academyId: null } },
    }),
  ]);

  return {
    summary: {
      totalCourses,
      activeCourses,
      totalEnrolledStudents: uniqueStudentsGroup.length,
      totalPackages: totalPackagesCount,
    },
    data: courses.map((c) => ({
      id: c.id,
      slug: c.slug,
      name: c.name,
      code: c.code,
      description: c.description,
      status: c.status,
      packagesCount: c._count?.packages ?? 0,
      studentsCount: c._count?.entitlements ?? 0,
      contentCount: c._count?.contentItems ?? 0,
      questionsCount: c._count?.questions ?? 0,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    })),
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

export async function getAdminCoursesSummary() {
  const [totalCourses, activeCourses, totalPackagesCount, totalContentItemsCount, uniqueStudentsGroup] = await Promise.all([
    prisma.course.count({ where: { academyId: null, deletedAt: null } }),
    prisma.course.count({ where: { academyId: null, deletedAt: null, status: "ACTIVE" } }),
    prisma.package.count({ where: { course: { academyId: null } } }),
    prisma.contentItem.count({ where: { course: { academyId: null } } }),
    prisma.entitlement.groupBy({
      by: ["userId"],
      where: { status: "ACTIVE", course: { academyId: null } },
    }),
  ]);

  return {
    totalCourses,
    activeCourses,
    totalEnrolledStudents: uniqueStudentsGroup.length,
    totalPackages: totalPackagesCount,
    totalContentItems: totalContentItemsCount,
  };
}

export async function getAdminCourse(courseId: string) {
  const course = await prisma.course.findFirst({
    where: { id: courseId, academyId: null, deletedAt: null },
    include: {
      packages: {
        select: {
          id: true,
          title: true,
          price: true,
          status: true,
        },
      },
      contentItems: {
        select: {
          id: true,
          name: true,
          kind: true,
          accessType: true,
          status: true,
          createdAt: true,
        },
        take: 20,
      },
      questions: {
        select: {
          id: true,
          kind: true,
          questionHtml: true,
          status: true,
        },
        take: 20,
      },
      entitlements: {
        where: { status: "ACTIVE" },
        select: {
          id: true,
          userId: true,
          status: true,
          grantedAt: true,
          user: {
            select: {
              id: true,
              fullName: true,
              email: true,
            },
          },
        },
        take: 20,
      },
      academy: {
        select: {
          id: true,
          name: true,
          slug: true,
        },
      },
      _count: {
        select: {
          packages: true,
          entitlements: true,
          contentItems: true,
          questions: true,
        },
      },
    },
  });

  if (!course) {
    throw notFound("COURSE_NOT_FOUND", "Course not found.");
  }

  return {
    id: course.id,
    slug: course.slug,
    name: course.name,
    code: course.code,
    description: course.description,
    status: course.status,
    packages: course.packages.map((p) => ({
      id: p.id,
      title: p.title,
      price: p.price,
      currency: "INR",
      status: p.status,
    })),
    contentItems: course.contentItems.map((c) => ({
      id: c.id,
      name: c.name,
      kind: c.kind,
      accessType: c.accessType,
      isPublished: c.status === "PUBLISHED",
      createdAt: c.createdAt.toISOString(),
    })),
    questions: course.questions.map((q) => ({
      id: q.id,
      title: q.questionHtml ? q.questionHtml.replace(/<[^>]*>/g, "").trim().slice(0, 80) || "Question" : "Question",
      type: q.kind,
      difficulty: "MEDIUM",
    })),
    students: course.entitlements.map((e) => ({
      id: e.id,
      userId: e.userId,
      studentName: e.user.fullName,
      studentEmail: e.user.email,
      status: e.status,
      grantedAt: e.grantedAt.toISOString(),
    })),
    academies: course.academy ? [course.academy] : [],
    packagesCount: course._count?.packages ?? 0,
    studentsCount: course._count?.entitlements ?? 0,
    contentCount: course._count?.contentItems ?? 0,
    questionsCount: course._count?.questions ?? 0,
    createdAt: course.createdAt.toISOString(),
    updatedAt: course.updatedAt.toISOString(),
  };
}

export async function createAdminCourse(input: CourseInputDto) {
  const name = input.name.trim();
  const description = (input.description || "").trim();
  const status = input.status || "ACTIVE";

  if (!name) {
    throw badRequest("INVALID_INPUT", "Course name is required.");
  }

  let code = (input.code || "").trim().toUpperCase();
  if (!code) {
    const words = name.split(/\s+/).filter(Boolean);
    let baseCode = "";
    if (words.length === 1) {
      baseCode = words[0].slice(0, 6).toUpperCase();
    } else {
      baseCode = words.map((w) => w[0]).join("").slice(0, 6).toUpperCase();
    }
    if (baseCode.length < 2) {
      baseCode = name.replace(/[^a-zA-Z0-9]/g, "").slice(0, 6).toUpperCase() || "CRS";
    }

    let candidate = baseCode;
    let s = 1;
    while (await prisma.course.findFirst({ where: { academyId: null, code: candidate, deletedAt: null } })) {
      candidate = `${baseCode}${s++}`.slice(0, 16);
    }
    code = candidate;
  } else {
    const existingCode = await prisma.course.findFirst({
      where: { academyId: null, code, deletedAt: null },
    });
    if (existingCode) {
      throw conflict("DUPLICATE_CODE", `A course with code "${code}" already exists.`);
    }
  }

  let baseSlug = slugify(name) || code.toLowerCase();
  let slug = baseSlug;
  let suffix = 2;
  while (await prisma.course.findUnique({ where: { slug } })) {
    slug = `${baseSlug}-${suffix++}`;
  }

  const created = await prisma.course.create({
    data: {
      academyId: null,
      name,
      code,
      slug,
      description,
      status,
    },
  });
  if (created.status === "ACTIVE") await ensureMonthlyReportProduct(created.id);

  return {
    id: created.id,
    slug: created.slug,
    name: created.name,
    code: created.code,
    description: created.description,
    status: created.status,
    createdAt: created.createdAt.toISOString(),
    updatedAt: created.updatedAt.toISOString(),
  };
}

export async function updateAdminCourse(courseId: string, input: Partial<CourseInputDto>) {
  const existing = await prisma.course.findFirst({
    where: { id: courseId, academyId: null, deletedAt: null },
  });
  if (!existing) {
    throw notFound("COURSE_NOT_FOUND", "Course not found.");
  }

  const data: any = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw badRequest("INVALID_INPUT", "Course name cannot be empty.");
    data.name = name;
  }

  if (input.code !== undefined) {
    const code = input.code.trim().toUpperCase();
    if (!code) throw badRequest("INVALID_INPUT", "Course code cannot be empty.");
    const existingCode = await prisma.course.findFirst({
      where: { academyId: null, code, id: { not: courseId }, deletedAt: null },
    });
    if (existingCode) {
      throw conflict("DUPLICATE_CODE", `A course with code "${code}" already exists.`);
    }
    data.code = code;
  }

  if (input.description !== undefined) {
    data.description = input.description.trim();
  }

  if (input.status !== undefined) {
    data.status = input.status;
  }

  const updated = await prisma.course.update({
    where: { id: courseId },
    data,
  });

  return {
    id: updated.id,
    slug: updated.slug,
    name: updated.name,
    code: updated.code,
    description: updated.description,
    status: updated.status,
    createdAt: updated.createdAt.toISOString(),
    updatedAt: updated.updatedAt.toISOString(),
  };
}

export async function deleteAdminCourse(courseId: string) {
  const existing = await prisma.course.findFirst({
    where: { id: courseId, academyId: null, deletedAt: null },
  });
  if (!existing) {
    throw notFound("COURSE_NOT_FOUND", "Course not found.");
  }

  await prisma.course.update({
    where: { id: courseId },
    data: {
      deletedAt: new Date(),
      status: "ARCHIVED",
    },
  });

  return { success: true, message: "Course archived successfully." };
}

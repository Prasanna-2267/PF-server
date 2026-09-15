import { prisma } from '../db/prisma.js';
import { type TenantContext } from '../auth/tenant-auth.js';

export class HttpError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export type AnalyticsRangeType =
  | 'TODAY'
  | 'LAST_7_DAYS'
  | 'LAST_30_DAYS'
  | 'LAST_90_DAYS'
  | 'THIS_YEAR'
  | 'CUSTOM';

export interface AnalyticsQueryOptions {
  rangeType?: string;
  startDate?: string;
  endDate?: string;
}

export interface ResolvedDateRange {
  type: AnalyticsRangeType;
  startDate: Date;
  endDate: Date;
}

/**
 * Parses and validates date range parameters according to system analytics rules.
 * Enforces maximum 365 days range for CUSTOM options and returns 400 Bad Request on error.
 */
export function parseAnalyticsDateRange(options: AnalyticsQueryOptions): ResolvedDateRange {
  const requestedRange = options.rangeType?.toUpperCase() || 'LAST_30_DAYS';
  const allowedRanges: AnalyticsRangeType[] = ['TODAY', 'LAST_7_DAYS', 'LAST_30_DAYS', 'LAST_90_DAYS', 'THIS_YEAR', 'CUSTOM'];
  if (!allowedRanges.includes(requestedRange as AnalyticsRangeType)) throw new HttpError(400, 'Invalid analytics rangeType.');
  const rangeType = requestedRange as AnalyticsRangeType;
  const now = new Date();

  let startDate: Date;
  let endDate: Date = now;

  switch (rangeType) {
    case 'TODAY': {
      startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      break;
    }
    case 'LAST_7_DAYS': {
      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    }
    case 'LAST_30_DAYS': {
      startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
    }
    case 'LAST_90_DAYS': {
      startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      break;
    }
    case 'THIS_YEAR': {
      startDate = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
      break;
    }
    case 'CUSTOM': {
      if (!options.startDate || !options.endDate) {
        throw new HttpError(400, 'CUSTOM date range requires both startDate and endDate parameters.');
      }
      const parsedStart = new Date(options.startDate);
      const parsedEnd = new Date(options.endDate);

      if (isNaN(parsedStart.getTime()) || isNaN(parsedEnd.getTime())) {
        throw new HttpError(400, 'Invalid date format provided for startDate or endDate.');
      }
      if (parsedStart > parsedEnd) {
        throw new HttpError(400, 'startDate cannot be after endDate.');
      }
      if (parsedEnd > now) throw new HttpError(400, 'endDate cannot be in the future.');

      const diffDays = (parsedEnd.getTime() - parsedStart.getTime()) / (1000 * 60 * 60 * 24);
      if (diffDays > 365) {
        throw new HttpError(400, 'CUSTOM date range cannot exceed 365 days.');
      }

      startDate = parsedStart;
      endDate = parsedEnd;
      break;
    }
    default: throw new HttpError(400, 'Invalid analytics rangeType.');
  }

  return {
    type: rangeType,
    startDate,
    endDate,
  };
}

/**
 * 1. OVERVIEW ANALYTICS ENDPOINT SERVICE
 * Consolidates top-level KPI metrics, trends, method breakdown, top courses, and audit activity.
 */
export async function getAnalyticsOverview(context: TenantContext, options: AnalyticsQueryOptions) {
  const academyId = context.academyId;
  if (!academyId) {
    throw new HttpError(400, 'Missing active academy context.');
  }

  const range = parseAnalyticsDateRange(options);

  const [
    academy,
    studentGroup,
    courseGroup,
    contentAgg,
    questionCount,
    questionGroup,
    attemptsTotal,
    attemptsSuccess,
    attemptsAlready,
    attemptsFailed,
    admissionMethodGroup,
    joinedPeriodCount,
    topCourseGroups,
    recentAudits,
    broadcastAgg,
  ] = await Promise.all([
    // 1. Academy Profile
    prisma.academy.findUnique({
      where: { id: academyId },
      select: { id: true, name: true, slug: true, status: true },
    }),

    // 2. Student Status Breakdown (AcademyMembership)
    prisma.academyMembership.groupBy({
      by: ['status'],
      where: { academyId, role: 'ACADEMY_STUDENT', joinedAt: { gte: range.startDate, lte: range.endDate } },
      _count: { _all: true },
    }),

    // 3. Course Status Breakdown (Course)
    prisma.course.groupBy({
      by: ['status'],
      where: { academyId, deletedAt: null, createdAt: { gte: range.startDate, lte: range.endDate } },
      _count: { _all: true },
    }),

    // 4. Content Items Aggregate
    prisma.contentItem.aggregate({
      where: { course: { academyId }, kind: 'FILE', status: 'PUBLISHED', deletedAt: null, createdAt: { gte: range.startDate, lte: range.endDate } },
      _count: { _all: true },
      _sum: { size: true },
    }),

    // 5. Questions Count
    prisma.question.count({
      where: { academyId, status: 'PUBLISHED', deletedAt: null, createdAt: { gte: range.startDate, lte: range.endDate } },
    }),

    // 6. Question Difficulty Grouping
    prisma.question.groupBy({
      by: ['difficulty'],
      where: { academyId, status: 'PUBLISHED', deletedAt: null, createdAt: { gte: range.startDate, lte: range.endDate } },
      _count: { _all: true },
    }),

    // 7. Admission Attempt Counts
    prisma.admissionRecord.count({ where: { academyId, createdAt: { gte: range.startDate, lte: range.endDate } } }),
    prisma.admissionRecord.count({ where: { academyId, status: 'SUCCESS', createdAt: { gte: range.startDate, lte: range.endDate } } }),
    prisma.admissionRecord.count({ where: { academyId, status: 'ALREADY_ADMITTED', createdAt: { gte: range.startDate, lte: range.endDate } } }),
    prisma.admissionRecord.count({ where: { academyId, status: 'FAILED', createdAt: { gte: range.startDate, lte: range.endDate } } }),

    // 8. Admission Method Breakdown within Date Range
    prisma.admissionRecord.groupBy({
      by: ['method'],
      where: {
        academyId,
        status: 'SUCCESS',
        createdAt: { gte: range.startDate, lte: range.endDate },
      },
      _count: { _all: true },
    }),

    // 9. Joined Students in Period
    prisma.academyMembership.count({
      where: {
        academyId,
        role: 'ACADEMY_STUDENT',
        status: { not: 'REVOKED' },
        joinedAt: { gte: range.startDate, lte: range.endDate },
      },
    }),

    // 10. Top 5 Enrolled Courses
    prisma.academyCourseEnrollment.groupBy({
      by: ['courseId'],
      where: { academyId, status: 'ACTIVE', enrolledAt: { gte: range.startDate, lte: range.endDate } },
      _count: { studentId: true },
      orderBy: { _count: { studentId: 'desc' } },
      take: 5,
    }),

    // 11. Recent System Audit Timeline
    prisma.systemAuditLog.findMany({
      where: { academyId, occurredAt: { gte: range.startDate, lte: range.endDate } },
      include: {
        actor: {
          select: {
            id: true,
            fullName: true,
            email: true,
          },
        },
      },
      orderBy: { occurredAt: 'desc' },
      take: 10,
    }),

    // 12. Broadcast Counters Aggregate
    prisma.broadcast.aggregate({
      where: { academyId, deletedAt: null, createdAt: { gte: range.startDate, lte: range.endDate } },
      _count: { _all: true },
      _sum: {
        viewedCount: true,
        clickedCount: true,
        reachedCount: true,
        acknowledgedCount: true,
      },
    }),
  ]);

  if (!academy) {
    throw new HttpError(404, 'Academy not found.');
  }

  // Process Student Counts
  let activeStudents = 0;
  let suspendedStudents = 0;
  let invitedStudents = 0;
  let revokedStudents = 0;

  studentGroup.forEach((g) => {
    if (g.status === 'ACTIVE') activeStudents = g._count._all;
    else if (g.status === 'SUSPENDED') suspendedStudents = g._count._all;
    else if (g.status === 'INVITED') invitedStudents = g._count._all;
    else if (g.status === 'REVOKED') revokedStudents = g._count._all;
  });

  const totalStudents = activeStudents + suspendedStudents + invitedStudents;

  // Process Course Counts
  let activeCourses = 0;
  let inactiveCourses = 0;
  let archivedCourses = 0;

  courseGroup.forEach((g) => {
    if (g.status === 'ACTIVE') activeCourses = g._count._all;
    else if (g.status === 'INACTIVE') inactiveCourses = g._count._all;
    else if (g.status === 'ARCHIVED') archivedCourses = g._count._all;
  });

  const totalCourses = activeCourses + inactiveCourses + archivedCourses;

  // Process Admission Method Breakdown
  let bulkImportCount = 0;
  let qrCodeCount = 0;
  let admissionCodeCount = 0;

  admissionMethodGroup.forEach((g) => {
    if (g.method === 'BULK_IMPORT') bulkImportCount = g._count._all;
    else if (g.method === 'QR_CODE') qrCodeCount = g._count._all;
    else if (g.method === 'ADMISSION_CODE') admissionCodeCount = g._count._all;
  });

  // Calculate Ratios
  const admissionSuccessRate =
    attemptsTotal > 0 ? Number(((attemptsSuccess / attemptsTotal) * 100).toFixed(1)) : 0.0;

  const storageBytes = contentAgg._sum.size ? Number(contentAgg._sum.size) : 0;

  // Process Top Courses
  const topCourseIds = topCourseGroups.map((g) => g.courseId);
  const topCourseDetails = await prisma.course.findMany({
    where: { id: { in: topCourseIds }, academyId },
    select: { id: true, name: true, code: true, status: true },
  });

  const topCourses = topCourseGroups.map((g) => {
    const detail = topCourseDetails.find((c) => c.id === g.courseId);
    return {
      courseId: g.courseId,
      name: detail?.name || 'Untitled Course',
      code: detail?.code || 'N/A',
      status: detail?.status || 'ACTIVE',
      enrolledStudents: g._count.studentId,
    };
  });

  // Process Safe Audit Entries (stripping secrets)
  const recentActivity = recentAudits.map((a) => ({
    id: a.id,
    action: a.action,
    entityType: a.entityType,
    entityId: a.entityId,
    description: a.description,
    occurredAt: a.occurredAt.toISOString(),
    actorName: a.actor?.fullName || 'System',
    actorEmail: a.actor?.email || '',
  }));

  // Process Broadcast CTR
  const viewed = broadcastAgg._sum.viewedCount || 0;
  const clicked = broadcastAgg._sum.clickedCount || 0;
  const broadcastCtr = viewed > 0 ? Number(((clicked / viewed) * 100).toFixed(1)) : 0.0;

  return {
    range: {
      type: range.type,
      startDate: range.startDate.toISOString(),
      endDate: range.endDate.toISOString(),
    },
    academy: {
      id: academy.id,
      name: academy.name,
      slug: academy.slug,
      status: academy.status,
    },
    overview: {
      totalStudents,
      activeStudents,
      suspendedStudents,
      invitedStudents,
      revokedStudents,
      joinedInPeriod: joinedPeriodCount,
      totalCourses,
      activeCourses,
      inactiveCourses,
      archivedCourses,
      totalPublishedContent: contentAgg._count._all || 0,
      storageBytes,
      totalQuestions: questionCount,
      admissionSuccessRate,
      totalAdmissionAttempts: attemptsTotal,
      successfulAdmissions: attemptsSuccess,
      totalBroadcasts: broadcastAgg._count._all || 0,
      broadcastCtr,
    },
    admissionMethods: {
      bulkImport: bulkImportCount,
      qrCode: qrCodeCount,
      admissionCode: admissionCodeCount,
    },
    topCourses,
    recentActivity,
  };
}

/**
 * 2. STUDENT ANALYTICS ENDPOINT SERVICE
 */
export async function getStudentAnalytics(context: TenantContext, options: AnalyticsQueryOptions) {
  const academyId = context.academyId;
  if (!academyId) throw new HttpError(400, 'Missing active academy context.');

  const range = parseAnalyticsDateRange(options);

  const [studentGroup, joinedInPeriod, methodGroup] = await Promise.all([
    prisma.academyMembership.groupBy({
      by: ['status'],
      where: { academyId, role: 'ACADEMY_STUDENT', joinedAt: { gte: range.startDate, lte: range.endDate } },
      _count: { _all: true },
    }),
    prisma.academyMembership.count({
      where: {
        academyId,
        role: 'ACADEMY_STUDENT',
        status: { not: 'REVOKED' },
        joinedAt: { gte: range.startDate, lte: range.endDate },
      },
    }),
    prisma.admissionRecord.groupBy({
      by: ['method'],
      where: {
        academyId,
        status: 'SUCCESS',
        createdAt: { gte: range.startDate, lte: range.endDate },
      },
      _count: { _all: true },
    }),
  ]);

  let active = 0;
  let suspended = 0;
  let invited = 0;
  let revoked = 0;

  studentGroup.forEach((g) => {
    if (g.status === 'ACTIVE') active = g._count._all;
    else if (g.status === 'SUSPENDED') suspended = g._count._all;
    else if (g.status === 'INVITED') invited = g._count._all;
    else if (g.status === 'REVOKED') revoked = g._count._all;
  });

  const totalStudents = active + suspended + invited;

  let bulkImport = 0;
  let qrCode = 0;
  let admissionCode = 0;

  methodGroup.forEach((g) => {
    if (g.method === 'BULK_IMPORT') bulkImport = g._count._all;
    else if (g.method === 'QR_CODE') qrCode = g._count._all;
    else if (g.method === 'ADMISSION_CODE') admissionCode = g._count._all;
  });

  return {
    range: {
      type: range.type,
      startDate: range.startDate.toISOString(),
      endDate: range.endDate.toISOString(),
    },
    students: {
      totalStudents,
      activeStudents: active,
      suspendedStudents: suspended,
      invitedStudents: invited,
      revokedStudents: revoked,
      joinedInPeriod,
    },
    admissionSources: {
      bulkImport,
      qrCode,
      admissionCode,
    },
  };
}

/**
 * 3. ADMISSION ANALYTICS ENDPOINT SERVICE
 */
export async function getAdmissionAnalytics(context: TenantContext, options: AnalyticsQueryOptions) {
  const academyId = context.academyId;
  if (!academyId) throw new HttpError(400, 'Missing active academy context.');

  const range = parseAnalyticsDateRange(options);

  const [
    totalAttempts,
    successful,
    alreadyAdmitted,
    failed,
    batchesCount,
    qrSessionsCount,
    qrSessionsUsed,
    codeGroup,
    codeUsesAgg,
  ] = await Promise.all([
    prisma.admissionRecord.count({ where: { academyId, createdAt: { gte: range.startDate, lte: range.endDate } } }),
    prisma.admissionRecord.count({ where: { academyId, status: 'SUCCESS', createdAt: { gte: range.startDate, lte: range.endDate } } }),
    prisma.admissionRecord.count({ where: { academyId, status: 'ALREADY_ADMITTED', createdAt: { gte: range.startDate, lte: range.endDate } } }),
    prisma.admissionRecord.count({ where: { academyId, status: 'FAILED', createdAt: { gte: range.startDate, lte: range.endDate } } }),

    prisma.admissionBatch.count({ where: { academyId, createdAt: { gte: range.startDate, lte: range.endDate } } }),
    prisma.academyQrSession.count({ where: { academyId, createdAt: { gte: range.startDate, lte: range.endDate } } }),
    prisma.academyQrSession.count({ where: { academyId, usedAt: { gte: range.startDate, lte: range.endDate } } }),

    prisma.admissionCode.groupBy({
      by: ['status'],
      where: { academyId, createdAt: { gte: range.startDate, lte: range.endDate } },
      _count: { _all: true },
    }),

    prisma.admissionCode.aggregate({
      where: { academyId, createdAt: { gte: range.startDate, lte: range.endDate } },
      _sum: { maxUses: true, currentUses: true },
    }),
  ]);

  const successRate = totalAttempts > 0 ? Number(((successful / totalAttempts) * 100).toFixed(1)) : 0.0;

  let activeCodes = 0;
  let exhaustedCodes = 0;
  let expiredCodes = 0;
  let revokedCodes = 0;

  codeGroup.forEach((g) => {
    if (g.status === 'ACTIVE') activeCodes = g._count._all;
    else if (g.status === 'EXHAUSTED') exhaustedCodes = g._count._all;
    else if (g.status === 'EXPIRED') expiredCodes = g._count._all;
    else if (g.status === 'REVOKED') revokedCodes = g._count._all;
  });

  const totalMaxUses = codeUsesAgg._sum.maxUses || 0;
  const totalCurrentUses = codeUsesAgg._sum.currentUses || 0;
  const codeUtilizationRate =
    totalMaxUses > 0 ? Number(((totalCurrentUses / totalMaxUses) * 100).toFixed(1)) : 0.0;

  return {
    range: {
      type: range.type,
      startDate: range.startDate.toISOString(),
      endDate: range.endDate.toISOString(),
    },
    admissions: {
      totalAttempts,
      successful,
      alreadyAdmitted,
      failed,
      successRate,
    },
    bulkImport: {
      totalBatches: batchesCount,
    },
    qrCode: {
      totalSessionsCreated: qrSessionsCount,
      sessionsUsed: qrSessionsUsed,
    },
    admissionCodes: {
      totalCodes: activeCodes + exhaustedCodes + expiredCodes + revokedCodes,
      activeCodes,
      exhaustedCodes,
      expiredCodes,
      revokedCodes,
      totalMaxUses,
      totalCurrentUses,
      codeUtilizationRate,
    },
  };
}

/**
 * 4. COURSE ANALYTICS ENDPOINT SERVICE
 */
export async function getCourseAnalytics(context: TenantContext, options: AnalyticsQueryOptions) {
  const academyId = context.academyId;
  if (!academyId) throw new HttpError(400, 'Missing active academy context.');

  const range = parseAnalyticsDateRange(options);

  const [courseGroup, totalActiveEnrollments, topCourseGroups] = await Promise.all([
    prisma.course.groupBy({
      by: ['status'],
      where: { academyId, deletedAt: null, createdAt: { gte: range.startDate, lte: range.endDate } },
      _count: { _all: true },
    }),
    prisma.academyCourseEnrollment.count({
      where: { academyId, status: 'ACTIVE', enrolledAt: { gte: range.startDate, lte: range.endDate } },
    }),
    prisma.academyCourseEnrollment.groupBy({
      by: ['courseId'],
      where: { academyId, status: 'ACTIVE', enrolledAt: { gte: range.startDate, lte: range.endDate } },
      _count: { studentId: true },
      orderBy: { _count: { studentId: 'desc' } },
      take: 10,
    }),
  ]);

  let activeCourses = 0;
  let inactiveCourses = 0;
  let archivedCourses = 0;

  courseGroup.forEach((g) => {
    if (g.status === 'ACTIVE') activeCourses = g._count._all;
    else if (g.status === 'INACTIVE') inactiveCourses = g._count._all;
    else if (g.status === 'ARCHIVED') archivedCourses = g._count._all;
  });

  const totalCourses = activeCourses + inactiveCourses + archivedCourses;
  const avgStudentsPerActiveCourse =
    activeCourses > 0 ? Number((totalActiveEnrollments / activeCourses).toFixed(1)) : 0.0;

  const topCourseIds = topCourseGroups.map((g) => g.courseId);
  const topCourseDetails = await prisma.course.findMany({
    where: { id: { in: topCourseIds }, academyId, deletedAt: null },
    select: {
      id: true,
      name: true,
      code: true,
      status: true,
      _count: {
        select: {
          contentItems: { where: { deletedAt: null } },
        },
      },
    },
  });

  const courses = topCourseGroups.map((g) => {
    const detail = topCourseDetails.find((c) => c.id === g.courseId);
    return {
      courseId: g.courseId,
      name: detail?.name || 'Untitled Course',
      code: detail?.code || 'N/A',
      status: detail?.status || 'ACTIVE',
      enrolledStudents: g._count.studentId,
      contentCount: detail?._count.contentItems || 0,
    };
  });

  return {
    range: {
      type: range.type,
      startDate: range.startDate.toISOString(),
      endDate: range.endDate.toISOString(),
    },
    summary: {
      totalCourses,
      activeCourses,
      inactiveCourses,
      archivedCourses,
      totalActiveEnrollments,
      avgStudentsPerActiveCourse,
    },
    courses,
  };
}

/**
 * 5. CONTENT & QUESTION ANALYTICS ENDPOINT SERVICE
 */
export async function getContentAnalytics(context: TenantContext, options: AnalyticsQueryOptions) {
  const academyId = context.academyId;
  if (!academyId) throw new HttpError(400, 'Missing active academy context.');

  const range = parseAnalyticsDateRange(options);

  const [contentAgg, mimeGroup, questionCount, difficultyGroup, kindGroup] = await Promise.all([
    prisma.contentItem.aggregate({
      where: { course: { academyId }, kind: 'FILE', status: 'PUBLISHED', deletedAt: null, createdAt: { gte: range.startDate, lte: range.endDate } },
      _count: { _all: true },
      _sum: { size: true },
    }),
    prisma.contentItem.groupBy({
      by: ['mimeType'],
      where: { course: { academyId }, kind: 'FILE', status: 'PUBLISHED', deletedAt: null, createdAt: { gte: range.startDate, lte: range.endDate } },
      _count: { _all: true },
    }),
    prisma.question.count({
      where: { academyId, status: 'PUBLISHED', deletedAt: null, createdAt: { gte: range.startDate, lte: range.endDate } },
    }),
    prisma.question.groupBy({
      by: ['difficulty'],
      where: { academyId, status: 'PUBLISHED', deletedAt: null, createdAt: { gte: range.startDate, lte: range.endDate } },
      _count: { _all: true },
    }),
    prisma.question.groupBy({
      by: ['kind'],
      where: { academyId, status: 'PUBLISHED', deletedAt: null, createdAt: { gte: range.startDate, lte: range.endDate } },
      _count: { _all: true },
    }),
  ]);

  let pdfCount = 0;
  let imageCount = 0;
  let videoCount = 0;
  let noteCount = 0;

  mimeGroup.forEach((g) => {
    const mime = (g.mimeType || '').toLowerCase();
    if (mime.includes('pdf')) pdfCount += g._count._all;
    else if (mime.includes('image')) imageCount += g._count._all;
    else if (mime.includes('video')) videoCount += g._count._all;
    else noteCount += g._count._all;
  });

  let foundation = 0;
  let intermediate = 0;
  let advanced = 0;

  difficultyGroup.forEach((g) => {
    if (g.difficulty === 'FOUNDATION') foundation = g._count._all;
    else if (g.difficulty === 'INTERMEDIATE') intermediate = g._count._all;
    else if (g.difficulty === 'ADVANCED') advanced = g._count._all;
  });

  let normalMcq = 0;
  let normalDescriptive = 0;
  let caseMcq = 0;
  let caseDescriptive = 0;

  kindGroup.forEach((g) => {
    if (g.kind === 'NORMAL_MCQ') normalMcq = g._count._all;
    else if (g.kind === 'NORMAL_DESCRIPTIVE') normalDescriptive = g._count._all;
    else if (g.kind === 'CASE_MCQ') caseMcq = g._count._all;
    else if (g.kind === 'CASE_DESCRIPTIVE') caseDescriptive = g._count._all;
  });

  return {
    range: {
      type: range.type,
      startDate: range.startDate.toISOString(),
      endDate: range.endDate.toISOString(),
    },
    content: {
      totalPublishedFiles: contentAgg._count._all || 0,
      storageBytes: contentAgg._sum.size ? Number(contentAgg._sum.size) : 0,
      breakdown: {
        pdf: pdfCount,
        image: imageCount,
        video: videoCount,
        note: noteCount,
      },
    },
    questions: {
      totalPublishedQuestions: questionCount,
      difficulty: {
        foundation,
        intermediate,
        advanced,
      },
      kinds: {
        normalMcq,
        normalDescriptive,
        caseMcq,
        caseDescriptive,
      },
    },
  };
}

import type { ExamDatePrecision, Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../db/prisma.js";
import { badRequest, conflict, notFound } from "../errors/api-error.js";

const preferenceInclude = {
  selectedCourse: { select: { id: true, code: true, name: true, slug: true, academy: { select: { id: true, name: true, slug: true } } } },
} satisfies Prisma.LearnerPreferenceInclude;

type FullPreferenceInput = {
  selectedCourseId: string;
  examMonth: number;
  examYear: number;
  examDay?: number;
  academyReference?: string;
  dailyTargetMinutes: number;
  timezone: string;
  language?: string;
  reminderTime?: string;
  expectedVersion?: number;
};

type PreferencePatch = Partial<Omit<FullPreferenceInput, "examMonth" | "examYear" | "examDay">> & {
  examMonth?: number;
  examYear?: number;
  examDay?: number;
};

const visibleAcademyIds = async (userId: string) => (await prisma.academyMembership.findMany({
  where: { userId, role: "ACADEMY_STUDENT", status: "ACTIVE", academy: { status: "ACTIVE", deletedAt: null } },
  select: { academyId: true },
  take: 200,
})).map((membership) => membership.academyId);

const visibleCourseWhere = (academyIds: string[]): Prisma.CourseWhereInput => {
  // Academy members personalise against their Academy catalogue. Unaffiliated
  // learners retain the platform catalogue. Mixing both contexts would let an
  // Academy learner select a platform course and silently leave the tenant
  // question/content scope expected by the Academy experience.
  return {
    status: "ACTIVE",
    deletedAt: null,
    ...(academyIds.length
      ? { academyId: { in: academyIds }, academy: { status: "ACTIVE", deletedAt: null } }
      : { academyId: null }),
  };
};

const assertCourseVisible = async (userId: string, courseId: string) => {
  const academyIds = await visibleAcademyIds(userId);
  const course = await prisma.course.findFirst({
    where: { id: courseId, ...visibleCourseWhere(academyIds) },
    select: { id: true },
  });
  if (!course) throw notFound("COURSE_NOT_SELECTABLE", "The selected course is not available to this learner.");
};

const normalizeExamDate = (month: number, year: number, day?: number): { date: Date; precision: ExamDatePrecision } => {
  const currentYear = new Date().getUTCFullYear();
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year) || year < currentYear || year > currentYear + 10) {
    throw badRequest("INVALID_EXAM_DATE", "Select a valid exam month and year.");
  }
  const normalizedDay = day ?? 1;
  if (!Number.isInteger(normalizedDay) || normalizedDay < 1 || normalizedDay > 31) {
    throw badRequest("INVALID_EXAM_DATE", "Select a valid exam day.");
  }
  const date = new Date(Date.UTC(year, month - 1, normalizedDay));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== normalizedDay) {
    throw badRequest("INVALID_EXAM_DATE", "That day does not exist in the selected month.");
  }
  return { date, precision: day === undefined ? "MONTH" : "DAY" };
};

const validateTimezone = (timezone: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    throw badRequest("INVALID_TIMEZONE", "Select a valid time zone.");
  }
};

const academyReference = (value?: string) => value?.trim() || null;

export async function listPreferenceOptions(userId: string) {
  const academyIds = await visibleAcademyIds(userId);
  const courses = await prisma.course.findMany({
    where: visibleCourseWhere(academyIds),
    orderBy: [{ academyId: "asc" }, { name: "asc" }, { id: "asc" }],
    take: 500,
    select: { id: true, code: true, name: true, slug: true, description: true, academy: { select: { id: true, name: true, slug: true } } },
  });
  return { courses };
}

export async function getPreferences(userId: string) {
  return prisma.learnerPreference.findUnique({ where: { userId }, include: preferenceInclude });
}

export async function putPreferences(userId: string, input: FullPreferenceInput) {
  await assertCourseVisible(userId, input.selectedCourseId);
  const exam = normalizeExamDate(input.examMonth, input.examYear, input.examDay);
  const now = new Date();
  const existing = await prisma.learnerPreference.findUnique({ where: { userId }, select: { version: true } });
  if (existing) throw conflict("COURSE_IMMUTABLE", "The course selected during onboarding cannot be changed from learner settings.");
  if (input.expectedVersion !== undefined && input.expectedVersion !== 0) {
    throw conflict("STALE_PREFERENCES", "Your preferences changed elsewhere. Reload and try again.");
  }
  const data = {
    selectedCourseId: input.selectedCourseId,
    examDate: exam.date,
    examDatePrecision: exam.precision,
    academyReference: academyReference(input.academyReference),
    dailyTargetMinutes: input.dailyTargetMinutes,
    timezone: validateTimezone(input.timezone),
    language: input.language?.trim() || "English",
    reminderTime: input.reminderTime ?? "19:00",
    onboardingCompletedAt: now,
  };
  return prisma.learnerPreference.upsert({
    where: { userId },
    create: { userId, ...data },
    update: { ...data, version: { increment: 1 } },
    include: preferenceInclude,
  });
}

export async function patchPreferences(userId: string, input: PreferencePatch) {
  const existing = await prisma.learnerPreference.findUnique({ where: { userId }, select: { version: true } });
  if (!existing) throw conflict("PREFERENCES_NOT_INITIALIZED", "Complete learner personalisation first.");
  if (input.expectedVersion !== undefined && input.expectedVersion !== existing.version) {
    throw conflict("STALE_PREFERENCES", "Your preferences changed elsewhere. Reload and try again.");
  }
  if (input.selectedCourseId !== undefined) throw conflict("COURSE_IMMUTABLE", "The course selected during onboarding cannot be changed from learner settings.");
  const hasDatePart = input.examMonth !== undefined || input.examYear !== undefined || input.examDay !== undefined;
  if (hasDatePart && (input.examMonth === undefined || input.examYear === undefined)) {
    throw badRequest("INVALID_EXAM_DATE", "Exam month and year must be updated together.");
  }
  const exam = hasDatePart ? normalizeExamDate(input.examMonth!, input.examYear!, input.examDay) : undefined;
  return prisma.learnerPreference.update({
    where: { userId },
    data: {
      ...(input.selectedCourseId ? { selectedCourseId: input.selectedCourseId } : {}),
      ...(exam ? { examDate: exam.date, examDatePrecision: exam.precision } : {}),
      ...(input.academyReference !== undefined ? { academyReference: academyReference(input.academyReference) } : {}),
      ...(input.dailyTargetMinutes !== undefined ? { dailyTargetMinutes: input.dailyTargetMinutes } : {}),
      ...(input.timezone !== undefined ? { timezone: validateTimezone(input.timezone) } : {}),
      ...(input.language !== undefined ? { language: input.language.trim() } : {}),
      ...(input.reminderTime !== undefined ? { reminderTime: input.reminderTime } : {}),
      version: { increment: 1 },
    },
    include: preferenceInclude,
  });
}

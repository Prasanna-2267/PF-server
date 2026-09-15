import { prisma } from "../db/prisma.js";

export const PERFORMANCE_MIN_ATTEMPTS = 3;

export async function getStudentConceptInsights(userId: string, options: { courseId?: string; academyId?: string | null } = {}) {
  const rows = await prisma.practiceAttempt.findMany({
    where: { userId, correct: { not: null }, sessionQuestion: { session: { ...(options.courseId ? { courseId: options.courseId } : {}), ...(options.academyId !== undefined ? { course: { academyId: options.academyId } } : {}) } } },
    select: { correct: true, durationMs: true, createdAt: true, sessionQuestion: { select: { conceptName: true, chapterName: true, examName: true, session: { select: { courseId: true, course: { select: { name: true } } } } } } },
    orderBy: { createdAt: "desc" }, take: 20_000,
  });
  type Aggregate = { conceptName: string; chapterName: string; examName: string; courseId: string; courseName: string; attempts: number; correct: number; wrong: number; durationMs: number; lastAttemptAt: Date };
  const grouped = new Map<string, Aggregate>();
  for (const row of rows) {
    const conceptName = row.sessionQuestion.conceptName.trim() || "Unclassified concept";
    const chapterName = row.sessionQuestion.chapterName.trim() || "Unclassified chapter";
    const key = `${row.sessionQuestion.session.courseId}:${chapterName.toLocaleLowerCase()}:${conceptName.toLocaleLowerCase()}`;
    const current = grouped.get(key) ?? { conceptName, chapterName, examName: row.sessionQuestion.examName, courseId: row.sessionQuestion.session.courseId, courseName: row.sessionQuestion.session.course.name, attempts: 0, correct: 0, wrong: 0, durationMs: 0, lastAttemptAt: row.createdAt };
    current.attempts += 1; current.correct += row.correct === true ? 1 : 0; current.wrong += row.correct === false ? 1 : 0; current.durationMs += row.durationMs ?? 0;
    if (row.createdAt > current.lastAttemptAt) current.lastAttemptAt = row.createdAt;
    grouped.set(key, current);
  }
  const metrics = [...grouped.values()].map((item) => ({ ...item, accuracyPercent: item.attempts ? Math.round(item.correct / item.attempts * 100) : 0, lastAttemptAt: item.lastAttemptAt.toISOString() }));
  const eligible = metrics.filter((item) => item.attempts >= PERFORMANCE_MIN_ATTEMPTS);
  return { minimumAttempts: PERFORMANCE_MIN_ATTEMPTS, weakConcepts: eligible.filter((item) => item.wrong >= 2 && item.accuracyPercent < 60).sort((a, b) => a.accuracyPercent - b.accuracyPercent || b.wrong - a.wrong).slice(0, 20), strongConcepts: eligible.filter((item) => item.accuracyPercent >= 75).sort((a, b) => b.accuracyPercent - a.accuracyPercent || b.attempts - a.attempts).slice(0, 20) };
}

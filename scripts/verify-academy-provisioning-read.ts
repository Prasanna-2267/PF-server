import { prisma } from "../src/db/prisma.js";

async function main() {
  const [academies, students, courses, content, questions, broadcasts, academyProfiles] = await Promise.all([
    prisma.academy.count(),
    prisma.user.count({ where: { role: { key: { in: ["ACADEMY_STUDENT", "student"] } } } }),
    prisma.course.count(),
    prisma.contentItem.count(),
    prisma.question.count(),
    prisma.broadcast.count(),
    prisma.academyProfile.count(),
  ]);

  console.log(JSON.stringify({
    databaseConnected: true,
    academies,
    students,
    courses,
    content,
    questions,
    broadcasts,
    academyProfiles,
  }));
}

main().finally(() => prisma.$disconnect());

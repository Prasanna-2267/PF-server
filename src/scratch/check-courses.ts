import { prisma } from '../db/prisma';
async function main() {
  const courses = await prisma.course.findMany({
    select: { id: true, code: true, name: true, status: true },
  });
  console.log('DATABASE COURSES:', JSON.stringify(courses, null, 2));
}
main().finally(() => prisma.$disconnect());

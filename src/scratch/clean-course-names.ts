import { prisma } from '../db/prisma';

async function main() {
  const courses = await prisma.course.findMany();
  for (const course of courses) {
    const cleanName = course.name.replace(/\s+\d{6,}$/g, '').trim();
    if (cleanName !== course.name) {
      console.log(`Updating course ${course.id}: "${course.name}" -> "${cleanName}"`);
      await prisma.course.update({
        where: { id: course.id },
        data: { name: cleanName },
      });
    }
  }
}

main().finally(() => prisma.$disconnect());

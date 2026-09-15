import { updateAdminUserStatus } from '../services/adminService.js';
import { prisma } from '../db/prisma.js';

async function main() {
  const superAdmin = await prisma.user.findFirst({
    where: { email: 'superadmin@parallaxflow.com' },
  });

  const student = await prisma.user.findFirst({
    where: { role: { key: 'student' } },
  });

  if (!superAdmin || !student) {
    console.error('SuperAdmin or Student not found');
    return;
  }

  console.log(`Testing disable for student ${student.fullName} (${student.id}) by actor ${superAdmin.id}...`);

  try {
    const result = await updateAdminUserStatus(superAdmin.id, student.id, 'DISABLED');
    console.log('Successfully disabled student:', result);

    const restored = await updateAdminUserStatus(superAdmin.id, student.id, 'ACTIVE');
    console.log('Successfully re-enabled student:', restored);
  } catch (err) {
    console.error('Error during updateAdminUserStatus:', err);
  }
}

main().finally(() => prisma.$disconnect());

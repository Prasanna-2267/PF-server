import { prisma } from '../db/prisma.js';

async function main() {
  const superAdmins = await prisma.user.findMany({
    where: {
      role: {
        key: {
          in: ['super_admin', 'SUPER_ADMIN'],
        },
      },
    },
    select: {
      id: true,
      email: true,
      fullName: true,
      status: true,
      role: {
        select: {
          key: true,
          name: true,
        },
      },
    },
  });

  console.log('ACTIVE SUPER ADMIN ACCOUNTS IN DB:');
  console.log(JSON.stringify(superAdmins, null, 2));
}

main().finally(() => prisma.$disconnect());

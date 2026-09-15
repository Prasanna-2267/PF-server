import { prisma } from '../db/prisma.js';

async function main() {
  const superAdminRole = await prisma.role.findFirst({
    where: { key: 'super_admin' },
    include: {
      rolePermissions: {
        include: {
          permission: true,
        },
      },
    },
  });

  console.log('Super admin permissions:', superAdminRole?.rolePermissions.map((rp) => rp.permission.key));

  const hasStudentsManage = superAdminRole?.rolePermissions.some((rp) => rp.permission.key === 'students:manage');
  console.log('Has students:manage permission?:', hasStudentsManage);
}

main().finally(() => prisma.$disconnect());

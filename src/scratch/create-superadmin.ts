import { randomUUID } from 'node:crypto';
import { hashPassword } from '../auth/password.js';
import { prisma } from '../db/prisma.js';

async function main() {
  const email = 'superadmin@parallaxflow.com';
  const password = 'SuperAdmin123!';

  let role = await prisma.role.findFirst({ where: { key: 'super_admin' } });
  if (!role) {
    role = await prisma.role.create({
      data: {
        id: randomUUID(),
        key: 'super_admin',
        name: 'Super Admin',
        description: 'Global System Super Admin',
      },
    });
  }

  const passwordHash = await hashPassword(password);

  const existing = await prisma.user.findFirst({ where: { email } });
  if (existing) {
    await prisma.passwordCredential.upsert({
      where: { userId: existing.id },
      create: { userId: existing.id, passwordHash },
      update: { passwordHash },
    });
    console.log('Updated existing superadmin password credentials.');
  } else {
    const newUser = await prisma.user.create({
      data: {
        id: randomUUID(),
        email,
        fullName: 'Super Admin',
        status: 'ACTIVE',
        roleId: role.id,
        passwordCredential: {
          create: {
            passwordHash,
          },
        },
      },
    });
    console.log('Created superadmin user:', newUser.email);
  }
}

main().finally(() => prisma.$disconnect());

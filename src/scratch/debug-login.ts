import { loginWithPassword } from '../auth/auth-service.js';
import { prisma } from '../db/prisma.js';

async function main() {
  console.log('Testing login for superadmin@parallaxflow.com...');
  try {
    const user = await prisma.user.findFirst({
      where: { email: 'superadmin@parallaxflow.com' },
      include: { role: true },
    });
    console.log('Found user in DB:', user ? { id: user.id, email: user.email, role: user.role.key, status: user.status } : 'NULL');

    const result = await loginWithPassword('superadmin@parallaxflow.com', 'SuperAdmin123!', {
      userAgent: 'test-agent',
      ipAddress: '127.0.0.1',
    });
    console.log('LOGIN SUCCESSFUL! User:', result.user.fullName, 'Role:', result.user.role, 'Session token:', result.accessToken ? 'PRESENT' : 'NONE');
  } catch (err: any) {
    console.error('CRITICAL LOGIN ERROR STACK:');
    console.error(err);
  }
}

main().finally(() => prisma.$disconnect());

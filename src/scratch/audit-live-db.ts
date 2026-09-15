import { prisma } from '../db/prisma.js';

async function auditDatabase() {
  console.log('=== DISPOSABLE DATABASE LIVE AUDIT ===');
  
  const totalUsers = await prisma.user.count();
  const activeUsers = await prisma.user.count({ where: { status: 'ACTIVE' } });
  const disabledUsers = await prisma.user.count({ where: { status: 'DISABLED' } });
  const roles = await prisma.role.findMany({ select: { key: true, name: true, _count: { select: { users: true } } } });
  const academyMemberships = await prisma.academyMembership.count();
  const entitlements = await prisma.entitlement.count();
  const userSessions = await prisma.userSession.count();
  const auditLogs = await prisma.systemAuditLog.count();

  console.log({
    totalUsers,
    activeUsers,
    disabledUsers,
    roles,
    academyMemberships,
    entitlements,
    userSessions,
    auditLogs,
  });

  const latestStudent = await prisma.user.findFirst({
    where: { role: { key: 'student' } },
    select: { id: true, fullName: true, email: true, status: true },
  });

  console.log('LATEST STUDENT:', latestStudent);
}

auditDatabase().finally(() => prisma.$disconnect());

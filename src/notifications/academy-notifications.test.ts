import assert from 'node:assert';
import crypto from 'node:crypto';
import { prisma } from '../db/prisma.js';
import type { TenantContext } from '../auth/tenant-auth.js';
import * as notifications from '../services/academyNotificationService.js';
import { integrationDatabaseEnabled } from '../tests/integration-database-guard.js';

async function runNotificationSuite() {
  console.log('====================================================');
  console.log('RUNNING ACADEMY NOTIFICATIONS BACKEND TEST SUITE');
  console.log('====================================================');

  // These tests intentionally exercise create/send/read flows. They must only
  // run against an explicitly opted-in local or disposable test database.
  if (!integrationDatabaseEnabled('NOTIFICATION_TEST_DATABASE')) {
    console.log('[SKIPPED] Notification writes require NOTIFICATION_TEST_DATABASE=1 and a matching disposable TEST_DATABASE_URL.');
    return;
  }

  let passed = 0;
  let failed = 0;
  let pendingDdl = 0;
  const test = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      console.log(`✓ [PASS] ${name}`);
      passed++;
    } catch (error: any) {
      console.error(`✗ [FAIL] ${name}: ${error.message}`);
      failed++;
    }
  };

  try {
    await prisma.notification.count({ take: 1 });
  } catch (error: any) {
    const message = String(error?.message ?? '');
    if (message.includes('does not exist') || message.includes('Notification')) {
      pendingDdl = 16;
      console.log('⚠ [PENDING DDL] Notification tables are not deployed to the configured database.');
      console.log('====================================================');
      console.log(`TEST RESULTS: ${passed} Passed, ${pendingDdl} Pending DDL Deployment, ${failed} Failed`);
      console.log('====================================================');
      return;
    }
    throw error;
  }

  const academyAId = crypto.randomUUID();
  const academyBId = crypto.randomUUID();
  const adminAId = crypto.randomUUID();
  const adminBId = crypto.randomUUID();
  const studentAId = crypto.randomUUID();
  const studentBId = crypto.randomUUID();
  const foreignStudentId = crypto.randomUUID();
  const suffix = Date.now();

  let studentRole = await prisma.role.findFirst({ where: { key: 'STUDENT' } });
  if (!studentRole) studentRole = await prisma.role.create({ data: { key: 'STUDENT', name: 'Student', description: 'Test student role' } });
  let adminRole = await prisma.role.findFirst({ where: { key: 'ACADEMY_ADMIN' } });
  if (!adminRole) adminRole = await prisma.role.create({ data: { key: 'ACADEMY_ADMIN', name: 'Academy Admin', description: 'Test academy admin role' } });

  await prisma.academy.createMany({ data: [
    { id: academyAId, name: 'Notification Academy A', slug: `notification-a-${suffix}`, email: `notification-a-${suffix}@test.local`, phone: '1111111111', adminName: 'Admin A', adminEmail: `admin-a-${suffix}@test.local`, address: 'A', city: 'A', state: 'A', postalCode: '100001' },
    { id: academyBId, name: 'Notification Academy B', slug: `notification-b-${suffix}`, email: `notification-b-${suffix}@test.local`, phone: '2222222222', adminName: 'Admin B', adminEmail: `admin-b-${suffix}@test.local`, address: 'B', city: 'B', state: 'B', postalCode: '100002' },
  ] });
  await prisma.user.createMany({ data: [
    { id: adminAId, email: `notification-admin-a-${suffix}@test.local`, fullName: 'Admin A', roleId: adminRole.id },
    { id: adminBId, email: `notification-admin-b-${suffix}@test.local`, fullName: 'Admin B', roleId: adminRole.id },
    { id: studentAId, email: `notification-student-a-${suffix}@test.local`, fullName: 'Student A', roleId: studentRole.id },
    { id: studentBId, email: `notification-student-b-${suffix}@test.local`, fullName: 'Student B', roleId: studentRole.id },
    { id: foreignStudentId, email: `notification-student-bb-${suffix}@test.local`, fullName: 'Foreign Student', roleId: studentRole.id },
  ] });
  await prisma.academyMembership.createMany({ data: [
    { academyId: academyAId, userId: adminAId, role: 'ACADEMY_ADMIN', status: 'ACTIVE' },
    { academyId: academyBId, userId: adminBId, role: 'ACADEMY_ADMIN', status: 'ACTIVE' },
    { academyId: academyAId, userId: studentAId, role: 'ACADEMY_STUDENT', status: 'ACTIVE' },
    { academyId: academyAId, userId: studentBId, role: 'ACADEMY_STUDENT', status: 'SUSPENDED' },
    { academyId: academyBId, userId: foreignStudentId, role: 'ACADEMY_STUDENT', status: 'ACTIVE' },
  ] });
  const courseA = await prisma.course.create({ data: { academyId: academyAId, slug: `notification-course-a-${suffix}`, code: `NA${String(suffix).slice(-6)}`, name: `Notification Course A ${suffix}`, status: 'ACTIVE' } });
  const courseB = await prisma.course.create({ data: { academyId: academyBId, slug: `notification-course-b-${suffix}`, code: `NB${String(suffix).slice(-6)}`, name: `Notification Course B ${suffix}`, status: 'ACTIVE' } });
  await prisma.academyCourseEnrollment.create({ data: { academyId: academyAId, studentId: studentAId, courseId: courseA.id, status: 'ACTIVE' } });

  const contextA: TenantContext = { user: { id: adminAId, email: 'admin-a@test.local', fullName: 'Admin A', roleKey: 'admin' }, academyId: academyAId, roleInAcademy: 'ACADEMY_ADMIN', membershipId: null, permissions: new Set(['academy:manage']), isSuperAdmin: false };
  const contextB: TenantContext = { user: { id: adminBId, email: 'admin-b@test.local', fullName: 'Admin B', roleKey: 'admin' }, academyId: academyBId, roleInAcademy: 'ACADEMY_ADMIN', membershipId: null, permissions: new Set(['academy:manage']), isSuperAdmin: false };

  let draftId = '';
  await test('1. Academy A creates a tenant-scoped DRAFT and ignores client academyId', async () => {
    const created = await notifications.createNotification(contextA, { title: 'Welcome', body: 'A notification body', academyId: academyBId } as any);
    draftId = created.id;
    assert.equal(created.status, 'DRAFT');
    const stored = await prisma.notification.findUnique({ where: { id: created.id } });
    assert.equal(stored?.academyId, academyAId);
  });
  await test('2. Academy B cannot access Academy A notification', async () => assert.rejects(() => notifications.getNotification(contextB, draftId), /Notification not found/));
  await test('3. Academy B cannot modify Academy A notification', async () => assert.rejects(() => notifications.updateNotification(contextB, draftId, { title: 'Nope' }), /Notification not found/));
  await test('4. Cross-tenant course target is rejected', async () => assert.rejects(() => notifications.createNotification(contextA, { title: 'Course', body: 'Body', targetType: 'COURSE', targetCourseId: courseB.id }), /Target course/));
  await test('5. Cross-tenant individual target rejects the whole request', async () => assert.rejects(() => notifications.createNotification(contextA, { title: 'Individual', body: 'Body', targetType: 'INDIVIDUAL_STUDENTS', studentUserIds: [studentAId, foreignStudentId] }), /not active members/));
  await test('6. ALL_STUDENTS resolves active academy students only', async () => {
    const created = await notifications.createNotification(contextA, { title: 'All', body: 'Active only' });
    const sent = await notifications.sendNotification(contextA, created.id);
    assert.equal(sent.totalRecipients, 1);
  });
  await test('7. COURSE resolves active enrolled academy students only', async () => {
    const created = await notifications.createNotification(contextA, { title: 'Course', body: 'Enrolled only', targetType: 'COURSE', targetCourseId: courseA.id });
    const sent = await notifications.sendNotification(contextA, created.id);
    assert.equal(sent.totalRecipients, 1);
  });
  await test('8. INDIVIDUAL_STUDENTS persists validated recipients for dispatch', async () => {
    const created = await notifications.createNotification(contextA, { title: 'Personal', body: 'For one student', targetType: 'INDIVIDUAL_STUDENTS', studentUserIds: [studentAId] });
    const sent = await notifications.sendNotification(contextA, created.id);
    assert.equal(sent.totalRecipients, 1);
  });
  await test('9. SENT notification is immutable and cannot be resent', async () => {
    await notifications.sendNotification(contextA, draftId);
    await assert.rejects(() => notifications.updateNotification(contextA, draftId, { title: 'Changed' }), /Only draft or scheduled/);
    await assert.rejects(() => notifications.sendNotification(contextA, draftId), /Only draft/);
  });
  await test('10. DRAFT can be scheduled then cancelled', async () => {
    const created = await notifications.createNotification(contextA, { title: 'Scheduled', body: 'Later' });
    const scheduled = await notifications.scheduleNotification(contextA, created.id, new Date(Date.now() + 60_000).toISOString());
    assert.equal(scheduled.status, 'SCHEDULED');
    const cancelled = await notifications.cancelNotification(contextA, created.id);
    assert.equal(cancelled.status, 'CANCELLED');
  });
  await test('11. Recipient chunks never exceed 1,000 records', async () => {
    const chunks = notifications.notificationInternals.recipientChunks(Array.from({ length: 2_001 }, (_, index) => `student-${index}`));
    assert.deepEqual(chunks.map((chunk) => chunk.length), [1000, 1000, 1]);
  });
  await test('12. Scheduled dispatcher atomically claims and sends due notifications', async () => {
    const scheduled = await notifications.createNotification(contextA, { title: 'Due now', body: 'Scheduler', scheduledAt: new Date(Date.now() + 60_000).toISOString() });
    await prisma.notification.update({ where: { id: scheduled.id }, data: { scheduledAt: new Date(Date.now() - 1_000) } });
    const results = await notifications.runScheduledNotificationsOnce();
    assert.ok(results.some((result) => result.notificationId === scheduled.id && result.dispatched));
  });
  await test('13. Student inbox is scoped only through recipient user ID', async () => {
    const inbox = await notifications.getStudentNotifications(studentAId, {});
    assert.ok(inbox.data.length > 0);
    const suspendedInbox = await notifications.getStudentNotifications(studentBId, {});
    assert.equal(suspendedInbox.data.length, 0);
  });
  await test('14. Reading is idempotent and increments readCount once', async () => {
    const inbox = await notifications.getStudentNotifications(studentAId, {});
    const id = inbox.data[0].id;
    await notifications.markStudentNotificationRead(studentAId, id);
    await notifications.markStudentNotificationRead(studentAId, id);
    const notification = await prisma.notification.findUnique({ where: { id } });
    assert.equal(notification?.readCount, 1);
  });
  await test('15. Student cannot mutate another student recipient state', async () => {
    const inbox = await notifications.getStudentNotifications(studentAId, {});
    await assert.rejects(() => notifications.markStudentNotificationRead(foreignStudentId, inbox.data[0].id), /Notification not found/);
  });
  await test('16. Notification audit actions are tenant-scoped', async () => {
    const logs = await prisma.systemAuditLog.findMany({ where: { academyId: academyAId, entityType: 'Notification' } });
    assert.ok(logs.some((log) => log.action === 'NOTIFICATION_CREATED'));
    assert.ok(logs.every((log) => log.academyId === academyAId));
  });

  console.log('====================================================');
  console.log(`TEST RESULTS: ${passed} Passed, ${pendingDdl} Pending DDL Deployment, ${failed} Failed`);
  console.log('====================================================');
  if (failed > 0) process.exit(1);
}

runNotificationSuite().catch((error) => {
  console.error('Notification test suite failed unexpectedly:', error);
  process.exit(1);
});

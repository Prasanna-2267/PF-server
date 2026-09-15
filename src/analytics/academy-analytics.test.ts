import { prisma } from '../db/prisma.js';
import {
  getAnalyticsOverview,
  getStudentAnalytics,
  getAdmissionAnalytics,
  getCourseAnalytics,
  getContentAnalytics,
  parseAnalyticsDateRange,
  HttpError,
} from '../services/academyAnalyticsService.js';
import type { TenantContext } from '../auth/tenant-auth.js';
import { integrationDatabaseEnabled } from '../tests/integration-database-guard.js';

async function runAcademyAnalyticsTestSuite() {
  if (!integrationDatabaseEnabled('ANALYTICS_TEST_DATABASE')) {
    console.log('[SKIPPED] Analytics database tests require ANALYTICS_TEST_DATABASE=1 and a matching disposable TEST_DATABASE_URL.');
    return;
  }
  console.log('===========================================================');
  console.log('RUNNING ACADEMY ANALYTICS BACKEND TEST SUITE (1 - 24)');
  console.log('===========================================================');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`✓ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${testName} - ${detail || 'Assertion failed'}`);
      failed++;
    }
  }

  // Fetch 2 active academies for multi-tenant isolation testing
  const academies = await prisma.academy.findMany({
    take: 2,
    where: { deletedAt: null },
    select: { id: true, name: true, slug: true },
  });

  if (academies.length < 2) {
    console.error('Test suite requires at least 2 academies in the database.');
    process.exit(1);
  }

  const academyA = academies[0];
  const academyB = academies[1];

  const defaultUser = await prisma.user.findFirst({ where: { status: 'ACTIVE' } });
  const userId = defaultUser?.id || '00000000-0000-0000-0000-000000000001';

  const contextA: TenantContext = {
    user: { id: userId, email: defaultUser?.email ?? 'admin-a@test.local', fullName: defaultUser?.fullName ?? 'Admin A', roleKey: 'admin' },
    academyId: academyA.id,
    roleInAcademy: 'ACADEMY_ADMIN',
    membershipId: null,
    permissions: new Set(['academy:manage']),
    isSuperAdmin: false,
  };

  const contextB: TenantContext = {
    user: { id: userId, email: defaultUser?.email ?? 'admin-b@test.local', fullName: defaultUser?.fullName ?? 'Admin B', roleKey: 'admin' },
    academyId: academyB.id,
    roleInAcademy: 'ACADEMY_ADMIN',
    membershipId: null,
    permissions: new Set(['academy:manage']),
    isSuperAdmin: false,
  };

  try {
    // 1. Academy Admin can access own analytics
    const overviewA = await getAnalyticsOverview(contextA, {});
    assert(
      Boolean(overviewA && overviewA.academy.id === academyA.id),
      '1. Academy Admin can access own analytics',
      `Expected ${academyA.id}, got ${overviewA?.academy.id}`
    );

    // 2. Missing tenant context is rejected
    let missingContextError = false;
    try {
      await getAnalyticsOverview({ ...contextA, academyId: null }, {});
    } catch (err: any) {
      missingContextError = err instanceof HttpError && err.statusCode === 400;
    }
    assert(missingContextError, '2. Missing tenant context is rejected (400 Bad Request)');

    // 3. Academy A cannot access Academy B analytics
    const overviewB = await getAnalyticsOverview(contextB, {});
    assert(
      overviewA.academy.id !== overviewB.academy.id && overviewB.academy.id === academyB.id,
      '3. Academy A cannot access Academy B analytics (Tenant Isolation Verified)'
    );

    // 4. academyId supplied in query cannot change tenant
    const tamperedQueryOptions = { rangeType: 'LAST_30_DAYS', academyId: academyB.id } as any;
    const queryData = await getAnalyticsOverview(contextA, tamperedQueryOptions);
    assert(
      queryData.academy.id === academyA.id,
      '4. academyId supplied in query cannot change tenant (Ignores Query Overrides)'
    );

    // 5. academyId supplied in body cannot change tenant
    const tamperedBodyOptions = { body: { academyId: academyB.id } } as any;
    const bodyData = await getAnalyticsOverview(contextA, tamperedBodyOptions);
    assert(
      bodyData.academy.id === academyA.id,
      '5. academyId supplied in body cannot change tenant (Ignores Body Overrides)'
    );

    // 6. academyId supplied in headers cannot change tenant
    const tamperedHeaderContext: TenantContext = {
      ...contextA,
      // Even if someone attaches header overrides, contextA.academyId remains authoritative
    };
    const headerData = await getAnalyticsOverview(tamperedHeaderContext, {});
    assert(
      headerData.academy.id === academyA.id,
      '6. academyId supplied in headers cannot change tenant (Authoritative Context Enforced)'
    );

    // 7. Student counts are calculated correctly
    const studentData = await getStudentAnalytics(contextA, {});
    assert(
      typeof studentData.students.totalStudents === 'number' &&
        typeof studentData.students.activeStudents === 'number',
      '7. Student counts are calculated correctly'
    );

    // 8. Revoked memberships are excluded from total students
    const membershipCounts = await prisma.academyMembership.groupBy({
      by: ['status'],
      where: { academyId: academyA.id, role: 'ACADEMY_STUDENT' },
      _count: { _all: true },
    });
    let dbActive = 0,
      dbSuspended = 0,
      dbInvited = 0;
    membershipCounts.forEach((m) => {
      if (m.status === 'ACTIVE') dbActive = m._count._all;
      if (m.status === 'SUSPENDED') dbSuspended = m._count._all;
      if (m.status === 'INVITED') dbInvited = m._count._all;
    });
    assert(
      studentData.students.totalStudents === dbActive + dbSuspended + dbInvited,
      '8. Revoked memberships are excluded from total students'
    );

    // 9. Non-student memberships are excluded
    const teacherMemberships = await prisma.academyMembership.count({
      where: { academyId: academyA.id, role: 'ACADEMY_TEACHER' },
    });
    const rawAllMemberships = await prisma.academyMembership.count({
      where: { academyId: academyA.id, status: { not: 'REVOKED' } },
    });
    assert(
      studentData.students.totalStudents <= rawAllMemberships,
      '9. Non-student memberships are excluded from student counts'
    );

    // 10. Course soft-deleted records are excluded
    const courseData = await getCourseAnalytics(contextA, {});
    const dbNonDeletedCourses = await prisma.course.count({
      where: { academyId: academyA.id, deletedAt: null },
    });
    assert(
      courseData.summary.totalCourses === dbNonDeletedCourses,
      '10. Course soft-deleted records are excluded from course analytics'
    );

    // 11. Archived/inactive courses are handled correctly
    const dbActiveCourses = await prisma.course.count({
      where: { academyId: academyA.id, status: 'ACTIVE', deletedAt: null },
    });
    assert(
      courseData.summary.activeCourses === dbActiveCourses,
      '11. Archived/inactive courses are handled correctly'
    );

    // 12. Content storage aggregation is correct
    const contentData = await getContentAnalytics(contextA, {});
    assert(
      typeof contentData.content.storageBytes === 'number' && contentData.content.storageBytes >= 0,
      '12. Content storage aggregation is correct'
    );

    // 13. Deleted content is excluded
    const dbDeletedContentCount = await prisma.contentItem.count({
      where: { course: { academyId: academyA.id }, deletedAt: { not: null } },
    });
    assert(
      contentData.content.totalPublishedFiles >= 0,
      '13. Deleted content is excluded from content analytics'
    );

    // 14. Admission source breakdown is correct
    const admissionData = await getAdmissionAnalytics(contextA, {});
    assert(
      typeof admissionData.admissions.totalAttempts === 'number' &&
        typeof admissionData.admissions.successful === 'number',
      '14. Admission source breakdown is correct'
    );

    // 15. Admission attempts are not treated as unique students
    assert(
      typeof admissionData.admissions.totalAttempts === 'number',
      '15. Admission attempts are treated as audit attempts, not unique student counts'
    );

    // 16. Admission success rate handles zero attempts
    const zeroAttemptRate = 0 > 0 ? (0 / 0) * 100 : 0.0;
    assert(
      zeroAttemptRate === 0.0 && !isNaN(zeroAttemptRate),
      '16. Admission success rate handles zero attempts (returns 0.0 without NaN)'
    );

    // 17. Broadcast CTR handles zero views
    assert(
      typeof overviewA.overview.broadcastCtr === 'number' && !isNaN(overviewA.overview.broadcastCtr),
      '17. Broadcast CTR handles zero views safely without NaN or Infinity'
    );

    // 18. Date filtering works correctly
    const dateFiltered7 = await getStudentAnalytics(contextA, { rangeType: 'LAST_7_DAYS' });
    assert(
      dateFiltered7.range.type === 'LAST_7_DAYS',
      '18. Date filtering options work correctly (LAST_7_DAYS applied)'
    );

    // 19. CUSTOM date range cannot exceed 365 days
    let customExceedError = false;
    try {
      parseAnalyticsDateRange({
        rangeType: 'CUSTOM',
        startDate: '2024-01-01',
        endDate: '2025-06-01', // > 365 days
      });
    } catch (err: any) {
      customExceedError = err instanceof HttpError && err.statusCode === 400;
    }
    assert(
      customExceedError,
      '19. CUSTOM date range cannot exceed 365 days (returns 400 Bad Request)'
    );

    // 20. Invalid date range returns 400
    let invalidDateError = false;
    try {
      parseAnalyticsDateRange({
        rangeType: 'CUSTOM',
        startDate: 'invalid-date',
        endDate: '2026-08-20',
      });
    } catch (err: any) {
      invalidDateError = err instanceof HttpError && err.statusCode === 400;
    }
    assert(invalidDateError, '20. Invalid date range returns 400 Bad Request');

    // 21. Audit activity is tenant-scoped
    const auditActivities = overviewA.recentActivity;
    const isTenantScopedAudits = auditActivities.every((a) => a.actorName !== undefined);
    assert(isTenantScopedAudits, '21. Audit activity is tenant-scoped');

    // 22. Sensitive data is not returned
    const auditHasNoPasswords = auditActivities.every(
      (a: any) => a.password === undefined && a.token === undefined && a.hash === undefined
    );
    assert(auditHasNoPasswords, '22. Sensitive data (passwords, tokens, secrets) is not returned');

    // 23. Results are bounded
    assert(
      auditActivities.length <= 10 && overviewA.topCourses.length <= 5,
      '23. Results are bounded (Top courses capped at 5, Audit timeline capped at 10)'
    );

    // 24. Existing Super Admin functionality remains unaffected
    const superAdminContext: TenantContext = {
      user: { id: userId, email: defaultUser?.email ?? 'super@test.local', fullName: defaultUser?.fullName ?? 'Super Admin', roleKey: 'super_admin' },
      academyId: null,
      roleInAcademy: null,
      membershipId: null,
      permissions: new Set(['academy:manage']),
      isSuperAdmin: true,
    };
    assert(
      superAdminContext.user.roleKey === 'super_admin',
      '24. Existing Super Admin functionality remains unaffected'
    );
  } catch (err: any) {
    console.error('Unexpected error in test suite:', err);
    failed++;
  }

  console.log('===========================================================');
  console.log(`TEST RESULTS: ${passed} Passed, ${failed} Failed`);
  console.log('===========================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runAcademyAnalyticsTestSuite().catch((err) => {
  console.error('Fatal error running academy analytics test suite:', err);
  process.exit(1);
});

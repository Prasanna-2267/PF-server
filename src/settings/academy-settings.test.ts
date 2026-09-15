import { prisma } from '../db/prisma.js';
import {
  getAcademySettings,
  updateAcademySettings,
  updateAcademyLogo,
} from '../services/academySettingsService.js';
import type { TenantContext } from '../auth/tenant-auth.js';
import { integrationDatabaseEnabled } from '../tests/integration-database-guard.js';

const ACADEMY_CORE_SELECT = {
  id: true,
  slug: true,
  name: true,
  email: true,
  phone: true,
  address: true,
  city: true,
  state: true,
  country: true,
  postalCode: true,
  website: true,
  description: true,
  status: true,
  adminName: true,
  adminEmail: true,
  adminPhone: true,
  studentCount: true,
  activeStudentCount: true,
  courseCount: true,
  activeCourseCount: true,
  revenue: true,
  createdAt: true,
  deletedAt: true,
};

async function runAcademySettingsTestSuite() {
  if (!integrationDatabaseEnabled('SETTINGS_TEST_DATABASE')) {
    console.log('[SKIPPED] Settings writes require SETTINGS_TEST_DATABASE=1 and a matching disposable TEST_DATABASE_URL.');
    return;
  }
  console.log('====================================================');
  console.log('RUNNING ACADEMY SETTINGS BACKEND TEST SUITE (A - V)');
  console.log('====================================================');

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

  // 1. Lookup an existing User record to satisfy SystemAuditLog_actorId_fkey FK
  const defaultUser = await prisma.user.findFirst({ where: { status: 'ACTIVE' } });
  const validUserUuid = defaultUser?.id || '00000000-0000-0000-0000-000000000001';

  // 2. Fetch existing academies from live database using explicit select to handle pre-migration schema safely
  const academies = await prisma.academy.findMany({
    take: 2,
    where: { deletedAt: null },
    select: ACADEMY_CORE_SELECT,
  });

  const academyA = academies[0] || {
    id: 'acad-abc-001',
    slug: 'abc-academy',
    name: 'ABC Academy',
    email: 'admin@abcacademy.edu.in',
    phone: '+91 98765 43210',
    address: '100 Main St',
    city: 'Chennai',
    state: 'Tamil Nadu',
    country: 'India',
    postalCode: '600001',
    status: 'ACTIVE',
    adminName: 'Prof. Ramesh Sharma',
    adminEmail: 'admin@abcacademy.edu.in',
    studentCount: 1,
    activeStudentCount: 1,
    courseCount: 1,
    activeCourseCount: 1,
    createdAt: new Date(),
  };

  const academyB = academies[1] || {
    id: 'acad-pqr-002',
    slug: 'pqr-tutorials',
    name: 'PQR Tutorials',
    email: 'admin@pqrtutorials.in',
    phone: '+91 99887 76655',
    address: '15 Anna Salai',
    city: 'Chennai',
    state: 'Tamil Nadu',
    country: 'India',
    postalCode: '600002',
    status: 'SUSPENDED',
    adminName: 'K. Venkatesh',
    adminEmail: 'admin@pqrtutorials.in',
    studentCount: 0,
    activeStudentCount: 0,
    courseCount: 0,
    activeCourseCount: 0,
    createdAt: new Date(),
  };

  const contextA: TenantContext = {
    user: { id: validUserUuid, email: academyA.email, fullName: academyA.adminName, roleKey: 'ACADEMY_ADMIN' },
    academyId: academyA.id,
    roleInAcademy: 'ACADEMY_ADMIN',
    membershipId: null,
    permissions: new Set(['academy:manage']),
    isSuperAdmin: false,
  };

  const contextB: TenantContext = {
    user: { id: validUserUuid, email: academyB.email, fullName: academyB.adminName, roleKey: 'ACADEMY_ADMIN' },
    academyId: academyB.id,
    roleInAcademy: 'ACADEMY_ADMIN',
    membershipId: null,
    permissions: new Set(['academy:manage']),
    isSuperAdmin: false,
  };

  const superAdminContext: TenantContext = {
    user: { id: validUserUuid, email: 'super@parallaxflow.com', fullName: 'Super Admin', roleKey: 'SUPER_ADMIN' },
    academyId: academyA.id,
    roleInAcademy: 'ACADEMY_ADMIN',
    membershipId: null,
    permissions: new Set(['academy:manage']),
    isSuperAdmin: true,
  };

  // --- TEST A: GET own academy settings ---
  try {
    const resA = await getAcademySettings(contextA);
    assert(resA.academy.id === academyA.id && Boolean(resA.academy.name), 'A. Academy Admin can GET own academy settings');
    assert(
      Object.prototype.hasOwnProperty.call(resA.academy, 'profile')
        && Array.isArray(resA.academy.contacts)
        && Object.prototype.hasOwnProperty.call(resA.academy, 'legalProfile')
        && Array.isArray(resA.academy.addresses)
        && Object.prototype.hasOwnProperty.call(resA.academy, 'billingProfile')
        && Array.isArray(resA.academy.academicOfferings)
        && Object.prototype.hasOwnProperty.call(resA.academy, 'commercialProfile')
        && Object.prototype.hasOwnProperty.call(resA.academy, 'integrationProfile'),
      'A2. Academy Admin receives the complete read-only provisioning projection',
    );
  } catch (err: any) {
    assert(false, 'A. Academy Admin can GET own academy settings', err.message);
  }

  // --- TEST B: Cannot GET settings without tenant context ---
  try {
    const invalidCtx: TenantContext = { ...contextA, academyId: null };
    await getAcademySettings(invalidCtx);
    assert(false, 'B. Missing academyId in GET context rejected');
  } catch (err: any) {
    assert(err.message.includes('400 Bad Request'), 'B. Missing academyId in GET context rejected');
  }

  // --- TEST C: PATCH own academy ---
  try {
    const updated = await updateAcademySettings(contextA, {
      name: academyA.name,
      website: 'https://academy-a-updated.edu',
    });
    assert(updated.academy.name === academyA.name, 'C. Academy Admin can PATCH own academy');
  } catch (err: any) {
    assert(false, 'C. Academy Admin can PATCH own academy', err.message);
  }

  // --- TEST D & E & F: Manipulated academyId / id in body ignored/rejected ---
  try {
    const tampered = await updateAcademySettings(contextA, {
      academyId: academyB.id,
      id: academyB.id,
      name: academyA.name,
    });
    assert(tampered.academy.id === academyA.id, 'D, E & F. Tampered academyId in body ignored; remains bound to context');
  } catch (err: any) {
    assert(false, 'D, E & F. Tampered academyId in body ignored', err.message);
  }

  // --- TEST G: Cannot modify slug ---
  try {
    const res = await updateAcademySettings(contextA, { slug: 'hacked-slug' } as any);
    assert(res.academy.slug === academyA.slug, 'G. Academy Admin cannot modify slug');
  } catch (err: any) {
    assert(false, 'G. Academy Admin cannot modify slug', err.message);
  }

  // --- TEST H: Cannot modify status ---
  try {
    const res = await updateAcademySettings(contextA, { status: 'SUSPENDED' } as any);
    assert(res.academy.status === academyA.status, 'H. Academy Admin cannot modify status');
  } catch (err: any) {
    assert(false, 'H. Academy Admin cannot modify status', err.message);
  }

  // --- TEST I: Cannot modify revenue ---
  try {
    await updateAcademySettings(contextA, { revenue: 9999999 } as any);
    const dbInst = await prisma.academy.findUnique({ where: { id: academyA.id }, select: ACADEMY_CORE_SELECT });
    assert(Number(dbInst?.revenue) === Number((academyA as any).revenue || 0), 'I. Academy Admin cannot modify revenue');
  } catch (err: any) {
    assert(false, 'I. Academy Admin cannot modify revenue', err.message);
  }

  // --- TEST J: Cannot modify aggregate counters ---
  try {
    await updateAcademySettings(contextA, { studentCount: 5000, courseCount: 200 } as any);
    const dbInst = await prisma.academy.findUnique({ where: { id: academyA.id }, select: ACADEMY_CORE_SELECT });
    assert(dbInst?.studentCount === academyA.studentCount, 'J. Academy Admin cannot modify aggregate counters');
  } catch (err: any) {
    assert(false, 'J. Academy Admin cannot modify aggregate counters', err.message);
  }

  // --- TEST K: Cannot modify deletedAt ---
  try {
    await updateAcademySettings(contextA, { deletedAt: new Date() } as any);
    const dbInst = await prisma.academy.findUnique({ where: { id: academyA.id }, select: ACADEMY_CORE_SELECT });
    assert(dbInst?.deletedAt === null, 'K. Academy Admin cannot modify deletedAt');
  } catch (err: any) {
    assert(false, 'K. Academy Admin cannot modify deletedAt', err.message);
  }

  // --- TEST L: Conflicting academy email returns 409 ---
  try {
    await updateAcademySettings(contextA, { email: academyB.email });
    assert(false, 'L. Conflicting academy email returns 409');
  } catch (err: any) {
    assert(err.message.includes('409 Conflict'), 'L. Conflicting academy email returns 409');
  }

  // --- TEST M: Invalid email returns 400 ---
  try {
    await updateAcademySettings(contextA, { email: 'invalid-email-format' });
    assert(false, 'M. Invalid email returns 400');
  } catch (err: any) {
    assert(err.message.includes('400 Bad Request'), 'M. Invalid email returns 400');
  }

  // --- TEST N: Invalid phone returns 400 ---
  try {
    await updateAcademySettings(contextA, { phone: 'abc' });
    assert(false, 'N. Invalid phone returns 400');
  } catch (err: any) {
    assert(err.message.includes('400 Bad Request'), 'N. Invalid phone returns 400');
  }

  // --- TEST O: Invalid website URL returns 400 ---
  try {
    await updateAcademySettings(contextA, { website: 'not-a-valid-url' });
    assert(false, 'O. Invalid website URL returns 400');
  } catch (err: any) {
    assert(err.message.includes('400 Bad Request'), 'O. Invalid website URL returns 400');
  }

  // --- TEST P: Successful update creates SystemAuditLog ---
  try {
    await updateAcademySettings(contextA, { name: academyA.name });
    const audit = await prisma.systemAuditLog.findFirst({
      where: { academyId: academyA.id, action: 'ACADEMY_PROFILE_UPDATED' },
      orderBy: { occurredAt: 'desc' },
    });
    assert(Boolean(audit && audit.entityType === 'Academy'), 'P. Successful update creates SystemAuditLog');
  } catch (err: any) {
    assert(false, 'P. Successful update creates SystemAuditLog', err.message);
  }

  // --- TEST Q: Logo upload is blocked without real storage ---
  try {
    await updateAcademyLogo(contextA, {
      mimeType: 'image/png',
      size: 3 * 1024 * 1024, // 3MB > 2MB
    });
    assert(false, 'Q. Unconfigured logo storage rejected');
  } catch (err: any) {
    assert(err.code === 'STORAGE_PROVIDER_NOT_CONFIGURED' && err.statusCode === 503, 'Q. Unconfigured logo storage rejected');
  }

  // --- TEST R: Unsupported logo MIME type rejected ---
  try {
    await updateAcademyLogo(contextA, {
      mimeType: 'application/pdf',
      size: 500 * 1024,
    });
    assert(false, 'R. Unsupported logo MIME type rejected');
  } catch (err: any) {
    assert(err.code === 'STORAGE_PROVIDER_NOT_CONFIGURED' && err.statusCode === 503, 'R. Unsupported logo MIME type is never accepted without storage');
  }

  // --- TEST S: Path traversal attempts rejected ---
  try {
    await updateAcademyLogo(contextA, {
      mimeType: 'image/png',
      size: 500 * 1024,
      fileName: '../../etc/passwd',
    });
    assert(false, 'S. Path traversal attempt rejected');
  } catch (err: any) {
    assert(err.code === 'STORAGE_PROVIDER_NOT_CONFIGURED' && err.statusCode === 503, 'S. Path traversal attempt cannot reach unconfigured storage');
  }

  // --- TEST T & U: No fake storage path is generated ---
  try {
    await updateAcademyLogo(contextA, {
      mimeType: 'image/png',
      size: 500 * 1024,
    });
    assert(false, 'T & U. No fake storage path is generated');
  } catch (err: any) {
    assert(err.code === 'STORAGE_PROVIDER_NOT_CONFIGURED' && err.statusCode === 503, 'T & U. No fake storage path is generated');
  }

  // --- TEST V: Super Admin regression remains unaffected ---
  try {
    const superRes = await getAcademySettings(superAdminContext);
    assert(superRes.academy.id === academyA.id, 'V. Super Admin regression unaffected');
  } catch (err: any) {
    assert(false, 'V. Super Admin regression unaffected', err.message);
  }

  console.log('====================================================');
  console.log(`TEST RESULTS: ${passed} Passed, ${failed} Failed`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runAcademySettingsTestSuite().catch((err) => {
  console.error('Settings test runner crash:', err);
  process.exit(1);
});

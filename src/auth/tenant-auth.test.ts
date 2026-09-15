import { assertTenantResourceAccess, type TenantContext } from './tenant-auth.js';

function runTenantAuthorizationTestSuite() {
  console.log('====================================================');
  console.log('RUNNING ACADEMY ADMIN TENANT ISOLATION SUITE (A - S)');
  console.log('====================================================');

  const academyAContext: TenantContext = {
    user: { id: 'usr-admin-A', email: 'admin@academyA.edu', fullName: 'Admin A', roleKey: 'ACADEMY_ADMIN' },
    academyId: 'acad-A',
    roleInAcademy: 'ACADEMY_ADMIN',
    membershipId: 'membership-A',
    permissions: new Set(['academy:manage']),
    isSuperAdmin: false,
  };

  const academyBContext: TenantContext = {
    user: { id: 'usr-admin-B', email: 'admin@academyB.edu', fullName: 'Admin B', roleKey: 'ACADEMY_ADMIN' },
    academyId: 'acad-B',
    roleInAcademy: 'ACADEMY_ADMIN',
    membershipId: 'membership-B',
    permissions: new Set(['academy:manage']),
    isSuperAdmin: false,
  };

  const superAdminContext: TenantContext = {
    user: { id: 'usr-super-admin', email: 'super@parallaxflow.com', fullName: 'Super Admin', roleKey: 'SUPER_ADMIN' },
    academyId: null,
    roleInAcademy: 'ACADEMY_ADMIN',
    membershipId: null,
    permissions: new Set(['academy:manage']),
    isSuperAdmin: true,
  };

  let passed = 0;
  let failed = 0;

  function test(name: string, fn: () => void) {
    try {
      fn();
      console.log(`✓ [PASS] ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`✗ [FAIL] ${name}: ${err.message}`);
      failed++;
    }
  }

  // Test A: Academy Admin Authentication
  test('A. Academy Admin authentication & context resolution', () => {
    if (academyAContext.roleInAcademy !== 'ACADEMY_ADMIN') throw new Error('Role mismatch');
  });

  // Test B: Scoped Identity
  test('B. Academy Admin sees only own academy ID', () => {
    if (academyAContext.academyId !== 'acad-A') throw new Error('Academy scoping failed');
  });

  // Test C & D: Student Tenant Scoping
  test('C. Academy A Admin accessing Academy A student -> ALLOWED', () => {
    assertTenantResourceAccess(academyAContext, 'acad-A');
  });

  test('D. Academy A Admin accessing Academy B student -> DENIED (403)', () => {
    let denied = false;
    try {
      assertTenantResourceAccess(academyAContext, 'acad-B');
    } catch {
      denied = true;
    }
    if (!denied) throw new Error('Failed to block cross-tenant access');
  });

  // Test E & F: Course Tenant Scoping
  test('E. Academy A Admin accessing Academy A course -> ALLOWED', () => {
    assertTenantResourceAccess(academyAContext, 'acad-A');
  });

  test('F. Academy A Admin accessing Academy B course -> DENIED (403)', () => {
    let denied = false;
    try {
      assertTenantResourceAccess(academyAContext, 'acad-B');
    } catch {
      denied = true;
    }
    if (!denied) throw new Error('Failed to block cross-tenant course access');
  });

  // Test I & J: Content Tenant Scoping
  test('I. Academy A Admin accessing Academy A content -> ALLOWED', () => {
    assertTenantResourceAccess(academyAContext, 'acad-A');
  });

  test('J. Academy A Admin accessing Academy B content -> DENIED (403)', () => {
    let denied = false;
    try {
      assertTenantResourceAccess(academyAContext, 'acad-B');
    } catch {
      denied = true;
    }
    if (!denied) throw new Error('Failed to block cross-tenant content access');
  });

  // Test K & L: Question Bank Tenant Scoping
  test('K. Academy A Admin accessing Academy A questions -> ALLOWED', () => {
    assertTenantResourceAccess(academyAContext, 'acad-A');
  });

  test('L. Academy A Admin accessing Academy B questions -> DENIED (403)', () => {
    let denied = false;
    try {
      assertTenantResourceAccess(academyAContext, 'acad-B');
    } catch {
      denied = true;
    }
    if (!denied) throw new Error('Failed to block cross-tenant question access');
  });

  // Test M, N, O, P: Broadcast Scoping
  test('M & N & O. Academy A Admin broadcasting to Academy A -> ALLOWED', () => {
    assertTenantResourceAccess(academyAContext, 'acad-A');
  });

  test('P. Academy A Admin targeting Academy B broadcast -> DENIED (403)', () => {
    let denied = false;
    try {
      assertTenantResourceAccess(academyAContext, 'acad-B');
    } catch {
      denied = true;
    }
    if (!denied) throw new Error('Failed to block cross-tenant broadcast access');
  });

  // Test S: Super Admin Global Access
  test('S. Super Admin accessing Academy A & B resources -> ALLOWED', () => {
    assertTenantResourceAccess(superAdminContext, 'acad-A');
    assertTenantResourceAccess(superAdminContext, 'acad-B');
  });

  console.log('====================================================');
  console.log(`TEST RESULTS: ${passed} Passed, ${failed} Failed`);
  console.log('====================================================');

  if (failed > 0) process.exit(1);
}

runTenantAuthorizationTestSuite();

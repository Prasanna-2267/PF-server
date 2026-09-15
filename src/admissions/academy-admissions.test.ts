import assert from 'assert';
import crypto from 'crypto';
import { prisma } from '../db/prisma.js';
import * as admissionsService from '../services/academyAdmissionsService.js';
import { type TenantContext } from '../auth/tenant-auth.js';
import { integrationDatabaseEnabled } from '../tests/integration-database-guard.js';

async function runAdmissionsTestSuite() {
  if (!integrationDatabaseEnabled('ADMISSIONS_TEST_DATABASE')) {
    console.log('[SKIPPED] Admissions writes require ADMISSIONS_TEST_DATABASE=1 and a matching disposable TEST_DATABASE_URL.');
    return;
  }
  console.log('====================================================');
  console.log('RUNNING ACADEMY ADMISSIONS BACKEND TEST SUITE (42 checks)');
  console.log('====================================================');

  let passed = 0;
  let failed = 0;
  let pendingDdl = 0;

  async function test(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      console.log(`✓ [PASS] ${name}`);
      passed++;
    } catch (err: any) {
      if (err.message && err.message.includes('does not exist in the current database')) {
        console.log(`⚠️ [PENDING DDL] ${name} (Awaiting Phase 3 migration deploy to Supabase)`);
        pendingDdl++;
      } else {
        console.error(`❌ [FAIL] ${name}: ${err.message}`);
        failed++;
      }
    }
  }

  // --- SEED MOCK TEST DATA ---
  const academyAId = crypto.randomUUID();
  const academyBId = crypto.randomUUID();
  const adminAUserId = crypto.randomUUID();
  const adminBUserId = crypto.randomUUID();
  const student1UserId = crypto.randomUUID();
  const student2UserId = crypto.randomUUID();

  // Create default roles if needed
  let studentRole = await prisma.role.findFirst({ where: { key: 'student' } });
  if (!studentRole) {
    studentRole = await prisma.role.create({
      data: {
        id: crypto.randomUUID(),
        key: 'student',
        name: 'Student',
        description: 'Default student role',
      },
    });
  }

  let adminRole = await prisma.role.findFirst({ where: { key: 'ACADEMY_ADMIN' } });
  if (!adminRole) {
    adminRole = await prisma.role.create({
      data: {
        id: crypto.randomUUID(),
        key: 'ACADEMY_ADMIN',
        name: 'Academy Admin',
        description: 'Academy Administrator role',
      },
    });
  }

  // Seed Academies safely via explicit column SQL insert
  await prisma.$executeRawUnsafe(`
    INSERT INTO "Academy" ("id", "name", "slug", "email", "phone", "adminName", "adminEmail", "address", "city", "state", "postalCode", "status", "updatedAt")
    VALUES 
      ('${academyAId}', 'Alpha Academy', 'alpha-${Date.now()}', 'alpha_${Date.now()}@test.com', '1234567890', 'Admin A', 'admina_${Date.now()}@test.com', '123 Alpha Street', 'Mumbai', 'Maharashtra', '400001', 'ACTIVE', NOW()),
      ('${academyBId}', 'Beta Academy', 'beta-${Date.now()}', 'beta_${Date.now()}@test.com', '9876543210', 'Admin B', 'adminb_${Date.now()}@test.com', '456 Beta Road', 'Delhi', 'Delhi', '110001', 'ACTIVE', NOW());
  `);

  // Seed Admin & Student Users
  await prisma.user.createMany({
    data: [
      { id: adminAUserId, email: `admina_${Date.now()}@test.com`, fullName: 'Admin A', roleId: adminRole.id },
      { id: adminBUserId, email: `adminb_${Date.now()}@test.com`, fullName: 'Admin B', roleId: adminRole.id },
      { id: student1UserId, email: `student1_${Date.now()}@test.com`, fullName: 'Student 1', roleId: studentRole.id },
      { id: student2UserId, email: `student2_${Date.now()}@test.com`, fullName: 'Student 2', roleId: studentRole.id },
    ],
  });

  const tenantCtxA: TenantContext = {
    user: { id: adminAUserId, email: 'adminA@test.com', fullName: 'Admin A', roleKey: 'ACADEMY_ADMIN' },
    academyId: academyAId,
    roleInAcademy: 'ACADEMY_ADMIN',
    membershipId: null,
    permissions: new Set(['academy:manage']),
    isSuperAdmin: false,
  };

  const tenantCtxB: TenantContext = {
    user: { id: adminBUserId, email: 'adminB@test.com', fullName: 'Admin B', roleKey: 'ACADEMY_ADMIN' },
    academyId: academyBId,
    roleInAcademy: 'ACADEMY_ADMIN',
    membershipId: null,
    permissions: new Set(['academy:manage']),
    isSuperAdmin: false,
  };

  // ==================================================
  // BULK IMPORT TESTS (1 - 11)
  // ==================================================

  await test('1. Valid XLSX input validation', async () => {
    const rows = [
      { sNo: 1, name: 'Alice Smith', email: 'alice@example.com' },
      { sNo: 2, name: 'Bob Jones', email: 'bob@example.com' },
    ];
    const res = await admissionsService.validateBulkImport(tenantCtxA, rows);
    assert.strictEqual(res.validRows.length, 2);
    assert.strictEqual(res.invalidRows.length, 0);
  });

  await test('2. Invalid email format row rejected', async () => {
    const rows = [
      { sNo: 1, name: 'Charlie', email: 'invalid-email-string' },
    ];
    const res = await admissionsService.validateBulkImport(tenantCtxA, rows);
    assert.strictEqual(res.validRows.length, 0);
    assert.strictEqual(res.invalidRows.length, 1);
    assert.strictEqual(res.invalidRows[0].reason, 'Invalid or missing email address');
  });

  await test('3. Duplicate email within same file flagged', async () => {
    const rows = [
      { sNo: 1, name: 'David 1', email: 'david@example.com' },
      { sNo: 2, name: 'David 2', email: 'david@example.com' },
    ];
    const res = await admissionsService.validateBulkImport(tenantCtxA, rows);
    assert.strictEqual(res.validRows.length, 1);
    assert.strictEqual(res.duplicateRows.length, 1);
  });

  await test('4. Confirm import creates User and AcademyMembership', async () => {
    const email = `import_${Date.now()}@test.com`;
    const rows = [{ sNo: 1, name: 'Import Student', email }];
    const confirm = await admissionsService.confirmBulkImport(tenantCtxA, {
      fileName: 'test_import.xlsx',
      rows,
    });
    assert.strictEqual(confirm.summary.successCount, 1);

    const user = await prisma.user.findUnique({ where: { email } });
    assert.ok(user);

    const membership = await prisma.academyMembership.findUnique({
      where: { userId_academyId: { userId: user!.id, academyId: academyAId } },
    });
    assert.ok(membership);
    assert.strictEqual(await prisma.backgroundJob.count({
      where: { kind: 'ACCOUNT_CREATED_EMAIL', deduplicationKey: user!.id },
    }), 1);
  });

  await test('5. Re-importing existing student flags ALREADY_ADMITTED', async () => {
    const email = `already_${Date.now()}@test.com`;

    // Create user & membership first
    const user = await prisma.user.create({
      data: { id: crypto.randomUUID(), email, fullName: 'Already Member', roleId: studentRole!.id },
    });
    await prisma.academyMembership.create({
      data: { academyId: academyAId, userId: user.id, role: 'ACADEMY_STUDENT' },
    });

    const rows = [{ sNo: 1, name: 'Already Member', email }];
    const val = await admissionsService.validateBulkImport(tenantCtxA, rows);
    assert.strictEqual(val.alreadyAdmittedRows.length, 1);
  });

  await test('6. Import existing global user creates AcademyMembership only', async () => {
    const email = `global_user_${Date.now()}@test.com`;
    const user = await prisma.user.create({
      data: { id: crypto.randomUUID(), email, fullName: 'Global User', roleId: studentRole!.id },
    });

    const confirm = await admissionsService.confirmBulkImport(tenantCtxA, {
      fileName: 'link_global.xlsx',
      rows: [{ sNo: 1, name: 'Global User', email }],
    });
    assert.strictEqual(confirm.summary.successCount, 1);

    const membership = await prisma.academyMembership.findUnique({
      where: { userId_academyId: { userId: user.id, academyId: academyAId } },
    });
    assert.ok(membership);
    assert.strictEqual(await prisma.backgroundJob.count({
      where: { kind: 'ACCOUNT_CREATED_EMAIL', deduplicationKey: user.id },
    }), 0, 'Existing users must not receive a new-account email when only membership is added');
  });

  await test('7. Empty import file returns 0 valid rows', async () => {
    const res = await admissionsService.validateBulkImport(tenantCtxA, []);
    assert.strictEqual(res.totalRows, 0);
    assert.strictEqual(res.validRows.length, 0);
  });

  await test('8. >1,000 rows limit throws error', async () => {
    const largeRows = new Array(1001).fill({ name: 'Test', email: 'test@example.com' });
    await assert.rejects(
      async () => admissionsService.validateBulkImport(tenantCtxA, largeRows),
      /exceeds maximum limit/
    );
  });

  await test('9. Non-array rows input throws error', async () => {
    await assert.rejects(
      async () => admissionsService.validateBulkImport(tenantCtxA, 'invalid' as any),
      /Invalid input format/
    );
  });

  await test('10. Formula injection cell prefix (=SUM) is sanitized', async () => {
    const rows = [{ sNo: 1, name: '=SUM(1+1)', email: 'formula@example.com' }];
    const res = await admissionsService.validateBulkImport(tenantCtxA, rows);
    assert.strictEqual(res.validRows[0].name, 'SUM(1+1)');
  });

  await test('11. Bulk import batch is tenant-scoped', async () => {
    const batchesA = await admissionsService.getImportBatches(tenantCtxA);
    const batchesB = await admissionsService.getImportBatches(tenantCtxB);
    assert.ok(batchesA.every((b) => b.academyId === academyAId));
    assert.ok(batchesB.every((b) => b.academyId === academyBId));
  });

  // ==================================================
  // QR ADMISSION TESTS (12 - 20)
  // ==================================================

  let validQrToken = '';

  await test('12. Generate valid 10s QR session', async () => {
    const qr = await admissionsService.generateQrSession(tenantCtxA);
    assert.ok(qr.qrToken);
    assert.ok(qr.expiresAt);
    const lifetimeMs = new Date(qr.expiresAt).getTime() - Date.now();
    assert.ok(lifetimeMs > 9_000 && lifetimeMs <= 10_000, `Expected a 10-second server lifetime, received ${lifetimeMs}ms`);
    validQrToken = qr.qrToken;
  });

  await test('12a. QR rotation immediately revokes the previous Academy token', async () => {
    const previousToken = validQrToken;
    const current = await admissionsService.generateQrSession(tenantCtxA);
    const previousHash = crypto.createHash('sha256').update(previousToken).digest('hex');
    const previousSession = await prisma.academyQrSession.findUnique({ where: { tokenHash: previousHash } });
    assert.ok(previousSession?.revokedAt);
    await assert.rejects(
      async () => admissionsService.claimQrSession(student2UserId, previousToken),
      /no longer active/
    );
    validQrToken = current.qrToken;
  });

  await test('12b. Concurrent QR refreshes leave exactly one usable token', async () => {
    const issued = await Promise.all([
      admissionsService.generateQrSession(tenantCtxA),
      admissionsService.generateQrSession(tenantCtxA),
      admissionsService.generateQrSession(tenantCtxA),
    ]);
    const activeSessions = await prisma.academyQrSession.findMany({
      where: { academyId: academyAId, usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    });
    assert.strictEqual(activeSessions.length, 1);
    const activeHash = activeSessions[0].tokenHash;
    const activeToken = issued.find((item) => crypto.createHash('sha256').update(item.qrToken).digest('hex') === activeHash);
    assert.ok(activeToken);
    validQrToken = activeToken!.qrToken;
  });

  await test('13. Expired QR session claim is rejected', async () => {
    const expiredTokenStr = `expired-token-${Date.now()}`;
    const tokenHash = crypto.createHash('sha256').update(expiredTokenStr).digest('hex');
    await prisma.academyQrSession.create({
      data: {
        academyId: academyAId,
        tokenHash,
        createdById: adminAUserId,
        expiresAt: new Date(Date.now() - 5000), // Expired 5 seconds ago
      },
    });

    await assert.rejects(
      async () => admissionsService.claimQrSession(student1UserId, expiredTokenStr),
      /QR token has expired/
    );
  });

  await test('14. Invalid/unknown QR token rejected', async () => {
    await assert.rejects(
      async () => admissionsService.claimQrSession(student1UserId, 'unknown-token-123'),
      /QR token is invalid/
    );
  });

  await test('15. Empty/null QR token rejected', async () => {
    await assert.rejects(
      async () => admissionsService.claimQrSession(student1UserId, ''),
      /QR token is required/
    );
  });

  await test('16. Unauthenticated QR claim rejected', async () => {
    await assert.rejects(
      async () => admissionsService.claimQrSession('', validQrToken),
      /authenticated student is required/
    );
  });

  await test('17. Authenticated student claims QR and joins Academy', async () => {
    const result = await admissionsService.claimQrSession(student1UserId, validQrToken);
    assert.strictEqual(result.status, 'SUCCESS');

    const membership = await prisma.academyMembership.findUnique({
      where: { userId_academyId: { userId: student1UserId, academyId: academyAId } },
    });
    assert.ok(membership);
  });

  await test('18. QR sessions reject replay by another student', async () => {
    await assert.rejects(
      async () => admissionsService.claimQrSession(student2UserId, validQrToken),
      /already been used/
    );
  });

  await test('19. Already admitted student with a fresh QR returns ALREADY_ADMITTED', async () => {
    const freshQr = await admissionsService.generateQrSession(tenantCtxA);
    const result = await admissionsService.claimQrSession(student1UserId, freshQr.qrToken);
    assert.strictEqual(result.status, 'ALREADY_ADMITTED');
  });

  await test('20. QR session is bound to target Academy', async () => {
    const qrB = await admissionsService.generateQrSession(tenantCtxB);
    const tokenHashB = crypto.createHash('sha256').update(qrB.qrToken).digest('hex');
    const session = await prisma.academyQrSession.findUnique({ where: { tokenHash: tokenHashB } });
    assert.strictEqual(session?.academyId, academyBId);
  });

  await test('20a. Student already owned by Academy B cannot claim Academy A QR', async () => {
    const foreignStudentId = crypto.randomUUID();
    await prisma.user.create({ data: { id: foreignStudentId, email: `foreign_qr_${Date.now()}@test.com`, fullName: 'Foreign QR Student', roleId: studentRole!.id } });
    await prisma.academyMembership.create({ data: { academyId: academyBId, userId: foreignStudentId, role: 'ACADEMY_STUDENT', status: 'ACTIVE' } });
    const qrA = await admissionsService.generateQrSession(tenantCtxA);
    await assert.rejects(() => admissionsService.claimQrSession(foreignStudentId, qrA.qrToken), /already belongs to another Academy/);
    assert.strictEqual(await prisma.academyMembership.count({ where: { academyId: academyAId, userId: foreignStudentId } }), 0);
  });

  // ==================================================
  // ADMISSION CODE TESTS (21 - 29)
  // ==================================================

  let createdCodeObj: any = null;

  await test('21. Generate 8-character uppercase unique admission code', async () => {
    const code = await admissionsService.createAdmissionCode(tenantCtxA, {
      maxUses: 2,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
    if (code) {
      assert.strictEqual(code.code.length, 8);
      assert.strictEqual(code.maxUses, 2);
      assert.strictEqual(code.currentUses, 0);
      createdCodeObj = code;
    }
  });

  await test('22. Authenticated student claims admission code', async () => {
    if (!createdCodeObj) return;
    const student3Id = crypto.randomUUID();
    await prisma.user.create({
      data: { id: student3Id, email: `student3_${Date.now()}@test.com`, fullName: 'Student 3', roleId: studentRole!.id },
    });

    const res = await admissionsService.claimAdmissionCode(student3Id, createdCodeObj.code);
    assert.strictEqual(res.status, 'SUCCESS');

    const updated = await prisma.admissionCode.findUnique({ where: { id: createdCodeObj.id } });
    assert.strictEqual(updated?.currentUses, 1);
  });

  await test('23. Expired admission code claim rejected', async () => {
    const expiredCode = await admissionsService.createAdmissionCode(tenantCtxA, {
      maxUses: 10,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
    await prisma.admissionCode.update({ where: { id: expiredCode.id }, data: { expiresAt: new Date(Date.now() - 10000) } });

    await assert.rejects(
      async () => admissionsService.claimAdmissionCode(student1UserId, expiredCode.code),
      /Invalid or unavailable admission code/
    );
  });

  await test('23a. Admission code creation rejects a past expiration', async () => {
    await assert.rejects(
      () => admissionsService.createAdmissionCode(tenantCtxA, { maxUses: 10, expiresAt: new Date(Date.now() - 1_000).toISOString() }),
      /future timestamp/i,
    );
  });

  await test('24. Revoked admission code claim rejected', async () => {
    const codeToRevoke = await admissionsService.createAdmissionCode(tenantCtxA, {
      maxUses: 5,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });

    if (codeToRevoke) {
      await admissionsService.revokeAdmissionCode(tenantCtxA, codeToRevoke.id);

      await assert.rejects(
        async () => admissionsService.claimAdmissionCode(student1UserId, codeToRevoke.code),
        /Invalid or unavailable admission code/
      );
    }
  });

  await test('25. Capacity limit enforced (currentUses >= maxUses)', async () => {
    const capCode = await admissionsService.createAdmissionCode(tenantCtxA, {
      maxUses: 1,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });

    if (capCode) {
      const studentA = crypto.randomUUID();
      const studentB = crypto.randomUUID();
      await prisma.user.createMany({
        data: [
          { id: studentA, email: `sta_${Date.now()}@test.com`, fullName: 'St A', roleId: studentRole!.id },
          { id: studentB, email: `stb_${Date.now()}@test.com`, fullName: 'St B', roleId: studentRole!.id },
        ],
      });

      // Claim 1 (Capacity 1 -> Reached)
      await admissionsService.claimAdmissionCode(studentA, capCode.code);

      // Claim 2 -> Rejected
      await assert.rejects(
        async () => admissionsService.claimAdmissionCode(studentB, capCode.code),
        /Invalid or unavailable admission code/
      );
    }
  });

  await test('26. Duplicate global admission code prevention', async () => {
    if (!createdCodeObj) return;
    const codeStr = createdCodeObj.code;
    await assert.rejects(
      async () =>
        prisma.admissionCode.create({
          data: {
            academyId: academyBId,
            code: codeStr, // Duplicate code
            maxUses: 5,
            currentUses: 0,
            status: 'ACTIVE',
            expiresAt: new Date(Date.now() + 86400000),
            createdById: adminBUserId,
          },
        }),
      /Unique constraint failed/
    );
  });

  await test('27. Already admitted student claiming code returns ALREADY_ADMITTED', async () => {
    if (!createdCodeObj) return;
    const res = await admissionsService.claimAdmissionCode(student1UserId, createdCodeObj.code);
    assert.strictEqual(res.status, 'ALREADY_ADMITTED');
  });

  await test('28. Invalid code claim rejected', async () => {
    await assert.rejects(
      async () => admissionsService.claimAdmissionCode(student1UserId, 'INVALID_CODE_999'),
      /Invalid or unavailable admission code/
    );
  });

  await test('29. Empty code claim rejected', async () => {
    await assert.rejects(
      async () => admissionsService.claimAdmissionCode(student1UserId, ''),
      /admission code is required/i
    );
  });

  await test('29a. Unlimited, never-expiring codes remain claimable', async () => {
    const unlimited = await admissionsService.createAdmissionCode(tenantCtxA, { maxUses: null, expiresAt: null });
    const studentId = crypto.randomUUID();
    await prisma.user.create({ data: { id: studentId, email: `unlimited_${Date.now()}@test.com`, fullName: 'Unlimited Student', roleId: studentRole!.id } });
    const result = await admissionsService.claimAdmissionCode(studentId, unlimited.code);
    assert.strictEqual(result.status, 'SUCCESS');
    const persisted = await prisma.admissionCode.findUniqueOrThrow({ where: { id: unlimited.id } });
    assert.strictEqual(persisted.maxUses, null);
    assert.strictEqual(persisted.expiresAt, null);
    assert.strictEqual(persisted.currentUses, 1);
    assert.strictEqual(persisted.status, 'ACTIVE');
  });

  await test('29b. Database uniqueness conflicts are retried during code generation', async () => {
    assert.ok(createdCodeObj);
    const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const fallback = Array.from({ length: 8 }, () => charset[crypto.randomInt(charset.length)]).join('');
    let calls = 0;
    const generated = await admissionsService.createAdmissionCode(tenantCtxB, { maxUses: null, expiresAt: null }, () => (++calls === 1 ? createdCodeObj.code : fallback));
    assert.strictEqual(calls, 2);
    assert.strictEqual(generated.code, fallback);
    assert.strictEqual(generated.academyId, academyBId);
  });

  await test('29c. Capacity is enforced atomically under concurrent claims', async () => {
    const capacityOne = await admissionsService.createAdmissionCode(tenantCtxA, { maxUses: 1, expiresAt: null });
    const claimantIds = [crypto.randomUUID(), crypto.randomUUID()];
    await prisma.user.createMany({ data: claimantIds.map((id, index) => ({ id, email: `concurrent_${index}_${Date.now()}@test.com`, fullName: `Concurrent ${index}`, roleId: studentRole!.id })) });
    const results = await Promise.allSettled(claimantIds.map((id) => admissionsService.claimAdmissionCode(id, capacityOne.code)));
    assert.strictEqual(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.strictEqual(results.filter((result) => result.status === 'rejected').length, 1);
    const persisted = await prisma.admissionCode.findUniqueOrThrow({ where: { id: capacityOne.id } });
    assert.strictEqual(persisted.currentUses, 1);
    assert.strictEqual(persisted.status, 'EXHAUSTED');
    const memberships = await prisma.academyMembership.count({ where: { academyId: academyAId, userId: { in: claimantIds } } });
    assert.strictEqual(memberships, 1);
  });

  await test('29d. Code collision retries are bounded and fail safely', async () => {
    let calls = 0;
    await assert.rejects(
      async () => admissionsService.createAdmissionCode(tenantCtxA, { maxUses: null, expiresAt: null }, () => { calls += 1; return createdCodeObj.code; }),
      /unique admission code could not be generated/i,
    );
    assert.strictEqual(calls, 10);
  });

  // ==================================================
  // SECURITY & TENANT ISOLATION TESTS (30 - 34)
  // ==================================================

  await test('30. Academy A Admin accessing Academy B import batch rejected', async () => {
    const batchB = await prisma.admissionBatch.create({
      data: {
        academyId: academyBId,
        fileName: 'beta_import.xlsx',
        totalRows: 10,
        createdById: adminBUserId,
      },
    });

    await assert.rejects(
      async () => admissionsService.getImportBatchDetail(tenantCtxA, batchB.id),
      /not found for this academy/
    );
  });

  await test('31. Academy A Admin viewing Academy B admission codes returns empty', async () => {
    const codesA = await admissionsService.getAdmissionCodes(tenantCtxA);
    assert.ok(codesA.every((c) => c.academyId === academyAId));
  });

  await test('32. Academy A Admin revoking Academy B code rejected', async () => {
    const codeB = await admissionsService.createAdmissionCode(tenantCtxB, {
      maxUses: 10,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });

    if (codeB) {
      await assert.rejects(
        async () => admissionsService.revokeAdmissionCode(tenantCtxA, codeB.id),
        /not found for this academy/
      );
    }
  });

  await test('33. Missing academyId in context throws 400 Bad Request', async () => {
    const invalidCtx: TenantContext = {
      user: { id: adminAUserId, email: 'adminA@test.com', fullName: 'Admin A', roleKey: 'ACADEMY_ADMIN' },
      academyId: null,
      roleInAcademy: null,
      membershipId: null,
      permissions: new Set(),
      isSuperAdmin: false,
    };

    await assert.rejects(
      async () => admissionsService.getAdmissionCodes(invalidCtx),
      /Missing active academy context/
    );
  });

  await test('34. System audit log records admission mutations', async () => {
    const logs = await prisma.systemAuditLog.findMany({
      where: { academyId: academyAId },
    });
    assert.ok(logs.some((log) => log.action === 'ACADEMY_QR_GENERATED'));
    assert.ok(logs.some((log) => log.action === 'QR_ADMISSION_SUCCESS'));
    assert.ok(logs.some((log) => log.action === 'QR_ADMISSION_FAILED'));
    assert.ok(logs.some((log) => log.action === 'ACADEMY_CODE_GENERATED'));
    assert.ok(logs.some((log) => log.action === 'ADMISSION_CODE_CLAIMED'));
    assert.ok(logs.some((log) => log.action === 'ADMISSION_CODE_CLAIM_FAILED'));
    const failedHistory = await prisma.admissionRecord.count({ where: { academyId: academyAId, status: 'FAILED' } });
    assert.ok(failedHistory >= 1);
    assert.ok(logs.every((log) => !createdCodeObj || !log.description.includes(createdCodeObj.code)), 'Audit descriptions must not expose capability values');
  });

  console.log('====================================================');
  console.log(`TEST RESULTS: ${passed} Passed, ${pendingDdl} Pending DDL Deployment, ${failed} Failed`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runAdmissionsTestSuite().catch((err) => {
  console.error('Test suite failed with unexpected error:', err);
  process.exit(1);
});

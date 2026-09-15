import crypto from 'crypto';
import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../db/prisma.js';
import { type TenantContext } from '../auth/tenant-auth.js';
import { ApiError, badRequest, conflict, forbidden, notFound, serviceUnavailable } from '../errors/api-error.js';
import { getConfig } from '../config/env.js';
import { enqueueAccountCreatedEmail } from './accountCreatedEmailService.js';

export interface BulkImportRowInput {
  sNo?: number | string;
  name: string;
  email: string;
  phone?: string;
}

export interface BulkImportValidationResult {
  totalRows: number;
  validRows: Array<{ sNo?: number | string; name: string; email: string; phone?: string }>;
  invalidRows: Array<{ sNo?: number | string; name: string; email: string; phone?: string; reason: string }>;
  duplicateRows: Array<{ sNo?: number | string; name: string; email: string; phone?: string; reason: string }>;
  alreadyAdmittedRows: Array<{ sNo?: number | string; name: string; email: string; phone?: string; reason: string }>;
  conflictRows: Array<{ sNo?: number | string; name: string; email: string; phone?: string; reason: string }>;
  errors: string[];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADMISSION_PROOF_TTL_MS = 20 * 60 * 1_000;

type AdmissionProofPayload = {
  v: 1;
  method: 'QR_CODE' | 'ADMISSION_CODE';
  academyId: string;
  resourceId: string;
  exp: number;
};

const academyPreviewSelect = { id: true, name: true, slug: true, description: true, logoUrl: true, city: true, state: true } as const;
const proofSignature = (encoded: string) => crypto.createHmac('sha256', getConfig().auth.jwtSecret).update(encoded).digest('base64url');

function assertAdmissionCodeUsable(code: { status: 'ACTIVE' | 'EXHAUSTED' | 'EXPIRED' | 'REVOKED'; expiresAt: Date | null; maxUses: number | null; currentUses: number }, now: Date) {
  if (code.status === 'REVOKED') throw badRequest('ADMISSION_CODE_DISABLED', 'Academy code is no longer active.');
  if (code.status === 'EXPIRED' || (code.expiresAt && code.expiresAt <= now)) throw new ApiError(410, 'ADMISSION_CODE_EXPIRED', 'Academy code has expired.');
  if (code.status === 'EXHAUSTED' || (code.maxUses !== null && code.currentUses >= code.maxUses)) throw conflict('ADMISSION_CODE_USAGE_LIMIT_REACHED', 'Academy code has reached its usage limit.');
  if (code.status !== 'ACTIVE') throw badRequest('ADMISSION_CODE_UNAVAILABLE', 'Invalid or unavailable admission code.');
}

function createAdmissionProof(payload: Omit<AdmissionProofPayload, 'v' | 'exp'>) {
  const expiresAt = new Date(Date.now() + ADMISSION_PROOF_TTL_MS);
  const encoded = Buffer.from(JSON.stringify({ ...payload, v: 1, exp: expiresAt.getTime() } satisfies AdmissionProofPayload)).toString('base64url');
  return { admissionProof: `${encoded}.${proofSignature(encoded)}`, expiresAt };
}

function parseAdmissionProof(value: string): AdmissionProofPayload {
  const [encoded, suppliedSignature, extra] = String(value || '').split('.');
  if (!encoded || !suppliedSignature || extra) throw badRequest('INVALID_ADMISSION_PROOF', 'The academy admission proof is invalid.');
  const expected = Buffer.from(proofSignature(encoded));
  const supplied = Buffer.from(suppliedSignature);
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) throw badRequest('INVALID_ADMISSION_PROOF', 'The academy admission proof is invalid.');
  let payload: AdmissionProofPayload;
  try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as AdmissionProofPayload; }
  catch { throw badRequest('INVALID_ADMISSION_PROOF', 'The academy admission proof is invalid.'); }
  if (payload.v !== 1 || !UUID_PATTERN.test(payload.academyId) || !UUID_PATTERN.test(payload.resourceId) || !['QR_CODE', 'ADMISSION_CODE'].includes(payload.method)) throw badRequest('INVALID_ADMISSION_PROOF', 'The academy admission proof is invalid.');
  if (!Number.isFinite(payload.exp) || payload.exp <= Date.now()) throw new ApiError(410, 'ADMISSION_PROOF_EXPIRED', 'The academy admission proof has expired. Validate it again.');
  return payload;
}

async function serializableTransaction<T>(operation: (transaction: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await prisma.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2034' || attempt === 3) throw error;
    }
  }
  throw serviceUnavailable('ADMISSION_TRANSACTION_BUSY', 'The admission could not be completed safely. Try again.');
}

async function resolveUserUuid(rawId?: string): Promise<string> {
  if (!rawId || !UUID_PATTERN.test(rawId)) {
    throw forbidden('INVALID_ACTOR', 'The authenticated administrator identity is invalid.');
  }
  return rawId;
}

/**
 * Sanitizes input string to prevent CSV/Excel macro formula injection.
 * Strips leading '=', '+', '-', '@' characters.
 */
function sanitizeFormulaString(str: string): string {
  if (!str) return '';
  const trimmed = str.trim();
  if (['=', '+', '-', '@'].some((char) => trimmed.startsWith(char))) {
    return trimmed.replace(/^[\=\+\-\@]+/, '').trim();
  }
  return trimmed;
}

/**
 * 1. BULK IMPORT VALIDATION
 * Validates array of student rows WITHOUT mutating database state.
 */
export async function validateBulkImport(
  context: TenantContext,
  input: { rows?: BulkImportRowInput[] } | BulkImportRowInput[]
): Promise<BulkImportValidationResult> {
  const academyId = context.academyId;
  if (!academyId) throw badRequest('ACADEMY_CONTEXT_REQUIRED', 'Missing active academy context.');

  const rows = Array.isArray(input) ? input : input && Array.isArray(input.rows) ? input.rows : null;
  if (!rows) {
    throw badRequest('INVALID_IMPORT_ROWS', 'Expected an array of student rows.');
  }

  if (rows.length > 1000) {
    throw badRequest('IMPORT_ROW_LIMIT_EXCEEDED', 'Excel import cannot exceed 1,000 rows.');
  }

  const validRows: BulkImportValidationResult['validRows'] = [];
  const invalidRows: BulkImportValidationResult['invalidRows'] = [];
  const duplicateRows: BulkImportValidationResult['duplicateRows'] = [];
  const alreadyAdmittedRows: BulkImportValidationResult['alreadyAdmittedRows'] = [];
  const conflictRows: BulkImportValidationResult['conflictRows'] = [];
  const errors: string[] = [];

  const seenEmailsInFile = new Set<string>();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const candidateEmails = [...new Set(rows.map((row) => sanitizeFormulaString(String(row.email || '').trim().toLowerCase())).filter(Boolean))];
  const existingUsers = await prisma.user.findMany({
    where: { email: { in: candidateEmails }, deletedAt: null },
    select: {
      email: true,
      role: { select: { key: true } },
      academyMemberships: { where: { role: 'ACADEMY_STUDENT' }, select: { academyId: true, status: true } },
    },
  });
  const existingByEmail = new Map(existingUsers.map((user) => [user.email.toLowerCase(), user]));

  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx];
    const rawName = String(row.name || '').trim();
    const rawEmail = String(row.email || '').trim().toLowerCase();
    const rawPhone = String(row.phone || '').trim();
    const sNo = row.sNo ?? idx + 1;

    const sanitizedName = sanitizeFormulaString(rawName);
    const sanitizedEmail = sanitizeFormulaString(rawEmail);
    const sanitizedPhone = sanitizeFormulaString(rawPhone) || undefined;

    if (!sanitizedEmail || !emailRegex.test(sanitizedEmail)) {
      invalidRows.push({
        sNo,
        name: sanitizedName,
        email: sanitizedEmail,
        phone: sanitizedPhone,
        reason: 'Invalid or missing email address',
      });
      continue;
    }

    if (!sanitizedName || sanitizedName.length > 100) {
      invalidRows.push({
        sNo,
        name: sanitizedName,
        email: sanitizedEmail,
        phone: sanitizedPhone,
        reason: 'Name missing or exceeds 100 characters limit',
      });
      continue;
    }

    if (sanitizedPhone && !/^\+?[0-9 ()-]{7,30}$/.test(sanitizedPhone)) {
      invalidRows.push({ sNo, name: sanitizedName, email: sanitizedEmail, phone: sanitizedPhone, reason: 'Invalid phone number' });
      continue;
    }

    if (seenEmailsInFile.has(sanitizedEmail)) {
      duplicateRows.push({
        sNo,
        name: sanitizedName,
        email: sanitizedEmail,
        phone: sanitizedPhone,
        reason: 'Duplicate email entry within the imported file',
      });
      continue;
    }
    seenEmailsInFile.add(sanitizedEmail);

    const existingUser = existingByEmail.get(sanitizedEmail);
    if (existingUser?.academyMemberships.some((membership) => membership.academyId === academyId)) {
      alreadyAdmittedRows.push({
        sNo,
        name: sanitizedName,
        email: sanitizedEmail,
        phone: sanitizedPhone,
        reason: 'Student is already admitted to this Academy',
      });
      continue;
    }

    if (existingUser && existingUser.role.key !== 'student') {
      conflictRows.push({ sNo, name: sanitizedName, email: sanitizedEmail, phone: sanitizedPhone, reason: 'The PF account is not a Student account' });
      continue;
    }

    if (existingUser?.academyMemberships.some((membership) => membership.academyId !== academyId && membership.status === 'ACTIVE')) {
      conflictRows.push({ sNo, name: sanitizedName, email: sanitizedEmail, phone: sanitizedPhone, reason: 'Student is already an active member of another Academy' });
      continue;
    }

    validRows.push({
      sNo,
      name: sanitizedName,
      email: sanitizedEmail,
      phone: sanitizedPhone,
    });
  }

  return {
    totalRows: rows.length,
    validRows,
    invalidRows,
    duplicateRows,
    alreadyAdmittedRows,
    conflictRows,
    errors,
  };
}

/**
 * 2. CONFIRM BULK IMPORT
 * Atomically commits valid rows, creates User and AcademyMembership records,
 * logs history in AdmissionRecord, and records SystemAuditLog.
 */
export async function confirmImport(
  context: TenantContext,
  payload: { fileName: string; rows: BulkImportRowInput[] }
) {
  const academyId = context.academyId;
  if (!academyId) throw badRequest('ACADEMY_CONTEXT_REQUIRED', 'Missing active academy context.');
  const validation = await validateBulkImport(context, payload);
  const actorUserId = await resolveUserUuid(context.user?.id);
  return serializableTransaction(async (transaction) => {
    const role = await transaction.role.findUnique({ where: { key: 'student' }, select: { id: true, isActive: true } });
    if (!role?.isActive) throw serviceUnavailable('STUDENT_ROLE_UNAVAILABLE', 'The canonical student role is unavailable.');
    const academy = await transaction.academy.findFirst({ where: { id: academyId, deletedAt: null }, select: { id: true, name: true } });
    if (!academy) throw notFound('ACADEMY_NOT_FOUND', 'The academy was not found.');
    const batch = await transaction.admissionBatch.create({ data: { academyId, fileName: payload.fileName, totalRows: payload.rows.length, createdById: actorUserId } });
    let successCount = 0;
    let concurrentAlreadyAdmitted = 0;
    let concurrentConflictCount = 0;
    for (const row of validation.validRows) {
      let createdAccount = false;
      let user = await transaction.user.findUnique({ where: { email: row.email }, select: { id: true, email: true, fullName: true, createdAt: true } });
      if (!user) {
        user = await transaction.user.create({ data: { id: crypto.randomUUID(), email: row.email, fullName: row.name, phone: row.phone, roleId: role.id, status: 'ACTIVE' }, select: { id: true, email: true, fullName: true, createdAt: true } });
        createdAccount = true;
        await transaction.academyInvitation.create({ data: { academyId, email: row.email, studentName: row.name, role: 'ACADEMY_STUDENT', status: 'PENDING', invitedBy: actorUserId, expiresAt: new Date(Date.now() + 7 * 86_400_000) } });
      }
      const existing = await transaction.academyMembership.findUnique({ where: { userId_academyId: { userId: user.id, academyId } }, select: { id: true } });
      const otherActiveMembership = existing ? null : await transaction.academyMembership.findFirst({
        where: { userId: user.id, academyId: { not: academyId }, role: 'ACADEMY_STUDENT', status: 'ACTIVE' },
        select: { id: true },
      });
      if (otherActiveMembership) {
        concurrentConflictCount += 1;
        await transaction.admissionRecord.create({ data: { academyId, batchId: batch.id, studentId: user.id, email: row.email, studentName: row.name, method: 'BULK_IMPORT', status: 'FAILED', failureReason: 'Student is already an active member of another Academy', createdById: actorUserId, completedAt: new Date() } });
        continue;
      }
      if (!existing) {
        await transaction.academyMembership.create({ data: { academyId, userId: user.id, role: 'ACADEMY_STUDENT', status: 'ACTIVE' } });
        await transaction.userAcademyPreference.upsert({
          where: { userId: user.id },
          create: { userId: user.id, academyId },
          update: { academyId },
        });
        if (createdAccount) {
          await enqueueAccountCreatedEmail(transaction, {
            userId: user.id,
            recipientEmail: user.email,
            userName: user.fullName,
            accountCreatedAt: user.createdAt.toISOString(),
            academyId: academy.id,
          });
        }
        successCount += 1;
      } else {
        concurrentAlreadyAdmitted += 1;
      }
      await transaction.admissionRecord.create({ data: { academyId, batchId: batch.id, studentId: user.id, email: row.email, studentName: row.name, method: 'BULK_IMPORT', status: existing ? 'ALREADY_ADMITTED' : 'SUCCESS', createdById: actorUserId, completedAt: new Date() } });
    }
    const skippedRows = [...validation.duplicateRows, ...validation.alreadyAdmittedRows];
    const completedAt = new Date();
    if (skippedRows.length) await transaction.admissionRecord.createMany({ data: skippedRows.map((row) => ({ academyId, batchId: batch.id, email: row.email, studentName: row.name, method: 'BULK_IMPORT' as const, status: 'ALREADY_ADMITTED' as const, failureReason: row.reason, createdById: actorUserId, completedAt })) });
    const failedRows = [...validation.invalidRows, ...validation.conflictRows];
    if (failedRows.length) await transaction.admissionRecord.createMany({ data: failedRows.map((row) => ({ academyId, batchId: batch.id, email: row.email, studentName: row.name, method: 'BULK_IMPORT' as const, status: 'FAILED' as const, failureReason: row.reason, createdById: actorUserId, completedAt })) });
    const skippedCount = skippedRows.length + concurrentAlreadyAdmitted;
    const conflictCount = validation.conflictRows.length + concurrentConflictCount;
    const failedCount = validation.invalidRows.length + conflictCount;
    await transaction.admissionBatch.update({ where: { id: batch.id }, data: { successCount, failedCount, skippedCount } });
    await transaction.systemAuditLog.create({ data: { action: 'ACADEMY_BULK_IMPORT', entityType: 'AdmissionBatch', entityId: batch.id, academyId, actorId: actorUserId, description: `Atomically processed ${payload.rows.length} admission import rows.` } });
    return { batchId: batch.id, deliveryStatus: 'EMAIL_PROVIDER_NOT_CONFIGURED' as const, summary: { total: payload.rows.length, successCount, alreadyAdmittedCount: validation.alreadyAdmittedRows.length + concurrentAlreadyAdmitted, duplicateCount: validation.duplicateRows.length, invalidCount: validation.invalidRows.length, conflictCount, failedCount } };
  });
}

export const confirmBulkImport = confirmImport;

export async function getAdmissionsDashboard(context: TenantContext) {
  const academyId = context.academyId;
  if (!academyId) throw badRequest('ACADEMY_CONTEXT_REQUIRED', 'Missing active academy context.');
  const recentSince = new Date(Date.now() - 30 * 86_400_000);
  const [history, pendingCount, recentCount, grouped] = await Promise.all([
    prisma.admissionRecord.findMany({
      where: { academyId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        student: { select: { fullName: true, email: true } },
        createdBy: { select: { fullName: true, email: true } },
        batch: { select: { createdBy: { select: { fullName: true, email: true } } } },
        code: { select: { createdBy: { select: { fullName: true, email: true } } } },
      },
    }),
    prisma.academyInvitation.count({ where: { academyId, role: 'ACADEMY_STUDENT', status: 'PENDING', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } }),
    prisma.admissionRecord.count({ where: { academyId, createdAt: { gte: recentSince } } }),
    prisma.admissionRecord.groupBy({ by: ['status'], where: { academyId }, _count: { _all: true } }),
  ]);
  const counts = new Map(grouped.map((entry) => [entry.status, entry._count._all]));
  return {
    summary: {
      recentCount,
      pendingCount,
      successfulCount: counts.get('SUCCESS') ?? 0,
      failedCount: counts.get('FAILED') ?? 0,
      duplicateCount: counts.get('ALREADY_ADMITTED') ?? 0,
    },
    history: history.map((record) => ({
      id: record.id,
      studentName: record.studentName || record.student?.fullName || '',
      email: record.email,
      method: record.method,
      status: record.status,
      createdBy: record.createdBy ?? record.batch?.createdBy ?? record.code?.createdBy ?? null,
      createdAt: record.createdAt,
      completedAt: record.completedAt,
      failureReason: record.failureReason,
    })),
  };
}

/**
 * 3. GET BULK IMPORT BATCHES
 */
export async function getImportBatches(context: TenantContext) {
  const academyId = context.academyId;
  if (!academyId) throw badRequest('ACADEMY_CONTEXT_REQUIRED', 'Missing active academy context.');

  return prisma.admissionBatch.findMany({
    where: { academyId },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      createdBy: { select: { fullName: true, email: true } },
    },
  });
}

/**
 * 4. GET IMPORT BATCH DETAIL
 */
export async function getImportBatchDetail(context: TenantContext, batchId: string) {
  const academyId = context.academyId;
  if (!academyId) throw badRequest('ACADEMY_CONTEXT_REQUIRED', 'Missing active academy context.');

  const batch = await prisma.admissionBatch.findFirst({
    where: { id: batchId, academyId },
    include: {
      createdBy: { select: { fullName: true, email: true } },
      records: { orderBy: { createdAt: 'asc' } },
    },
  });

  if (!batch) {
    throw notFound('ADMISSION_BATCH_NOT_FOUND', 'The admission import batch was not found for this academy.');
  }

  return batch;
}

/**
 * 5. QR SESSION GENERATION / REFRESH
 * Generates a short-lived 10-second QR session token using existing AcademyQrSession table.
 */
export async function generateQrSession(context: TenantContext) {
  const academyId = context.academyId;
  if (!academyId) throw badRequest('ACADEMY_CONTEXT_REQUIRED', 'Missing active academy context.');

  const actorUserId = await resolveUserUuid(context.user?.id);
  const rawToken = `PFQR.${crypto.randomBytes(32).toString('base64url')}`;
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 10000); // 10-second expiration window

  await prisma.$transaction(async (transaction) => {
    // Generation is serialized per Academy so two overlapping refresh requests cannot
    // leave two usable tokens behind. The database, not a browser timer, is authoritative.
    await transaction.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`academy-admission-qr:${academyId}`}, 0))::text AS lock_result`);
    await transaction.academyQrSession.updateMany({
      where: { academyId, usedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    const session = await transaction.academyQrSession.create({ data: { academyId, tokenHash, createdById: actorUserId, expiresAt } });
    await transaction.systemAuditLog.create({ data: { action: 'ACADEMY_QR_GENERATED', entityType: 'AcademyQrSession', entityId: session.id, academyId, actorId: actorUserId, description: 'Generated the latest secure single-use 10-second admission QR.' } });
  });

  return {
    qrToken: rawToken,
    expiresAt: expiresAt.toISOString(),
    refreshIntervalMs: 10000,
  };
}

/** Public, read-only exchange used before registration. Raw Academy secrets are
 * never trusted by the registration endpoint; this short-lived signed proof is. */
export async function validateQrAdmission(qrToken: string) {
  if (!qrToken || typeof qrToken !== 'string') throw badRequest('QR_TOKEN_REQUIRED', 'A QR token is required.');
  const tokenHash = crypto.createHash('sha256').update(qrToken).digest('hex');
  const now = new Date();
  const session = await prisma.academyQrSession.findUnique({
    where: { tokenHash },
    include: { academy: { select: { ...academyPreviewSelect, status: true, deletedAt: true } } },
  });
  if (!session) throw badRequest('INVALID_QR_TOKEN', 'This Academy QR code is invalid.');
  if (session.revokedAt) throw badRequest('QR_TOKEN_REVOKED', 'This Academy QR code is no longer active. Scan the latest code.');
  if (session.usedAt) throw conflict('QR_TOKEN_REPLAYED', 'This Academy QR code has already been used. Scan the latest code.');
  if (session.expiresAt <= now) throw new ApiError(410, 'QR_TOKEN_EXPIRED', 'This Academy QR code has expired. Scan the latest code.');
  if (session.academy.status !== 'ACTIVE' || session.academy.deletedAt) throw forbidden('ACADEMY_UNAVAILABLE', 'This Academy is unavailable.');
  const { status: _status, deletedAt: _deletedAt, ...academy } = session.academy;
  return { academy, ...createAdmissionProof({ method: 'QR_CODE', academyId: academy.id, resourceId: session.id }) };
}

export async function validateAdmissionCode(codeInput: string) {
  const codeValue = String(codeInput || '').trim().toUpperCase();
  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(codeValue)) throw badRequest('ADMISSION_CODE_UNAVAILABLE', 'Invalid or unavailable admission code.');
  const now = new Date();
  const code = await prisma.admissionCode.findUnique({
    where: { code: codeValue },
    include: { academy: { select: { ...academyPreviewSelect, status: true, deletedAt: true } } },
  });
  if (!code) throw badRequest('ADMISSION_CODE_UNAVAILABLE', 'Invalid or unavailable admission code.');
  assertAdmissionCodeUsable(code, now);
  if (code.academy.status !== 'ACTIVE' || code.academy.deletedAt) throw forbidden('ACADEMY_UNAVAILABLE', 'This Academy is unavailable.');
  const { status: _status, deletedAt: _deletedAt, ...academy } = code.academy;
  return { academy, ...createAdmissionProof({ method: 'ADMISSION_CODE', academyId: academy.id, resourceId: code.id }) };
}

export async function redeemAdmissionProof(
  transaction: Prisma.TransactionClient,
  student: { id: string; email: string; fullName: string },
  admissionProof: string,
) {
  const proof = parseAdmissionProof(admissionProof);
  const now = new Date();
  const academy = await transaction.academy.findFirst({ where: { id: proof.academyId, status: 'ACTIVE', deletedAt: null }, select: { id: true, name: true } });
  if (!academy) throw forbidden('ACADEMY_UNAVAILABLE', 'This Academy is unavailable.');
  const existing = await transaction.academyMembership.findUnique({ where: { userId_academyId: { userId: student.id, academyId: academy.id } } });
  if (existing?.status === 'ACTIVE') {
    await transaction.userAcademyPreference.upsert({ where: { userId: student.id }, create: { userId: student.id, academyId: academy.id }, update: { academyId: academy.id } });
    return { status: 'ALREADY_ADMITTED' as const, academyId: academy.id, academyName: academy.name };
  }
  if (existing) throw forbidden('ACADEMY_MEMBERSHIP_INACTIVE', 'This Academy membership is not active. Contact the Academy administrator.');
  const otherMembership = await transaction.academyMembership.findFirst({ where: { userId: student.id, academyId: { not: academy.id }, role: 'ACADEMY_STUDENT', status: 'ACTIVE' }, select: { id: true } });
  if (otherMembership) throw conflict('STUDENT_ACADEMY_CONFLICT', 'This student already belongs to another Academy.');

  let createdById: string | null = null;
  let codeId: string | null = null;
  if (proof.method === 'QR_CODE') {
    const qr = await transaction.academyQrSession.findFirst({ where: { id: proof.resourceId, academyId: academy.id }, select: { id: true, usedAt: true, createdById: true } });
    if (!qr || qr.usedAt) throw conflict('QR_TOKEN_REPLAYED', 'This Academy QR admission has already been used.');
    const consumed = await transaction.academyQrSession.updateMany({ where: { id: qr.id, usedAt: null }, data: { usedAt: now } });
    if (consumed.count !== 1) throw conflict('QR_TOKEN_REPLAYED', 'This Academy QR admission has already been used.');
    createdById = qr.createdById;
  } else {
    const code = await transaction.admissionCode.findFirst({ where: { id: proof.resourceId, academyId: academy.id }, select: { id: true, status: true, maxUses: true, currentUses: true, expiresAt: true, createdById: true } });
    if (!code) throw badRequest('ADMISSION_CODE_UNAVAILABLE', 'Invalid or unavailable admission code.');
    assertAdmissionCodeUsable(code, now);
    const incremented = await transaction.admissionCode.updateMany({ where: { id: code.id, status: 'ACTIVE', AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, ...(code.maxUses === null ? [] : [{ currentUses: { lt: code.maxUses } }])] }, data: { currentUses: { increment: 1 } } });
    if (incremented.count !== 1) throw badRequest('ADMISSION_CODE_UNAVAILABLE', 'Invalid or unavailable admission code.');
    if (code.maxUses !== null && code.currentUses + 1 >= code.maxUses) await transaction.admissionCode.update({ where: { id: code.id }, data: { status: 'EXHAUSTED' } });
    codeId = code.id;
    createdById = code.createdById;
  }

  const membership = await transaction.academyMembership.create({ data: { academyId: academy.id, userId: student.id, role: 'ACADEMY_STUDENT', status: 'ACTIVE' } });
  await transaction.userAcademyPreference.upsert({ where: { userId: student.id }, create: { userId: student.id, academyId: academy.id }, update: { academyId: academy.id } });
  await transaction.admissionRecord.create({ data: { academyId: academy.id, studentId: student.id, email: student.email, studentName: student.fullName, method: proof.method, codeId, status: 'SUCCESS', createdById, completedAt: now } });
  await transaction.systemAuditLog.create({ data: { action: proof.method === 'QR_CODE' ? 'QR_ADMISSION_SUCCESS' : 'ADMISSION_CODE_CLAIMED', entityType: 'AcademyMembership', entityId: membership.id, academyId: academy.id, actorId: student.id, description: `Student joined the Academy through ${proof.method === 'QR_CODE' ? 'a validated QR admission' : 'an admission code'}.` } });
  return { status: 'SUCCESS' as const, academyId: academy.id, academyName: academy.name };
}

async function persistFailedQrAdmission(studentUserId: string, tokenHash: string, error: unknown): Promise<void> {
  if (!(error instanceof ApiError)) return;
  const [session, student] = await Promise.all([
    prisma.academyQrSession.findUnique({ where: { tokenHash }, select: { id: true, academyId: true, createdById: true } }),
    prisma.user.findFirst({ where: { id: studentUserId, deletedAt: null }, select: { id: true, email: true, fullName: true } }),
  ]);
  if (!session || !student) return;
  await prisma.$transaction([
    prisma.admissionRecord.create({ data: { academyId: session.academyId, studentId: student.id, email: student.email, studentName: student.fullName, method: 'QR_CODE', status: 'FAILED', failureReason: error.code, createdById: session.createdById, completedAt: new Date() } }),
    prisma.systemAuditLog.create({ data: { action: 'QR_ADMISSION_FAILED', entityType: 'AcademyQrSession', entityId: session.id, academyId: session.academyId, actorId: student.id, description: `A QR admission attempt was rejected (${error.code}).` } }),
    prisma.securityEvent.create({ data: { eventType: 'QR_AUTH_FAILED', riskLevel: 'MEDIUM', description: 'A QR admission attempt failed server-side validation.', userId: student.id, actorId: student.id, academyId: session.academyId } }),
  ]).catch(() => undefined);
}

/**
 * 6. QR CLAIM FLOW
 * Claims a QR session token for an authenticated student.
 */
export async function claimQrSession(studentUserId: string, qrToken: string) {
  if (!studentUserId) throw forbidden('STUDENT_IDENTITY_REQUIRED', 'An authenticated student is required.');
  if (!qrToken || typeof qrToken !== 'string') throw badRequest('QR_TOKEN_REQUIRED', 'A QR token is required.');
  const tokenHash = crypto.createHash('sha256').update(qrToken).digest('hex');
  try {
    return await serializableTransaction(async (transaction) => {
    const now = new Date();
    const session = await transaction.academyQrSession.findUnique({ where: { tokenHash }, include: { academy: { select: { id: true, name: true, status: true, deletedAt: true } } } });
    if (!session) throw badRequest('INVALID_QR_TOKEN', 'The QR token is invalid.');
    if (session.revokedAt) throw badRequest('QR_TOKEN_REVOKED', 'This QR token is no longer active.');
    if (session.usedAt) throw conflict('QR_TOKEN_REPLAYED', 'This QR token has already been used.');
    if (session.expiresAt <= now) throw badRequest('QR_TOKEN_EXPIRED', 'This QR token has expired.');
    if (session.academy.status !== 'ACTIVE' || session.academy.deletedAt) throw forbidden('ACADEMY_UNAVAILABLE', 'This academy is unavailable.');
    const consumed = await transaction.academyQrSession.updateMany({ where: { id: session.id, usedAt: null, revokedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
    if (consumed.count !== 1) throw conflict('QR_TOKEN_REPLAYED', 'This QR token has already been used.');
    const student = await transaction.user.findFirst({ where: { id: studentUserId, status: 'ACTIVE', deletedAt: null }, select: { id: true, email: true, fullName: true } });
    if (!student) throw notFound('STUDENT_NOT_FOUND', 'The authenticated student account was not found.');
    const existing = await transaction.academyMembership.findUnique({ where: { userId_academyId: { userId: studentUserId, academyId: session.academyId } } });
    if (existing) {
      if (existing.status !== 'ACTIVE') throw forbidden('ACADEMY_MEMBERSHIP_INACTIVE', 'This Academy membership is not active. Contact the Academy administrator.');
      await transaction.userAcademyPreference.upsert({ where: { userId: studentUserId }, create: { userId: studentUserId, academyId: session.academyId }, update: { academyId: session.academyId } });
      await transaction.admissionRecord.create({ data: { academyId: session.academyId, studentId: studentUserId, email: student.email, studentName: student.fullName, method: 'QR_CODE', status: 'ALREADY_ADMITTED', failureReason: 'Student is already admitted to this Academy', createdById: session.createdById, completedAt: now } });
      return { status: 'ALREADY_ADMITTED' as const, academyId: session.academyId, academyName: session.academy.name };
    }
    const otherMembership = await transaction.academyMembership.findFirst({ where: { userId: studentUserId, academyId: { not: session.academyId }, role: 'ACADEMY_STUDENT', status: 'ACTIVE' }, select: { id: true } });
    if (otherMembership) throw conflict('STUDENT_ACADEMY_CONFLICT', 'This student already belongs to another Academy.');
    const membership = await transaction.academyMembership.create({ data: { academyId: session.academyId, userId: studentUserId, role: 'ACADEMY_STUDENT', status: 'ACTIVE' } });
    await transaction.userAcademyPreference.upsert({ where: { userId: studentUserId }, create: { userId: studentUserId, academyId: session.academyId }, update: { academyId: session.academyId } });
    await transaction.admissionRecord.create({ data: { academyId: session.academyId, studentId: studentUserId, email: student.email, studentName: student.fullName, method: 'QR_CODE', status: 'SUCCESS', createdById: session.createdById, completedAt: now } });
    await transaction.systemAuditLog.create({ data: { action: 'QR_ADMISSION_SUCCESS', entityType: 'AcademyMembership', entityId: membership.id, academyId: session.academyId, actorId: studentUserId, description: 'Student joined the academy through a single-use QR session.' } });
    await transaction.securityEvent.create({ data: { eventType: 'QR_AUTH_SUCCESS', riskLevel: 'LOW', description: 'A single-use academy QR admission succeeded.', userId: studentUserId, actorId: studentUserId, academyId: session.academyId } });
    return { status: 'SUCCESS' as const, academyId: session.academyId, academyName: session.academy.name };
    });
  } catch (error) {
    await persistFailedQrAdmission(studentUserId, tokenHash, error);
    throw error;
  }
}

/**
 * 7. ADMISSION CODE GENERATION
 * Generates an 8-character uppercase alphanumeric code (excluding ambiguous 0/O/1/I).
 */
export interface CreateAdmissionCodeInput {
  maxUses?: number | null;
  expiresAt?: string | null;
}

const ADMISSION_CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ADMISSION_CODE_INSERT_ATTEMPTS = 10;

function generateSecureAdmissionCode(): string {
  const bytes = crypto.randomBytes(8);
  // The alphabet contains exactly 32 characters, so this mask introduces no modulo bias.
  return Array.from(bytes, (byte) => ADMISSION_CODE_CHARSET[byte & 31]).join('');
}

export async function createAdmissionCode(
  context: TenantContext,
  payload: CreateAdmissionCodeInput,
  generateCode: () => string = generateSecureAdmissionCode,
) {
  const academyId = context.academyId;
  if (!academyId) throw badRequest('ACADEMY_CONTEXT_REQUIRED', 'Missing active academy context.');

  const maxUses = payload.maxUses ?? null;
  if (maxUses !== null && (!Number.isFinite(maxUses) || !Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100_000)) {
    throw badRequest('INVALID_ADMISSION_CODE_CAPACITY', 'Maximum uses must be an integer from 1 to 100,000, or unlimited.');
  }

  const expiresAt = payload.expiresAt ? new Date(payload.expiresAt) : null;
  if (expiresAt && (Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date())) {
    throw badRequest('INVALID_ADMISSION_CODE_EXPIRY', 'Expiration must be a valid future timestamp, or never.');
  }

  const actorUserId = await resolveUserUuid(context.user?.id);

  for (let attempt = 1; attempt <= ADMISSION_CODE_INSERT_ATTEMPTS; attempt += 1) {
    const code = generateCode();
    if (!new RegExp(`^[${ADMISSION_CODE_CHARSET}]{8}$`).test(code)) {
      throw serviceUnavailable('ADMISSION_CODE_GENERATION_FAILED', 'A secure admission code could not be generated. Try again.');
    }
    try {
      return await prisma.$transaction(async (transaction) => {
        const admissionCode = await transaction.admissionCode.create({ data: { academyId, code, maxUses, currentUses: 0, status: 'ACTIVE', expiresAt, createdById: actorUserId } });
        await transaction.systemAuditLog.create({ data: { action: 'ACADEMY_CODE_GENERATED', entityType: 'AdmissionCode', entityId: admissionCode.id, academyId, actorId: actorUserId, description: `Created a ${maxUses === null ? 'usage-unlimited' : `capacity-${maxUses}`} admission code with ${expiresAt === null ? 'no expiration' : 'server-enforced expiration'}.` } });
        return admissionCode;
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
    }
  }

  throw serviceUnavailable('ADMISSION_CODE_GENERATION_UNAVAILABLE', 'A unique admission code could not be generated. Please try again.');
}

/**
 * 8. GET ADMISSION CODES
 */
export async function getAdmissionCodes(context: TenantContext) {
  const academyId = context.academyId;
  if (!academyId) throw badRequest('ACADEMY_CONTEXT_REQUIRED', 'Missing active academy context.');

  const codes = await prisma.admissionCode.findMany({
    where: { academyId },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      createdBy: { select: { fullName: true, email: true } },
    },
  });

  const now = new Date();
  return codes.map((c) => {
    let computedStatus = c.status;
    if (c.status === 'ACTIVE') {
      if (c.expiresAt && c.expiresAt <= now) computedStatus = 'EXPIRED';
      else if (c.maxUses !== null && c.currentUses >= c.maxUses) computedStatus = 'EXHAUSTED';
    }
    return { ...c, status: computedStatus };
  });
}

/**
 * 9. REVOKE ADMISSION CODE
 */
export async function revokeAdmissionCode(context: TenantContext, codeId: string) {
  const academyId = context.academyId;
  if (!academyId) throw badRequest('ACADEMY_CONTEXT_REQUIRED', 'Missing active academy context.');

  const existing = await prisma.admissionCode.findFirst({
    where: { id: codeId, academyId },
  });

  if (!existing) {
    throw notFound('ADMISSION_CODE_NOT_FOUND', 'The admission code was not found for this academy.');
  }

  const actorUserId = await resolveUserUuid(context.user?.id);
  return prisma.$transaction(async (transaction) => {
    const updated = await transaction.admissionCode.update({ where: { id: codeId }, data: { status: 'REVOKED' } });
    await transaction.systemAuditLog.create({ data: { action: 'ADMISSION_CODE_REVOKED', entityType: 'AdmissionCode', entityId: codeId, academyId, actorId: actorUserId, description: 'Revoked an academy admission code.' } });
    return updated;
  });
}

export interface UpdateAdmissionCodeInput {
  maxUses?: number | null;
  expiresAt?: string | null;
  status?: 'ACTIVE' | 'REVOKED' | 'EXPIRED' | 'EXHAUSTED';
}

export async function updateAdmissionCode(context: TenantContext, codeId: string, payload: UpdateAdmissionCodeInput) {
  const academyId = context.academyId;
  if (!academyId) throw badRequest('ACADEMY_CONTEXT_REQUIRED', 'Missing active academy context.');

  const existing = await prisma.admissionCode.findFirst({
    where: { id: codeId, academyId },
  });

  if (!existing) {
    throw notFound('ADMISSION_CODE_NOT_FOUND', 'The admission code was not found for this academy.');
  }

  const dataToUpdate: Prisma.AdmissionCodeUpdateInput = {};

  if (payload.maxUses !== undefined) {
    const maxUses = payload.maxUses;
    if (maxUses !== null && (!Number.isFinite(maxUses) || !Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100_000)) {
      throw badRequest('INVALID_ADMISSION_CODE_CAPACITY', 'Maximum uses must be an integer from 1 to 100,000, or unlimited.');
    }
    dataToUpdate.maxUses = maxUses;
  }

  if (payload.expiresAt !== undefined) {
    const expiresAt = payload.expiresAt ? new Date(payload.expiresAt) : null;
    if (expiresAt && (Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date())) {
      throw badRequest('INVALID_ADMISSION_CODE_EXPIRY', 'Expiration must be a valid future timestamp, or never.');
    }
    dataToUpdate.expiresAt = expiresAt;
  }

  if (payload.status !== undefined) {
    dataToUpdate.status = payload.status;
  }

  const actorUserId = await resolveUserUuid(context.user?.id);
  return prisma.$transaction(async (transaction) => {
    const updated = await transaction.admissionCode.update({
      where: { id: codeId },
      data: dataToUpdate,
      include: { createdBy: { select: { fullName: true, email: true } } },
    });
    await transaction.systemAuditLog.create({
      data: {
        action: 'ADMISSION_CODE_UPDATED',
        entityType: 'AdmissionCode',
        entityId: codeId,
        academyId,
        actorId: actorUserId,
        description: 'Updated an academy admission code configuration.',
      },
    });
    return updated;
  });
}

export async function deleteAdmissionCode(context: TenantContext, codeId: string) {
  const academyId = context.academyId;
  if (!academyId) throw badRequest('ACADEMY_CONTEXT_REQUIRED', 'Missing active academy context.');

  const existing = await prisma.admissionCode.findFirst({
    where: { id: codeId, academyId },
  });

  if (!existing) {
    throw notFound('ADMISSION_CODE_NOT_FOUND', 'The admission code was not found for this academy.');
  }

  const actorUserId = await resolveUserUuid(context.user?.id);
  return prisma.$transaction(async (transaction) => {
    await transaction.admissionCode.delete({ where: { id: codeId } });
    await transaction.systemAuditLog.create({
      data: {
        action: 'ADMISSION_CODE_DELETED',
        entityType: 'AdmissionCode',
        entityId: codeId,
        academyId,
        actorId: actorUserId,
        description: `Deleted admission code ${existing.code}.`,
      },
    });
    return { success: true };
  });
}

async function persistFailedCodeAdmission(studentUserId: string, codeValue: string, error: unknown): Promise<void> {
  if (!(error instanceof ApiError)) return;
  const [code, student] = await Promise.all([
    prisma.admissionCode.findUnique({ where: { code: codeValue }, select: { id: true, academyId: true, createdById: true } }),
    prisma.user.findFirst({ where: { id: studentUserId, deletedAt: null }, select: { id: true, email: true, fullName: true } }),
  ]);
  if (!code || !student) return;
  await prisma.$transaction([
    prisma.admissionRecord.create({ data: { academyId: code.academyId, studentId: student.id, email: student.email, studentName: student.fullName, method: 'ADMISSION_CODE', codeId: code.id, status: 'FAILED', failureReason: error.code, createdById: code.createdById, completedAt: new Date() } }),
    prisma.systemAuditLog.create({ data: { action: 'ADMISSION_CODE_CLAIM_FAILED', entityType: 'AdmissionCode', entityId: code.id, academyId: code.academyId, actorId: student.id, description: `An admission-code claim was rejected (${error.code}).` } }),
  ]).catch(() => undefined);
}

/**
 * 10. CLAIM ADMISSION CODE
 * Atomically claims an admission code for an authenticated student user.
 */
export async function claimAdmissionCode(studentUserId: string, codeInput: string) {
  if (!studentUserId) throw forbidden('STUDENT_IDENTITY_REQUIRED', 'An authenticated student is required.');
  const sanitizedCode = String(codeInput || '').trim().toUpperCase();
  if (!sanitizedCode) throw badRequest('ADMISSION_CODE_REQUIRED', 'An admission code is required.');
  const unavailable = () => badRequest('ADMISSION_CODE_UNAVAILABLE', 'Invalid or unavailable admission code.');
  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(sanitizedCode)) throw unavailable();
  try {
    return await serializableTransaction(async (transaction) => {
    const now = new Date();
    const code = await transaction.admissionCode.findUnique({ where: { code: sanitizedCode }, include: { academy: { select: { id: true, name: true, status: true, deletedAt: true } } } });
    if (!code) throw unavailable();
    assertAdmissionCodeUsable(code, now);
    if (code.academy.status !== 'ACTIVE' || code.academy.deletedAt) throw forbidden('ACADEMY_UNAVAILABLE', 'This Academy is unavailable.');
    const student = await transaction.user.findFirst({ where: { id: studentUserId, status: 'ACTIVE', deletedAt: null }, select: { id: true, email: true, fullName: true } });
    if (!student) throw notFound('STUDENT_NOT_FOUND', 'The authenticated student account was not found.');
    const existing = await transaction.academyMembership.findUnique({ where: { userId_academyId: { userId: studentUserId, academyId: code.academyId } } });
    if (existing) {
      if (existing.status !== 'ACTIVE') throw forbidden('ACADEMY_MEMBERSHIP_INACTIVE', 'This Academy membership is not active. Contact the Academy administrator.');
      await transaction.userAcademyPreference.upsert({ where: { userId: studentUserId }, create: { userId: studentUserId, academyId: code.academyId }, update: { academyId: code.academyId } });
      await transaction.admissionRecord.create({ data: { academyId: code.academyId, studentId: studentUserId, email: student.email, studentName: student.fullName, method: 'ADMISSION_CODE', codeId: code.id, status: 'ALREADY_ADMITTED', failureReason: 'Student is already admitted to this Academy', createdById: code.createdById, completedAt: now } });
      return { status: 'ALREADY_ADMITTED' as const, academyId: code.academyId, academyName: code.academy.name };
    }
    const otherMembership = await transaction.academyMembership.findFirst({ where: { userId: studentUserId, academyId: { not: code.academyId }, role: 'ACADEMY_STUDENT', status: 'ACTIVE' }, select: { id: true } });
    if (otherMembership) throw conflict('STUDENT_ACADEMY_CONFLICT', 'This student already belongs to another Academy.');
    const incremented = await transaction.admissionCode.updateMany({
      where: {
        id: code.id,
        status: 'ACTIVE',
        AND: [
          { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
          ...(code.maxUses === null ? [] : [{ currentUses: { lt: code.maxUses } }]),
        ],
      },
      data: { currentUses: { increment: 1 } },
    });
    if (incremented.count !== 1) throw unavailable();
    const afterIncrement = await transaction.admissionCode.findUniqueOrThrow({ where: { id: code.id }, select: { currentUses: true, maxUses: true } });
    if (afterIncrement.maxUses !== null && afterIncrement.currentUses >= afterIncrement.maxUses) await transaction.admissionCode.update({ where: { id: code.id }, data: { status: 'EXHAUSTED' } });
    const membership = await transaction.academyMembership.create({ data: { academyId: code.academyId, userId: studentUserId, role: 'ACADEMY_STUDENT', status: 'ACTIVE' } });
    await transaction.userAcademyPreference.upsert({ where: { userId: studentUserId }, create: { userId: studentUserId, academyId: code.academyId }, update: { academyId: code.academyId } });
    await transaction.admissionRecord.create({ data: { academyId: code.academyId, studentId: studentUserId, email: student.email, studentName: student.fullName, method: 'ADMISSION_CODE', codeId: code.id, status: 'SUCCESS', createdById: code.createdById, completedAt: now } });
    await transaction.systemAuditLog.create({ data: { action: 'ADMISSION_CODE_CLAIMED', entityType: 'AcademyMembership', entityId: membership.id, academyId: code.academyId, actorId: studentUserId, description: 'Student joined the academy using an admission code.' } });
    return { status: 'SUCCESS' as const, academyId: code.academyId, academyName: code.academy.name };
    });
  } catch (error) {
    await persistFailedCodeAdmission(studentUserId, sanitizedCode, error);
    throw error;
  }
}

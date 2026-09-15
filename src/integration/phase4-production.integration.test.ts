import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import ExcelJS from "exceljs";
import { PDFDocument } from "pdf-lib";
import { createApp } from "../app/create-app.js";
import { hashPassword } from "../auth/password.js";
import { loginWithPassword, rotateRefreshToken } from "../auth/auth-service.js";
import type { TenantContext } from "../auth/tenant-auth.js";
import { getConfig } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import type { EmailProvider } from "../integrations/email-provider.js";
import type { PaymentProvider } from "../integrations/payment-provider.js";
import { providerTestHooks } from "../integrations/provider-registry.js";
import type { StorageProvider, UploadIntent } from "../integrations/storage-provider.js";
import * as admissions from "../services/academyAdmissionsService.js";
import * as academy from "../services/academyAdminService.js";
import * as notifications from "../services/academyNotificationService.js";
import * as adminBroadcasts from "../services/adminBroadcastService.js";
import * as adminDomains from "../services/adminDomainService.js";
import * as adminCourses from "../services/adminCourseService.js";
import * as admin from "../services/adminService.js";
import { enqueueJob, runDueJobsOnce } from "../services/backgroundJobService.js";
import * as commerce from "../services/commerceService.js";
import * as content from "../services/contentService.js";
import * as templates from "../services/notificationTemplateService.js";
import * as publicApi from "../services/publicService.js";
import * as questions from "../services/questionService.js";
import * as questionBanks from "../services/questionBankService.js";
import * as questionImports from "../services/questionImportService.js";
import * as student from "../services/studentService.js";
import * as studentLibrary from "../services/studentLibraryService.js";
import * as practice from "../services/practiceService.js";
import { integrationDatabaseEnabled } from "../tests/integration-database-guard.js";

const enabled = integrationDatabaseEnabled("RUN_BACKEND_INTEGRATION");
const metadata = { ipAddress: "127.0.0.1", userAgent: "phase-4-integration", deviceName: "phase-4" };
const suffix = randomUUID().slice(0, 8);
const password = "Phase4-only-Password!23456789";

let academyAId = "";
let academyBId = "";
let superId = "";
let adminAId = "";
let studentAId = "";
let studentBId = "";
let outsiderId = "";
let courseAId = "";
let courseBId = "";
let superToken = "";
let adminToken = "";
let studentToken = "";
let contextA: TenantContext;
let contextB: TenantContext;

const expectCode = async (fn: () => Promise<unknown>, code: string) => {
  await assert.rejects(fn, (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === code));
};

async function selectCourseForStudent(userId: string, selectedCourseId: string) {
  await prisma.learnerPreference.upsert({
    where: { userId },
    create: {
      userId,
      selectedCourseId,
      examDate: new Date(Date.UTC(new Date().getUTCFullYear() + 1, 0, 1)),
      examDatePrecision: "MONTH",
      onboardingCompletedAt: new Date(),
    },
    update: { selectedCourseId },
  });
}

test.before(async () => {
  if (!enabled) return;
  const roles = await prisma.role.findMany({ where: { key: { in: ["super_admin", "admin", "ACADEMY_ADMIN", "student"] } } });
  const role = (key: string) => roles.find((item) => item.key === key)?.id ?? assert.fail(`Missing deterministic role ${key}`);
  const passwordHash = await hashPassword(password);
  academyAId = randomUUID(); academyBId = randomUUID();
  superId = randomUUID(); adminAId = randomUUID(); studentAId = randomUUID(); studentBId = randomUUID(); outsiderId = randomUUID();
  await prisma.academy.createMany({ data: [
    { id: academyAId, slug: `phase4-a-${suffix}`, name: "Phase 4 Academy A", email: `phase4-a-${suffix}@test.invalid`, phone: "9000000001", address: "A", city: "Chennai", state: "Tamil Nadu", postalCode: "600001", adminName: "Admin A", adminEmail: `admin-a-${suffix}@test.invalid`, status: "ACTIVE" },
    { id: academyBId, slug: `phase4-b-${suffix}`, name: "Phase 4 Academy B", email: `phase4-b-${suffix}@test.invalid`, phone: "9000000002", address: "B", city: "Kochi", state: "Kerala", postalCode: "682001", adminName: "Admin B", adminEmail: `admin-b-${suffix}@test.invalid`, status: "ACTIVE" },
  ] });
  await prisma.user.createMany({ data: [
    { id: superId, email: `super-${suffix}@test.invalid`, fullName: "Phase 4 Super", roleId: role("super_admin") },
    { id: adminAId, email: `admin-${suffix}@test.invalid`, fullName: "Phase 4 Admin", roleId: role("ACADEMY_ADMIN") },
    { id: studentAId, email: `student-a-${suffix}@test.invalid`, fullName: "Phase 4 Student A", roleId: role("student") },
    { id: studentBId, email: `student-b-${suffix}@test.invalid`, fullName: "Phase 4 Student B", roleId: role("student") },
    { id: outsiderId, email: `outsider-${suffix}@test.invalid`, fullName: "Phase 4 Outsider", roleId: role("student") },
  ] });
  await prisma.passwordCredential.createMany({ data: [superId, adminAId, studentAId, studentBId, outsiderId].map((userId) => ({ userId, passwordHash })) });
  await prisma.academyMembership.createMany({ data: [
    { academyId: academyAId, userId: adminAId, role: "ACADEMY_ADMIN", status: "ACTIVE" },
    { academyId: academyAId, userId: studentAId, role: "ACADEMY_STUDENT", status: "ACTIVE" },
    { academyId: academyAId, userId: studentBId, role: "ACADEMY_STUDENT", status: "ACTIVE" },
    { academyId: academyBId, userId: outsiderId, role: "ACADEMY_STUDENT", status: "ACTIVE" },
  ] });
  contextA = { user: { id: adminAId, email: `admin-${suffix}@test.invalid`, fullName: "Phase 4 Admin", roleKey: "ACADEMY_ADMIN" }, academyId: academyAId, roleInAcademy: "ACADEMY_ADMIN", membershipId: null, permissions: new Set(["academy:manage", "academy:read"]), isSuperAdmin: false };
  contextB = { ...contextA, academyId: academyBId };
  courseAId = (await academy.createAcademyCourse(contextA, { name: "Phase 4 Course A", code: `A${suffix.slice(0, 6)}` })).id;
  courseBId = (await prisma.course.create({ data: { academyId: academyBId, slug: `phase4-course-b-${suffix}`, code: `B${suffix.slice(0, 6)}`.toUpperCase(), name: "Phase 4 Course B", status: "ACTIVE" } })).id;
  await academy.enrollStudentInCourse(contextA, studentAId, courseAId);
  await academy.enrollStudentInCourse(contextA, studentBId, courseAId);
  superToken = (await loginWithPassword(`super-${suffix}@test.invalid`, password, metadata)).accessToken;
  adminToken = (await loginWithPassword(`admin-${suffix}@test.invalid`, password, metadata)).accessToken;
  studentToken = (await loginWithPassword(`student-a-${suffix}@test.invalid`, password, metadata)).accessToken;
});

test("Phase 4 migration ledger, deterministic seed, and operational constraints are present", { skip: !enabled }, async () => {
  const migrations = await prisma.$queryRaw<Array<{ applied: bigint; failed: bigint }>>`
    SELECT COUNT(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)::bigint AS applied,
           COUNT(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL)::bigint AS failed
    FROM "_prisma_migrations"`;
  assert.ok(Number(migrations[0]?.applied) >= 40, "All migrations through direct single-owner Question Bank enforcement must be applied");
  assert.equal(Number(migrations[0]?.failed), 0);
  const roles = await prisma.role.findMany({ where: { key: { in: ["super_admin", "admin", "ACADEMY_ADMIN", "student"] } }, include: { rolePermissions: true } });
  assert.equal(roles.length, 4);
  assert.ok(roles.find((item) => item.key === "super_admin")!.rolePermissions.length > 0);
  const constraints = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM pg_constraint WHERE convalidated = false`;
  assert.equal(Number(constraints[0]?.count), 0);
});

test("authentication persists sessions, rejects failures, and atomically rotates refresh tokens", { skip: !enabled }, async () => {
  const login = await loginWithPassword(`student-b-${suffix}@test.invalid`, password, metadata);
  assert.ok(login.accessToken && login.refreshToken);
  await assert.rejects(() => loginWithPassword(`student-b-${suffix}@test.invalid`, "wrong-password", metadata));
  const failed = await prisma.securityEvent.count({ where: { userId: studentBId, eventType: "LOGIN_FAILED" } });
  assert.ok(failed >= 1);
  const rotations = await Promise.allSettled([rotateRefreshToken(login.refreshToken), rotateRefreshToken(login.refreshToken)]);
  assert.equal(rotations.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(rotations.filter((item) => item.status === "rejected").length, 1);
  await prisma.user.update({ where: { id: studentBId }, data: { status: "DISABLED" } });
  const winner = rotations.find((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof rotateRefreshToken>>> => item.status === "fulfilled")!;
  await assert.rejects(() => rotateRefreshToken(winner.value.refreshToken));
  await prisma.user.update({ where: { id: studentBId }, data: { status: "ACTIVE" } });
  const logoutLogin = await loginWithPassword(`student-b-${suffix}@test.invalid`, password, metadata);
  const server = createApp(getConfig()).listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const sessionUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth`;
  try {
    const headers = { authorization: `Bearer ${logoutLogin.accessToken}`, "content-type": "application/json" };
    assert.equal((await fetch(`${sessionUrl}/session`, { headers })).status, 200);
    const academyAdminSession = await fetch(`${sessionUrl}/session`, { headers: { authorization: `Bearer ${adminToken}` } });
    assert.equal(academyAdminSession.status, 200);
    assert.equal((await academyAdminSession.json()).user.role, "academy_admin", "session restoration must use the same public role vocabulary as login");
    assert.equal((await fetch(`${sessionUrl}/logout`, { method: "POST", headers, body: "{}" })).status, 204);
    assert.equal((await fetch(`${sessionUrl}/session`, { headers })).status, 401);
    await assert.rejects(() => rotateRefreshToken(logoutLogin.refreshToken));
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test("staged mobile registration verifies email before creating a student session", { skip: !enabled }, async () => {
  const server = createApp(getConfig()).listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth`;
  const headers = { "content-type": "application/json", "x-client-platform": "ANDROID", "x-device-name": "Phase 4 Android" };
  const email = `mobile-registration-${suffix}@test.invalid`;
  try {
    const createdResponse = await fetch(`${base}/registrations`, {
      method: "POST", headers,
      body: JSON.stringify({ fullName: "Mobile Registration Student", phone: "+919000000099", email, password }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as { registrationId: string; developmentCode: string };
    assert.match(created.developmentCode, /^\d{4}$/);

    const emailVerification = await fetch(`${base}/registrations/${created.registrationId}/email/verify`, {
      method: "POST", headers, body: JSON.stringify({ code: created.developmentCode }),
    });
    assert.equal(emailVerification.status, 200);

    const completedResponse = await fetch(`${base}/registrations/${created.registrationId}/complete`, { method: "POST", headers, body: "{}" });
    assert.equal(completedResponse.status, 201);
    const completed = await completedResponse.json() as { accessToken: string; user: { id: string; email: string; fullName: string; role: string; permissions: string[] } };
    assert.ok(completed.accessToken);
    assert.equal(completed.user.email, email);
    assert.equal(completed.user.fullName, "Mobile Registration Student");
    assert.equal(completed.user.role, "student");
    assert.ok(Array.isArray(completed.user.permissions));

    const persisted = await prisma.user.findUniqueOrThrow({ where: { email }, include: { passwordCredential: true, sessions: true } });
    assert.equal(persisted.phone, "+919000000099");
    assert.ok(persisted.passwordCredential);
    assert.equal(persisted.sessions.length, 1);
    assert.equal(persisted.sessions[0]!.platform, "ANDROID");
    assert.equal(await prisma.backgroundJob.count({ where: { kind: "ACCOUNT_CREATED_EMAIL", deduplicationKey: persisted.id } }), 1);
    assert.equal((await fetch(`${base}/registrations/${created.registrationId}/complete`, { method: "POST", headers, body: "{}" })).status, 409);
    assert.equal(await prisma.backgroundJob.count({ where: { kind: "ACCOUNT_CREATED_EMAIL", deduplicationKey: persisted.id } }), 1, "Registration retry must not duplicate the welcome event");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("Super Admin academy creation atomically provisions one active Academy Admin identity", { skip: !enabled }, async () => {
  const created = await adminDomains.createAcademy(superId, {
    name: `Provisioned Academy ${suffix}`,
    email: `provisioned-academy-${suffix}@test.invalid`,
    phone: "9000000099",
    address: "Provisioning Road",
    city: "Chennai",
    state: "Tamil Nadu",
    postalCode: "600001",
    adminName: "Provisioned Admin",
    adminEmail: `provisioned-admin-${suffix}@test.invalid`,
  });
  assert.equal(created.academy.status, "ACTIVE");
  assert.ok(created.membershipCreated);

  const administrator = await prisma.user.findUniqueOrThrow({
    where: { email: `provisioned-admin-${suffix}@test.invalid` },
    include: { role: { select: { key: true } }, academyMemberships: true },
  });
  assert.equal(administrator.role.key, "ACADEMY_ADMIN");
  assert.deepEqual(administrator.academyMemberships.map((membership) => ({ academyId: membership.academyId, role: membership.role, status: membership.status })), [
    { academyId: created.academy.id, role: "ACADEMY_ADMIN", status: "ACTIVE" },
  ]);
  const accountEmail = await prisma.backgroundJob.findUniqueOrThrow({ where: { kind_deduplicationKey: { kind: "ACCOUNT_CREATED_EMAIL", deduplicationKey: administrator.id } } });
  assert.equal(accountEmail.academyId, created.academy.id);
  const auditActions = await prisma.systemAuditLog.findMany({ where: { academyId: created.academy.id }, select: { action: true }, orderBy: { occurredAt: "asc" } });
  assert.deepEqual(auditActions.map((entry) => entry.action), ["ACADEMY_CREATED", "ACADEMY_ADMIN_ASSIGNED"]);
  await prisma.passwordCredential.create({ data: { userId: administrator.id, passwordHash: await hashPassword(password) } });
  const adminLogin = await loginWithPassword(administrator.email, password, metadata);
  assert.equal(adminLogin.user.role, "academy_admin");

  const server = createApp(getConfig()).listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const headers = { authorization: `Bearer ${adminLogin.accessToken}`, "content-type": "application/json" };
    const context = await fetch(`${base}/api/academy/context`, { headers });
    assert.equal(context.status, 200);
    assert.deepEqual(await context.json(), { academyId: created.academy.id, roleInAcademy: "ACADEMY_ADMIN", membershipId: created.membershipId, permissions: ["academy:manage", "academy:read"] });
    assert.equal((await fetch(`${base}/api/admin/packages`, { headers })).status, 403);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  const reassignedEmail = `reassigned-admin-${suffix}@test.invalid`;
  const updatedAcademy = await adminDomains.updateAcademy(superId, created.academy.id, {
    adminName: "Reassigned Admin",
    adminEmail: reassignedEmail,
    adminPhone: "9000000077",
  });
  assert.equal(updatedAcademy.adminEmail, reassignedEmail);
  const oldMembership = await prisma.academyMembership.findUniqueOrThrow({ where: { userId_academyId: { userId: administrator.id, academyId: created.academy.id } } });
  const reassignedAdministrator = await prisma.user.findUniqueOrThrow({ where: { email: reassignedEmail }, include: { academyMemberships: true, role: true } });
  assert.equal(oldMembership.status, "REVOKED", "Replacing the primary administrator must revoke the previous tenant membership");
  assert.equal(reassignedAdministrator.role.key, "ACADEMY_ADMIN");
  assert.deepEqual(reassignedAdministrator.academyMemberships.map((membership) => ({ academyId: membership.academyId, role: membership.role, status: membership.status })), [
    { academyId: created.academy.id, role: "ACADEMY_ADMIN", status: "ACTIVE" },
  ]);

  await assert.rejects(
    () => adminDomains.createAcademy(superId, {
      name: `Rollback Academy ${suffix}`,
      email: `rollback-academy-${suffix}@test.invalid`,
      phone: "9000000098",
      address: "Rollback Road",
      city: "Chennai",
      state: "Tamil Nadu",
      postalCode: "600001",
      adminName: "Provisioned Admin",
      adminEmail: reassignedEmail,
    }),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "ADMIN_IDENTITY_CONFLICT"),
  );
  assert.equal(await prisma.academy.count({ where: { email: `rollback-academy-${suffix}@test.invalid` } }), 0);
});

test("global Super Admin academic APIs expose only direct Parallax Flow data", { skip: !enabled }, async () => {
  const studentRole = await prisma.role.findUniqueOrThrow({ where: { key: "student" } });
  const platformStudent = await prisma.user.create({ data: {
    id: randomUUID(), email: `platform-student-${suffix}@test.invalid`, fullName: "Platform Student", roleId: studentRole.id,
  } });
  const platformCourse = await prisma.course.create({ data: {
    academyId: null, slug: `platform-course-${suffix}`, code: `P${suffix.slice(0, 6)}`.toUpperCase(), name: `Platform Course ${suffix}`, status: "ACTIVE",
  } });
  const platformContent = await content.createFolder({ academyId: null, actorId: superId }, { courseId: platformCourse.id, name: `Platform Folder ${suffix}` }) as unknown as { id: string };
  const academyContent = await prisma.contentItem.create({ data: { courseId: courseAId, kind: "FOLDER", name: `Academy Folder ${suffix}` } });
  const platformQuestion = await questions.createQuestion({ actorId: superId }, {
    kind: "NORMAL_DESCRIPTIVE", courseId: platformCourse.id, questionHtml: "Explain platform-only ownership.", answerHtml: "Platform-only ownership.",
  });
  const platformBroadcast = await prisma.broadcast.create({ data: { academyId: null, title: `Platform Broadcast ${suffix}`, message: "Platform-only broadcast." } });
  const academyBroadcast = await prisma.broadcast.create({ data: { academyId: academyAId, title: `Academy Broadcast ${suffix}`, message: "Academy-only broadcast." } });

  const students = await admin.listAdminUsers({ page: 1, limit: 100 });
  assert.ok(students.data.some((row) => row.id === platformStudent.id));
  assert.ok(!students.data.some((row) => row.id === studentAId));
  await expectCode(() => admin.getAdminUser(studentAId), "USER_NOT_FOUND");

  const courses = await adminCourses.listAdminCourses({ page: 1, limit: 100 });
  assert.ok(courses.data.some((row) => row.id === platformCourse.id));
  assert.ok(!courses.data.some((row) => row.id === courseAId));
  await expectCode(() => adminCourses.getAdminCourse(courseAId), "COURSE_NOT_FOUND");

  const contentRows = await content.listContent({ academyId: null, actorId: superId }, { courseId: platformCourse.id, page: 1, limit: 100 });
  assert.ok((contentRows.data as unknown as Array<{ id: string }>).some((row) => row.id === platformContent.id));
  await expectCode(() => content.getContent({ academyId: null, actorId: superId }, academyContent.id), "CONTENT_NOT_FOUND");

  const questionsRows = await questions.listQuestions({ actorId: superId }, { page: 1, limit: 100 });
  assert.ok(questionsRows.data.some((row) => row.id === platformQuestion.id));
  assert.ok(!questionsRows.data.some((row) => row.academyId === academyAId));

  const broadcasts = await adminBroadcasts.listBroadcasts({ page: 1, limit: 100 });
  assert.ok(broadcasts.data.some((row) => row.id === platformBroadcast.id));
  assert.ok(!broadcasts.data.some((row) => row.id === academyBroadcast.id));

  const server = createApp(getConfig()).listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { authorization: `Bearer ${superToken}` };
  try {
    const studentsResponse = await fetch(`${base}/api/admin/students?limit=100`, { headers });
    assert.equal(studentsResponse.status, 200);
    const studentsBody = await studentsResponse.json() as { data: Array<{ id: string }> };
    assert.ok(studentsBody.data.some((row) => row.id === platformStudent.id));
    assert.ok(!studentsBody.data.some((row) => row.id === studentAId));
    const coursesResponse = await fetch(`${base}/api/admin/courses?limit=100`, { headers });
    const coursesBody = await coursesResponse.json() as { data: Array<{ id: string }> };
    assert.ok(coursesBody.data.some((row) => row.id === platformCourse.id));
    assert.ok(!coursesBody.data.some((row) => row.id === courseAId));
    assert.equal((await fetch(`${base}/api/admin/content?courseId=${platformCourse.id}`, { headers })).status, 200);
    assert.equal((await fetch(`${base}/api/admin/questions?limit=100`, { headers })).status, 200);
    const broadcastsResponse = await fetch(`${base}/api/admin/broadcasts?limit=100`, { headers });
    const broadcastsBody = await broadcastsResponse.json() as { data: Array<{ id: string }> };
    assert.ok(broadcastsBody.data.some((row) => row.id === platformBroadcast.id));
    assert.ok(!broadcastsBody.data.some((row) => row.id === academyBroadcast.id));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("HTTP RBAC, single-tenant Academy Admin scope, IDOR, and commercial boundaries fail closed", { skip: !enabled }, async () => {
  const foreignQuestion = await questions.createQuestion({ academyId: academyBId, actorId: adminAId }, { kind: "NORMAL_DESCRIPTIVE", courseId: courseBId, questionHtml: "Academy B only" });
  const foreignBroadcast = await academy.createAcademyBroadcast(contextB, { title: "Academy B only", message: "Private Academy B announcement" });
  const server = createApp(getConfig()).listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, token: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  try {
    assert.equal((await call("/api/admin/overview", superToken)).status, 200);
    assert.equal((await call("/api/admin/overview", adminToken)).status, 403);
    assert.equal((await call("/api/academy/overview", adminToken)).status, 200);
    assert.equal((await call("/api/academy/overview", adminToken, { headers: { "x-academy-id": academyAId } })).status, 200);
    assert.equal((await call("/api/academy/overview", studentToken)).status, 403);
    assert.equal((await call("/api/academy/questions", studentToken)).status, 403);
    assert.equal((await call("/api/academy/broadcasts", studentToken)).status, 403);
    const bootstrapResponse = await call("/api/student/bootstrap", studentToken);
    assert.equal(bootstrapResponse.status, 200);
    const bootstrap = await bootstrapResponse.json() as {
      user: { id: string; role: string };
      session: { id: string; platform: string };
      memberships: Array<{ academyId: string }>;
      activeAcademy: { id: string } | null;
      accessSummary: { planLabel: string; activeEntitlementCount: number };
    };
    assert.equal(bootstrap.user.id, studentAId);
    assert.equal(bootstrap.user.role, "student");
    assert.ok(bootstrap.session.id);
    assert.equal(bootstrap.session.platform, "UNKNOWN");
    assert.ok(bootstrap.memberships.some((membership) => membership.academyId === academyAId));
    assert.ok(bootstrap.activeAcademy === null || bootstrap.activeAcademy.id === academyAId);
    assert.equal(bootstrap.accessSummary.planLabel, "FREE");
    assert.equal(bootstrap.accessSummary.activeEntitlementCount, 0);
    assert.equal((await fetch(`${base}/api/academy/questions`)).status, 401);
    assert.equal((await fetch(`${base}/api/academy/broadcasts`)).status, 401);
    await prisma.academyMembership.update({ where: { userId_academyId: { userId: studentAId, academyId: academyAId } }, data: { role: "ACADEMY_ADMIN" } });
    assert.equal((await call("/api/academy/overview", studentToken)).status, 403, "A Student platform identity must not become Academy Admin through membership spoofing");
    await prisma.academyMembership.update({ where: { userId_academyId: { userId: studentAId, academyId: academyAId } }, data: { role: "ACADEMY_STUDENT" } });
    assert.equal((await call("/api/academy/overview", adminToken, { headers: { "x-academy-id": academyBId } })).status, 403);
    assert.equal((await call("/api/academy/admissions", adminToken)).status, 200);
    assert.equal((await call("/api/academy/admissions", studentToken)).status, 403);
    assert.equal((await call("/api/academy/admissions/qr", adminToken, { method: "POST", body: JSON.stringify({ academyId: academyBId }) })).status, 403, "Cross-Academy QR generation forgery must fail closed");
    assert.equal((await call("/api/academy/admissions/code", adminToken, { method: "POST", body: JSON.stringify({ academyId: academyBId, maxUses: 1, expiresAt: null }) })).status, 403, "Cross-Academy code generation forgery must fail closed");
    assert.equal((await call("/api/student/admissions/codes/claim", studentToken, { method: "POST", body: JSON.stringify({ code: "ABCDEFGH", academyId: academyBId }) })).status, 422, "Students must not mass-assign Academy identity during code claims");
    assert.equal((await call("/api/academy/admissions/qr", superToken, { method: "POST", body: "{}" })).status, 409, "Super Admin must not receive an implicit Academy tenant context");
    assert.equal((await call("/api/academy/admissions/qr", superToken, { method: "POST", headers: { "x-academy-id": academyAId }, body: "{}" })).status, 403, "Super Admin must remain read-only even when an Academy header is supplied");
    assert.equal((await call("/api/academy/settings", adminToken)).status, 200, "Academy Admin must be able to load the finalized settings module");
    assert.equal((await call("/api/academy/settings", superToken, { headers: { "x-academy-id": academyAId } })).status, 403, "Super Admin must not mutate or enter Academy operational settings");
    for (const removedPath of ["/api/academy/analytics", "/api/academy/notifications"]) {
      assert.equal((await call(removedPath, adminToken)).status, 404, `${removedPath} must not be exposed to Academy Admin`);
    }
    for (const commercialPath of ["/api/admin/packages", "/api/admin/orders", "/api/admin/coupons", "/api/admin/store-management"]) {
      assert.equal((await call(commercialPath, adminToken)).status, 403, `${commercialPath} must remain Super Admin only`);
    }
    assert.equal((await call("/api/admin/packages", superToken)).status, 200);
    assert.equal((await call("/api/academy/broadcasts", adminToken, { method: "POST", body: JSON.stringify({ title: "Store sale", message: "Buy now", type: "STORE" }) })).status, 422);
    assert.equal((await call("/api/academy/broadcasts", adminToken, { method: "POST", body: JSON.stringify({ title: "Forged Academy", message: "Denied", academyId: academyBId }) })).status, 403);
    assert.equal((await call("/api/academy/questions", adminToken, { method: "POST", body: JSON.stringify({ kind: "NORMAL_DESCRIPTIVE", questionHtml: "Forged", academyId: academyBId }) })).status, 403);
    assert.equal((await call("/api/academy/questions", adminToken, { method: "POST", body: JSON.stringify({ kind: "NORMAL_DESCRIPTIVE", questionHtml: "Foreign course", courseId: courseBId }) })).status, 404);
    assert.equal((await call("/api/academy/broadcasts", adminToken, { method: "POST", body: JSON.stringify({ title: "Foreign course", message: "Denied", targetCourseId: courseBId }) })).status, 404);
    assert.equal((await call(`/api/academy/questions/${foreignQuestion.id}`, adminToken)).status, 404);
    assert.equal((await call(`/api/academy/questions/${foreignQuestion.id}`, adminToken, { method: "PUT", body: JSON.stringify({ kind: "NORMAL_DESCRIPTIVE", questionHtml: "Tampered" }) })).status, 404);
    assert.equal((await call(`/api/academy/broadcasts/${foreignBroadcast.id}`, adminToken)).status, 404);
    assert.equal((await call(`/api/academy/broadcasts/${foreignBroadcast.id}`, adminToken, { method: "PATCH", body: JSON.stringify({ title: "Tampered" }) })).status, 404);
    assert.equal((await call("/api/academy/questions?limit=101", adminToken)).status, 422);
    assert.equal((await call("/api/academy/broadcasts?limit=101", adminToken)).status, 422);
    const fakeContentId = randomUUID();
    assert.equal((await call(`/api/academy/content/${fakeContentId}`, adminToken, { method: "PATCH", body: JSON.stringify({ accessType: "PAID", price: 999 }) })).status, 422);
    assert.equal((await call(`/api/academy/content/${fakeContentId}/store-sections`, adminToken, { method: "POST", body: JSON.stringify({ heading: "Store", content: "Sale" }) })).status, 404);
    const academyFolderResponse = await call("/api/academy/content/folders", adminToken, { method: "POST", body: JSON.stringify({ courseId: courseAId, parentId: null, name: `HTTP Academy Folder ${suffix}` }) });
    assert.equal(academyFolderResponse.status, 201);
    const academyFolder = await academyFolderResponse.json() as { id: string };
    assert.equal((await call("/api/academy/content/display-orders", adminToken, { method: "PATCH", body: JSON.stringify({ courseId: courseAId, folderId: null, itemIds: [academyFolder.id] }) })).status, 200, "The static display-order route must remain reachable before /:contentId");
    assert.equal((await call("/api/academy/content/display-orders", adminToken, { method: "PATCH", body: JSON.stringify({ courseId: courseBId, folderId: null, itemIds: [academyFolder.id] }) })).status, 404, "Academy A must not order Academy B content");
    assert.equal((await call(`/api/academy/content?courseId=${courseBId}`, adminToken)).status, 404, "Academy A must not list Academy B content");
    const unchanged = await prisma.academy.findUniqueOrThrow({ where: { id: academyAId } });
    assert.equal(unchanged.status, "ACTIVE"); assert.equal(Number(unchanged.revenue), 0);
    assert.equal((await call(`/api/academy/courses/${courseBId}`, adminToken)).status, 404);
    await prisma.academyMembership.create({ data: { academyId: academyBId, userId: adminAId, role: "ACADEMY_ADMIN", status: "ACTIVE" } });
    assert.equal((await call("/api/academy/overview", adminToken)).status, 409);
    assert.equal((await call("/api/academy/overview", adminToken, { headers: { "x-academy-id": academyAId } })).status, 409);
    await prisma.academyMembership.delete({ where: { userId_academyId: { userId: adminAId, academyId: academyBId } } });
    const adminRole = await prisma.role.findUniqueOrThrow({ where: { key: "admin" } });
    const superRole = await prisma.role.findUniqueOrThrow({ where: { key: "super_admin" } });
    await prisma.user.update({ where: { id: superId }, data: { roleId: adminRole.id } });
    assert.equal((await call("/api/admin/overview", superToken)).status, 403);
    await prisma.user.update({ where: { id: superId }, data: { roleId: superRole.id } });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("learner personalisation is tenant-visible, month-normalized, versioned, and included in bootstrap", { skip: !enabled }, async () => {
  const platformCourse = await prisma.course.create({ data: {
    academyId: null,
    slug: `learner-preference-${suffix}`,
    code: `LP${suffix.slice(0, 6)}`.toUpperCase(),
    name: `Learner Preference ${suffix}`,
    status: "ACTIVE",
  } });
  const server = createApp(getConfig()).listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${studentToken}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  const examYear = new Date().getUTCFullYear() + 1;
  try {
    const optionsResponse = await call("/api/student/preferences/options");
    assert.equal(optionsResponse.status, 200);
    const options = await optionsResponse.json() as { courses: Array<{ id: string }> };
    assert.ok(options.courses.some((course) => course.id === platformCourse.id));
    assert.ok(options.courses.some((course) => course.id === courseAId));
    assert.ok(!options.courses.some((course) => course.id === courseBId), "Foreign Academy courses must not be selectable");

    const putResponse = await call("/api/student/preferences", {
      method: "PUT",
      body: JSON.stringify({ selectedCourseId: platformCourse.id, examMonth: 9, examYear, dailyTargetMinutes: 120, timezone: "Asia/Kolkata", language: "English", reminderTime: "19:00" }),
    });
    assert.equal(putResponse.status, 200);
    const preference = await putResponse.json() as { selectedCourseId: string; examDate: string; examDatePrecision: string; dailyTargetMinutes: number; version: number };
    assert.equal(preference.selectedCourseId, platformCourse.id);
    assert.equal(preference.examDatePrecision, "MONTH");
    assert.equal(new Date(preference.examDate).getUTCDate(), 1, "Missing exam day must normalize to the first of the month");
    assert.equal(await prisma.academyCourseEnrollment.count({ where: { studentId: studentAId, courseId: platformCourse.id } }), 0, "Preference selection must not enroll or unlock a course");

    const patchResponse = await call("/api/student/preferences", { method: "PATCH", body: JSON.stringify({ dailyTargetMinutes: 150, expectedVersion: preference.version }) });
    assert.equal(patchResponse.status, 200);
    const patched = await patchResponse.json() as { dailyTargetMinutes: number; version: number };
    assert.equal(patched.dailyTargetMinutes, 150);
    assert.equal(patched.version, preference.version + 1);
    assert.equal((await call("/api/student/preferences", { method: "PATCH", body: JSON.stringify({ dailyTargetMinutes: 180, expectedVersion: preference.version }) })).status, 409);
    assert.equal((await call("/api/student/preferences", { method: "PUT", body: JSON.stringify({ selectedCourseId: courseBId, examMonth: 9, examYear, dailyTargetMinutes: 120, timezone: "Asia/Kolkata" }) })).status, 404);

    const bootstrapResponse = await call("/api/student/bootstrap");
    assert.equal(bootstrapResponse.status, 200);
    const bootstrap = await bootstrapResponse.json() as { preference: { selectedCourseId: string; dailyTargetMinutes: number } | null };
    assert.equal(bootstrap.preference?.selectedCourseId, platformCourse.id);
    assert.equal(bootstrap.preference?.dailyTargetMinutes, 150);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("Academy course lifecycle fields and student filters remain tenant-scoped", { skip: !enabled }, async () => {
  const created = await academy.createAcademyCourse(contextA, {
    name: `Lifecycle ${suffix}`,
    code: `L${suffix.slice(0, 6)}`,
    status: "INACTIVE",
  });
  assert.equal(created.academyId, academyAId);
  assert.equal(created.status, "INACTIVE");
  assert.equal(created.deletedAt, null);

  const archived = await academy.updateAcademyCourse(contextA, created.id, { status: "ARCHIVED" });
  assert.equal(archived.status, "ARCHIVED");
  assert.ok(archived.deletedAt);
  await expectCode(() => academy.updateAcademyCourse(contextB, created.id, { status: "ACTIVE" }), "COURSE_NOT_FOUND");

  const restored = await academy.updateAcademyCourse(contextA, created.id, { status: "ACTIVE" });
  assert.equal(restored.status, "ACTIVE");
  assert.equal(restored.deletedAt, null);

  const activeStudents = await academy.getAcademyStudents(contextA, { page: 1, limit: 25, accountStatus: "ACTIVE" });
  assert.ok(activeStudents.data.length > 0);
  assert.ok(activeStudents.data.every((student) => student.accountStatus === "ACTIVE"));
  assert.ok(activeStudents.data.every((student) => "lastLoginAt" in student));
});

test("admission-code final-capacity concurrency admits exactly one student", { skip: !enabled }, async () => {
  const code = await admissions.createAdmissionCode(contextA, { maxUses: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const extraA = randomUUID(), extraB = randomUUID();
  const studentRole = await prisma.role.findUniqueOrThrow({ where: { key: "student" } });
  await prisma.user.createMany({ data: [
    { id: extraA, email: `capacity-a-${suffix}@test.invalid`, fullName: "Capacity A", roleId: studentRole.id },
    { id: extraB, email: `capacity-b-${suffix}@test.invalid`, fullName: "Capacity B", roleId: studentRole.id },
  ] });
  const attempts = await Promise.allSettled([admissions.claimAdmissionCode(extraA, code.code), admissions.claimAdmissionCode(extraB, code.code)]);
  assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
  const persisted = await prisma.admissionCode.findUniqueOrThrow({ where: { id: code.id } });
  assert.equal(persisted.currentUses, 1);
  assert.equal(await prisma.academyMembership.count({ where: { academyId: academyAId, userId: { in: [extraA, extraB] } } }), 1);
  const rollbackCode = await admissions.createAdmissionCode(contextA, { maxUses: 2, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  await expectCode(() => admissions.claimAdmissionCode(randomUUID(), rollbackCode.code), "STUDENT_NOT_FOUND");
  assert.equal((await prisma.admissionCode.findUniqueOrThrow({ where: { id: rollbackCode.id } })).currentUses, 0);
});

test("unlimited admission codes resolve Academy ownership and preserve Academy-owned history", { skip: !enabled }, async () => {
  const codeA = await admissions.createAdmissionCode(contextA, { maxUses: null, expiresAt: null });
  const codeB = await admissions.createAdmissionCode(contextB, { maxUses: null, expiresAt: null });
  assert.notEqual(codeA.code, codeB.code);
  const studentRole = await prisma.role.findUniqueOrThrow({ where: { key: "student" } });
  const claimants = [randomUUID(), randomUUID()];
  await prisma.user.createMany({ data: claimants.map((id, index) => ({ id, email: `unlimited-${index}-${suffix}@test.invalid`, fullName: `Unlimited ${index}`, roleId: studentRole.id })) });
  const results = await Promise.all(claimants.map((id) => admissions.claimAdmissionCode(id, codeA.code)));
  assert.ok(results.every((result) => result.status === "SUCCESS" && result.academyId === academyAId));
  assert.equal(await prisma.academyMembership.count({ where: { academyId: academyAId, userId: { in: claimants } } }), 2);
  assert.equal(await prisma.academyMembership.count({ where: { academyId: academyBId, userId: { in: claimants } } }), 0);
  assert.equal(await prisma.admissionRecord.count({ where: { academyId: academyAId, codeId: codeA.id, studentId: { in: claimants }, status: "SUCCESS" } }), 2);
  assert.equal(await prisma.admissionRecord.count({ where: { academyId: academyBId, codeId: codeA.id } }), 0);
  const persisted = await prisma.admissionCode.findUniqueOrThrow({ where: { id: codeA.id } });
  assert.equal(persisted.currentUses, 2);
  assert.equal(persisted.status, "ACTIVE");
});

test("content/storage lifecycle verifies metadata, ownership, hierarchy, copies, and signed access", { skip: !enabled }, async () => {
  await content.updateLocation({ academyId: academyAId, actorId: adminAId }, courseAId, null, "Phase 4 Study Materials");
  if (getConfig().storage.driver !== "s3") {
    await expectCode(() => content.createUploadIntent({ academyId: academyAId, actorId: adminAId }, { courseId: courseAId, fileName: "disabled.pdf", mimeType: "application/pdf", sizeBytes: 10, checksumSha256: "d".repeat(64) }), "STORAGE_PROVIDER_NOT_CONFIGURED");
  }
  const objects = new Map<string, { sizeBytes: number; mimeType: string; checksumSha256: string }>();
  const storage: StorageProvider = {
    async createUploadUrl(intent: UploadIntent) { objects.set(intent.objectKey, { sizeBytes: intent.sizeBytes, mimeType: intent.mimeType, checksumSha256: intent.checksumSha256 }); return { uploadUrl: `https://storage.test/upload/${encodeURIComponent(intent.objectKey)}`, expiresAt: new Date(Date.now() + 60_000), headers: { "content-type": intent.mimeType } }; },
    async createDownloadUrl(key) { return `https://storage.test/download/${encodeURIComponent(key)}`; },
    async statObject(key) { const value = objects.get(key); if (!value) throw new Error("OBJECT_MISSING"); return value; },
    async deleteObject(key) { objects.delete(key); },
    async copyObject(source, destination) { const value = objects.get(source); if (!value) throw new Error("OBJECT_MISSING"); objects.set(destination, value); },
    async putObject(key, body, mimeType, checksumSha256) { objects.set(key, { sizeBytes: body.byteLength, mimeType, checksumSha256 }); },
  };
  providerTestHooks.setStorage(storage);
  try {
    const folder = await content.createFolder({ academyId: academyAId, actorId: adminAId }, { courseId: courseAId, name: "Phase 4 Folder" }) as unknown as { id: string };
    const checksum = "a".repeat(64);
    const intent = await content.createUploadIntent({ academyId: academyAId, actorId: adminAId }, { courseId: courseAId, parentId: folder.id, fileName: "phase4.pdf", mimeType: "application/pdf", sizeBytes: 1234, checksumSha256: checksum });
    const item = await content.finalizeUpload({ academyId: academyAId, actorId: adminAId }, intent.uploadId, { parentId: folder.id, entityType: "STUDY_MATERIAL", accessType: "FREE" }) as unknown as { id: string; name: string };
    assert.equal(item.name, "phase4.pdf");
    assert.equal((await content.getContentAccessUrl({ academyId: academyAId, actorId: adminAId }, item.id, "download")).expiresIn, 300);
    await expectCode(() => content.getContent({ academyId: academyBId, actorId: adminAId }, item.id), "CONTENT_NOT_FOUND");
    const copied = await content.copyContent({ academyId: academyAId, actorId: adminAId }, item.id, null);
    assert.ok("id" in copied);
    await content.archiveContent({ academyId: academyAId, actorId: adminAId }, item.id);
    await content.archiveContent({ academyId: academyAId, actorId: adminAId }, item.id, true);
    assert.equal((await content.getContentAccessUrl({ academyId: academyAId, actorId: adminAId }, item.id, "download")).expiresIn, 300);
    await content.archiveContent({ academyId: academyAId, actorId: adminAId }, folder.id);
    await expectCode(() => content.getContent({ academyId: academyAId, actorId: adminAId }, item.id), "CONTENT_NOT_FOUND");
    await content.archiveContent({ academyId: academyAId, actorId: adminAId }, folder.id, true);
    const restoredItem = await content.getContent({ academyId: academyAId, actorId: adminAId }, item.id) as unknown as { name: string };
    assert.equal(restoredItem.name, "phase4.pdf");
    const mismatch = await content.createUploadIntent({ academyId: academyAId, actorId: adminAId }, { courseId: courseAId, fileName: "mismatch.pdf", mimeType: "application/pdf", sizeBytes: 10, checksumSha256: "b".repeat(64) });
    objects.set(mismatch.objectKey, { sizeBytes: 11, mimeType: "application/pdf", checksumSha256: "b".repeat(64) });
    await expectCode(() => content.finalizeUpload({ academyId: academyAId, actorId: adminAId }, mismatch.uploadId, {}), "UPLOAD_VERIFICATION_FAILED");

    const proxyBytes = Buffer.from("verified Academy proxy upload");
    const proxyChecksum = createHash("sha256").update(proxyBytes).digest("hex");
    const proxyIntent = await content.createUploadIntent({ academyId: academyAId, actorId: adminAId }, {
      courseId: courseAId,
      fileName: "proxy-verified.txt",
      mimeType: "text/plain",
      sizeBytes: proxyBytes.byteLength,
      checksumSha256: proxyChecksum,
    });
    await expectCode(
      () => content.uploadProxy({ academyId: academyAId, actorId: adminAId }, proxyIntent.uploadId, Buffer.from("wrong size")),
      "UPLOAD_SIZE_MISMATCH",
    );
    const wrongChecksum = Buffer.alloc(proxyBytes.byteLength, 1);
    await expectCode(
      () => content.uploadProxy({ academyId: academyAId, actorId: adminAId }, proxyIntent.uploadId, wrongChecksum),
      "UPLOAD_CHECKSUM_MISMATCH",
    );
    await expectCode(
      () => content.uploadProxy({ academyId: academyBId, actorId: adminAId }, proxyIntent.uploadId, proxyBytes),
      "UPLOAD_NOT_FOUND",
    );
    await content.uploadProxy({ academyId: academyAId, actorId: adminAId }, proxyIntent.uploadId, proxyBytes);
    const proxyItem = await content.finalizeUpload({ academyId: academyAId, actorId: adminAId }, proxyIntent.uploadId, {});
    assert.equal(proxyItem.name, "proxy-verified.txt");
  } finally { providerTestHooks.reset(); }
});

test("protected note viewing watermarks content, binds sessions, tracks progress, and exposes no raw storage URL", { skip: !enabled }, async () => {
  await selectCourseForStudent(studentAId, courseAId);
  const sourceDocument = await PDFDocument.create();
  sourceDocument.addPage([420, 595]);
  sourceDocument.addPage([420, 595]);
  const sourceBytes = Buffer.from(await sourceDocument.save());
  const storagePath = `phase4/protected-${suffix}.pdf`;
  const note = await prisma.contentItem.create({ data: {
    courseId: courseAId,
    kind: "FILE",
    name: `Protected ${suffix}.pdf`,
    mimeType: "application/pdf",
    size: BigInt(sourceBytes.length),
    storagePath,
    entityType: "STUDY_MATERIAL",
    accessType: "FREE",
    status: "PUBLISHED",
  } });
  const lockedNote = await prisma.contentItem.create({ data: {
    courseId: courseAId,
    kind: "FILE",
    name: `Locked ${suffix}.pdf`,
    mimeType: "application/pdf",
    size: BigInt(sourceBytes.length),
    storagePath: `phase4/locked-${suffix}.pdf`,
    entityType: "STUDY_MATERIAL",
    accessType: "PAID",
    price: "499.00",
    status: "PUBLISHED",
  } });
  const storage: StorageProvider = {
    async createUploadUrl(intent: UploadIntent) { return { uploadUrl: "https://storage.test/upload", expiresAt: new Date(Date.now() + 60_000), headers: { "content-type": intent.mimeType } }; },
    async createDownloadUrl(key) { assert.equal(key, storagePath); return `data:application/pdf;base64,${sourceBytes.toString("base64")}`; },
    async statObject() { return { sizeBytes: sourceBytes.length, mimeType: "application/pdf" }; },
    async deleteObject() {},
    async copyObject() {},
  };
  providerTestHooks.setStorage(storage);
  const outsiderToken = (await loginWithPassword(`outsider-${suffix}@test.invalid`, password, metadata)).accessToken;
  const server = createApp(getConfig()).listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, token: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  try {
    const notesResponse = await call("/api/student/notes?status=all", studentToken);
    assert.equal(notesResponse.status, 200);
    const notes = await notesResponse.json() as { items: Array<{ id: string; access: { accessible: boolean; reason: string } }> };
    assert.equal(notes.items.find((item) => item.id === lockedNote.id)?.access.reason, "PURCHASE_REQUIRED");
    assert.equal((await call(`/api/student/notes/${lockedNote.id}/viewer-sessions`, studentToken, { method: "POST", body: "{}" })).status, 403);

    const favouriteResponse = await call(`/api/student/notes/${lockedNote.id}/state`, studentToken, { method: "PATCH", body: JSON.stringify({ favourite: true, completed: true }) });
    assert.equal(favouriteResponse.status, 200, "Locked note metadata actions must remain available without granting access");
    const favourite = await favouriteResponse.json() as { favourite: boolean; completed: boolean };
    assert.deepEqual({ favourite: favourite.favourite, completed: favourite.completed }, { favourite: true, completed: true });
    const revisionResponse = await call(`/api/student/notes/${lockedNote.id}/revisions`, studentToken, { method: "POST", body: JSON.stringify({ source: "ACTION_SHEET" }) });
    assert.equal(revisionResponse.status, 201);
    assert.equal((await revisionResponse.json() as { state: { revisionCount: number } }).state.revisionCount, 1);
    const favouritesResponse = await call("/api/student/notes/favourites", studentToken);
    assert.equal(favouritesResponse.status, 200);
    assert.ok((await favouritesResponse.json() as { items: Array<{ id: string }> }).items.some((item) => item.id === lockedNote.id));

    assert.equal((await call(`/api/student/content/${note.id}/access`, studentToken)).status, 404, "The raw signed-URL endpoint must remain removed");
    const createdResponse = await call(`/api/student/notes/${note.id}/viewer-sessions`, studentToken, { method: "POST", body: "{}" });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as { viewerSessionId: string; contentUrl: string; manifestUrl: string; url?: string };
    assert.equal(created.url, undefined);
    assert.ok(created.contentUrl.startsWith("/api/protected-viewer/"));

    const manifestResponse = await call(created.manifestUrl, studentToken);
    assert.equal(manifestResponse.status, 200);
    const manifest = await manifestResponse.json() as { watermark: { displayIdentity: string; traceId: string }; capabilities: { download: boolean; print: boolean } };
    assert.equal(manifest.watermark.displayIdentity, `student-a-${suffix}@test.invalid`);
    assert.match(manifest.watermark.traceId, /^[0-9a-f]{24}$/);
    assert.deepEqual({ download: manifest.capabilities.download, print: manifest.capabilities.print }, { download: false, print: false });
    assert.equal((await call(created.manifestUrl, outsiderToken)).status, 404, "A different authenticated user must not reuse the viewer session");

    const contentResponse = await fetch(`${base}${created.contentUrl}`);
    assert.equal(contentResponse.status, 200);
    assert.match(contentResponse.headers.get("cache-control") ?? "", /no-store/);
    assert.doesNotMatch(contentResponse.headers.get("content-disposition") ?? "", /attachment/i);
    const protectedBytes = Buffer.from(await contentResponse.arrayBuffer());
    assert.notEqual(createHash("sha256").update(protectedBytes).digest("hex"), createHash("sha256").update(sourceBytes).digest("hex"));
    assert.equal((await PDFDocument.load(protectedBytes)).getPageCount(), 2);

    const rangeResponse = await fetch(`${base}${created.contentUrl}`, { headers: { range: "bytes=0-19" } });
    assert.equal(rangeResponse.status, 206);
    assert.equal((await rangeResponse.arrayBuffer()).byteLength, 20);
    assert.match(rangeResponse.headers.get("content-range") ?? "", /^bytes 0-19\//);
    const tamperedContentUrl = created.contentUrl.replace(/ticket=([a-f0-9])/, (_match, first: string) => `ticket=${first === "a" ? "b" : "a"}`);
    assert.equal((await fetch(`${base}${tamperedContentUrl}`)).status, 404, "A modified viewer ticket must not expose content");

    const firstProgress = await call(`/api/student/viewer-sessions/${created.viewerSessionId}/progress`, studentToken, { method: "PATCH", body: JSON.stringify({ currentPage: 2, progressPercent: 55, scrollOffset: 400 }) });
    assert.equal(firstProgress.status, 200);
    const lowerProgress = await call(`/api/student/viewer-sessions/${created.viewerSessionId}/progress`, studentToken, { method: "PATCH", body: JSON.stringify({ currentPage: 1, progressPercent: 10 }) });
    assert.equal(lowerProgress.status, 200);
    assert.equal((await lowerProgress.json() as { progressPercent: number }).progressPercent, 55);
    const learnerState = await prisma.learnerNoteState.findUniqueOrThrow({ where: { userId_contentItemId: { userId: studentAId, contentItemId: note.id } } });
    assert.ok(learnerState.firstOpenedAt && learnerState.lastOpenedAt);
    assert.equal(learnerState.progressPercent, 55, "Reader progress must be synchronized to learner note state without regressing");
    const recentResponse = await call("/api/student/notes/recent?limit=3", studentToken);
    assert.equal(recentResponse.status, 200);
    assert.equal((await recentResponse.json() as { items: Array<{ id: string }> }).items[0]?.id, note.id);

    assert.equal((await call(`/api/student/viewer-sessions/${created.viewerSessionId}`, studentToken, { method: "DELETE" })).status, 204);
    assert.equal((await call(created.manifestUrl, studentToken)).status, 403);
  } finally {
    providerTestHooks.reset();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("question and taxonomy lifecycle is tenant-scoped and sanitizes persisted rich text", { skip: !enabled }, async () => {
  const scope = { academyId: academyAId, actorId: adminAId };
  const subject = await questions.createTaxonomyNode(scope, { kind: "subject", parentId: courseAId, courseId: courseAId, name: "Mathematics" });
  const chapter = await questions.createTaxonomyNode(scope, { kind: "chapter", parentId: subject.id, courseId: courseAId, name: "Algebra" });
  const linkedFile = await prisma.contentItem.create({ data: { courseId: courseAId, kind: "FILE", name: `Question lifecycle ${suffix}.pdf`, mimeType: "application/pdf", storagePath: `integration/questions/lifecycle-${suffix}.pdf`, accessType: "FREE", status: "PUBLISHED" } });
  const created = await questions.createQuestion(scope, { kind: "NORMAL_MCQ", courseId: courseAId, subjectId: subject.id, chapterId: chapter.id, contentItemIds: [linkedFile.id], questionHtml: '<p>2 + 2?</p><script>alert(1)</script>', correctOptionId: "B", options: [{ optionLabel: "A", html: "3" }, { optionLabel: "B", html: "4" }] });
  assert.doesNotMatch(created.questionHtml, /script|alert/i);
  const persisted = await prisma.question.findUniqueOrThrow({ where: { id: created.id } });
  assert.equal(persisted.academyId, academyAId);
  assert.equal(persisted.courseId, courseAId);
  const replaced = await questions.updateQuestion(scope, created.id, { kind: "NORMAL_MCQ", courseId: courseAId, contentItemIds: [linkedFile.id], questionHtml: "Updated", correctOptionId: "A", options: [{ optionLabel: "A", html: "4" }, { optionLabel: "B", html: "5" }] });
  assert.equal(replaced.options.length, 2); assert.equal(replaced.correctOptionId, "A");
  const cloned = await questions.cloneQuestion(scope, created.id); assert.equal(cloned.status, "DRAFT");
  const caseQuestion = await questions.createQuestion(scope, { kind: "CASE_MCQ", courseId: courseAId, contentItemIds: [linkedFile.id], caseHtml: "Read the Academy case.", classificationMode: "ENTIRE_CASE", subQuestions: [{ questionHtml: "Which option applies?", correctOptionId: "A", options: [{ optionLabel: "A", html: "Applicable" }, { optionLabel: "B", html: "Not applicable" }] }] });
  assert.equal(caseQuestion.kind, "CASE_MCQ");
  assert.equal(caseQuestion.subQuestions.length, 1);
  await questions.setQuestionLifecycle(scope, created.id, "publish");
  await questions.setQuestionLifecycle(scope, created.id, "archive");
  await questions.setQuestionLifecycle(scope, created.id, "restore");
  await questions.setQuestionLifecycle(scope, created.id, "publish");
  await expectCode(() => questions.getQuestion({ academyId: academyBId, actorId: adminAId }, created.id), "QUESTION_NOT_FOUND");
  await expectCode(() => questions.createQuestion({ academyId: academyAId, actorId: adminAId }, { kind: "NORMAL_DESCRIPTIVE", courseId: courseBId, questionHtml: "foreign" }), "COURSE_NOT_FOUND");
  const academyBQuestion = await questions.createQuestion({ academyId: academyBId, actorId: adminAId }, { kind: "NORMAL_DESCRIPTIVE", courseId: courseBId, questionHtml: "Academy B private question" });
  const academyAList = await questions.listQuestions(scope, { page: 1, limit: 100, includeDeleted: true });
  const academyBList = await questions.listQuestions({ academyId: academyBId, actorId: adminAId }, { page: 1, limit: 100, includeDeleted: true });
  const platformList = await questions.listQuestions({ actorId: superId }, { page: 1, limit: 100, includeDeleted: true });
  assert.ok(academyAList.data.some((question) => question.id === created.id));
  assert.ok(!academyAList.data.some((question) => question.id === academyBQuestion.id));
  assert.ok(academyBList.data.some((question) => question.id === academyBQuestion.id));
  assert.ok(!platformList.data.some((question) => question.id === created.id || question.id === academyBQuestion.id));
  await expectCode(() => questions.getTaxonomy(scope, courseBId), "COURSE_NOT_FOUND");
  const academyStudentList = await questions.listStudentQuestions(studentAId, academyAId, { page: 1, limit: 100 });
  const directStudentList = await questions.listStudentQuestions(studentAId, undefined, { page: 1, limit: 100 });
  assert.ok(academyStudentList.data.some((question) => question.id === created.id));
  assert.ok(!directStudentList.data.some((question) => question.id === created.id || question.id === academyBQuestion.id));
  await expectCode(() => questions.listStudentQuestions(outsiderId, academyAId, { page: 1, limit: 100 }), "ACADEMY_QUESTIONS_NOT_FOUND");
});

test("broadcast delivery, templates, durable jobs, retries, deduplication, and stale recovery persist correctly", { skip: !enabled }, async () => {
  const sent: string[] = [];
  const email: EmailProvider = { async send(message) { sent.push(message.idempotencyKey); return { providerMessageId: `mail-${sent.length}` }; } };
  providerTestHooks.setEmail(email);
  try {
    const template = await templates.createTemplate(contextA, { title: "Hello {{name}}", body: "Welcome {{name}}", category: "welcome" });
    assert.equal((await templates.previewTemplate(contextA, template.id, { name: "Learner" })).body, "Welcome Learner");
    await expectCode(() => templates.previewTemplate(contextB, template.id, { name: "Attacker" }), "NOTIFICATION_TEMPLATE_NOT_FOUND");
    await expectCode(() => academy.createAcademyBroadcast(contextA, { title: "Foreign course", message: "Denied", targetCourseId: courseBId }), "COURSE_NOT_FOUND");
    await expectCode(() => academy.createAcademyBroadcast(contextA, { title: "Unsafe internal route", message: "Denied", cta: { enabled: true, text: "Open", action: "INTERNAL_ROUTE", destination: "/store/packages" } }), "INVALID_BROADCAST_CTA");
    await expectCode(() => academy.createAcademyBroadcast(contextA, { title: "Foreign CTA", message: "Denied", cta: { enabled: true, text: "Open", action: "COURSE", destination: courseBId } }), "COURSE_NOT_FOUND");
    const academyBPrivate = await academy.createAcademyBroadcast(contextB, { title: "Academy B Broadcast", message: "Academy B only" });
    const broadcast = await academy.createAcademyBroadcast(contextA, {
      title: "Phase 4 Broadcast", subtitle: "Rich persisted workflow", message: "Delivery test", type: "ACADEMIC", priority: "HIGH",
      platform: "BOTH", placements: ["NOTIFICATION", "HOME", "GENERAL"], frequency: "UNTIL_DISMISSED", dismissible: true,
      presentation: "BANNER", displayOrder: "CUSTOM", customOrderWeight: 77, acknowledgementRequired: true,
      repeatBehavior: "CONTINUE", showInWhatsNew: true,
      cta: { enabled: true, text: "View course", action: "COURSE", destination: courseAId },
    });
    assert.equal(broadcast.academyId, academyAId);
    assert.equal(broadcast.audienceKind, "ACADEMY_STUDENTS");
    assert.equal(broadcast.platform, "APP");
    assert.equal(broadcast.cta?.destination, courseAId);
    assert.deepEqual(broadcast.placements.map((entry) => entry.placement).sort(), ["GENERAL", "HOME", "NOTIFICATION"]);
    const persistedBroadcast = await prisma.broadcast.findUniqueOrThrow({ where: { id: broadcast.id }, include: { placements: true, cta: true, timeline: true } });
    assert.equal(persistedBroadcast.academyId, academyAId);
    assert.equal(persistedBroadcast.presentation, "BANNER");
    assert.equal(persistedBroadcast.displayOrder, "CUSTOM");
    assert.equal(persistedBroadcast.customOrderWeight, 77);
    assert.equal(persistedBroadcast.acknowledgementRequired, true);
    assert.equal(persistedBroadcast.repeatBehavior, "CONTINUE");
    assert.equal(persistedBroadcast.showInWhatsNew, true);
    assert.equal(persistedBroadcast.cta?.action, "COURSE");
    assert.ok(persistedBroadcast.timeline.some((event) => event.action === "CREATED"));
    const academyAList = await academy.getAcademyBroadcasts(contextA, { page: 1, limit: 100 });
    assert.ok(academyAList.data.some((item) => item.id === broadcast.id));
    assert.ok(!academyAList.data.some((item) => item.id === academyBPrivate.id));
    await expectCode(() => academy.getAcademyBroadcastDetail(contextA, academyBPrivate.id), "BROADCAST_NOT_FOUND");
    await expectCode(() => academy.updateAcademyBroadcast(contextA, academyBPrivate.id, { title: "Tampered" }), "BROADCAST_NOT_FOUND");
    const published = await academy.publishAcademyBroadcast(contextA, broadcast.id);
    assert.equal(published.delivery.status, "SENT");
    const concurrentRuns = await Promise.all([
      runDueJobsOnce({ workerId: "phase4-worker-a", limit: 20 }),
      runDueJobsOnce({ workerId: "phase4-worker-b", limit: 20 }),
    ]);
    const deliveryClaims = concurrentRuns.flat().filter((item) => item.id === published.delivery.jobId);
    assert.equal(deliveryClaims.length, 1, "Concurrent workers must claim a broadcast delivery job exactly once");
    assert.equal(deliveryClaims[0]?.status, "COMPLETED");
    const notification = await prisma.notification.findUniqueOrThrow({ where: { id: published.delivery.notificationId } });
    const expectedRecipients = await prisma.academyMembership.count({ where: { academyId: academyAId, role: "ACADEMY_STUDENT", status: "ACTIVE" } });
    assert.equal(notification.status, "SENT"); assert.equal(notification.totalRecipients, expectedRecipients);
    const courseBroadcast = await academy.createAcademyBroadcast(contextA, { title: "Course audience", message: "Course-only delivery", targetCourseId: courseAId });
    assert.equal(courseBroadcast.audienceKind, "COURSES");
    assert.equal(courseBroadcast.courseTargets[0]?.course.id, courseAId);
    const coursePublished = await academy.publishAcademyBroadcast(contextA, courseBroadcast.id);
    await runDueJobsOnce({ workerId: "phase4-course-worker", limit: 20 });
    const courseNotification = await prisma.notification.findUniqueOrThrow({ where: { id: coursePublished.delivery.notificationId } });
    const expectedCourseRecipients = await prisma.academyCourseEnrollment.count({ where: { academyId: academyAId, courseId: courseAId, status: "ACTIVE", student: { academyMemberships: { some: { academyId: academyAId, role: "ACADEMY_STUDENT", status: "ACTIVE" } } } } });
    assert.equal(courseNotification.targetType, "COURSE");
    assert.equal(courseNotification.targetCourseId, courseAId);
    assert.equal(courseNotification.status, "SENT");
    assert.equal(courseNotification.totalRecipients, expectedCourseRecipients);
    const emailNotification = await notifications.createNotification(contextA, { title: "Email abstraction", body: "Provider delivery", targetType: "ALL_STUDENTS" });
    const emailResult = await notifications.sendNotification(contextA, emailNotification.id, ["IN_APP", "EMAIL"]);
    assert.equal(emailResult.channels.emailDelivered, expectedRecipients);
    assert.equal(await prisma.notificationDelivery.count({ where: { notificationId: emailNotification.id, channel: "EMAIL", status: "DELIVERED" } }), expectedRecipients);
    const dedupeA = await enqueueJob({ kind: "CONTACT_EMAIL", payload: { submissionId: randomUUID() }, deduplicationKey: `dedupe-${suffix}` });
    const dedupeB = await enqueueJob({ kind: "CONTACT_EMAIL", payload: { submissionId: randomUUID() }, deduplicationKey: `dedupe-${suffix}` });
    assert.equal(dedupeA.id, dedupeB.id);
    const stale = await prisma.backgroundJob.create({ data: { kind: "UNKNOWN_PHASE4", payload: {}, status: "PROCESSING", lockedAt: new Date(Date.now() - 11 * 60_000), lockedBy: "dead-worker", attemptCount: 1, maxAttempts: 3 } });
    await runDueJobsOnce({ workerId: "phase4-recovery", limit: 1 });
    const recovered = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: stale.id } });
    assert.notEqual(recovered.status, "PROCESSING"); assert.equal(recovered.lockedBy, null);
    const exhausted = await prisma.backgroundJob.create({ data: { kind: "UNKNOWN_PHASE4_EXHAUSTED", payload: {}, status: "PENDING", runAt: new Date(0), attemptCount: 1, maxAttempts: 1 } });
    await runDueJobsOnce({ workerId: "phase4-exhaustion", limit: 100 });
    assert.equal((await prisma.backgroundJob.findUniqueOrThrow({ where: { id: exhausted.id } })).status, "FAILED");
    const scheduled = await academy.createAcademyBroadcast(contextA, { title: "Cancel race", message: "cancel" });
    await academy.scheduleAcademyBroadcast(contextA, scheduled.id, new Date(Date.now() + 60_000).toISOString());
    await academy.cancelAcademyBroadcast(contextA, scheduled.id);
    assert.equal((await prisma.backgroundJob.findUniqueOrThrow({ where: { kind_deduplicationKey: { kind: "BROADCAST_PUBLISH", deduplicationKey: scheduled.id } } })).status, "CANCELLED");
  } finally { providerTestHooks.reset(); }
});

test("Super Admin Academy Details aggregates and operational rows are database-backed and tenant-scoped", { skip: !enabled }, async () => {
  const detail = await adminDomains.getAcademy(academyAId);
  const foreign = await adminDomains.getAcademy(academyBId);
  const [students, activeStudents, courses, publishedCourses, contentItemsCount, questionCount, broadcastCount, activeBroadcastCount] = await Promise.all([
    prisma.academyMembership.count({ where: { academyId: academyAId, role: "ACADEMY_STUDENT" } }),
    prisma.academyMembership.count({ where: { academyId: academyAId, role: "ACADEMY_STUDENT", status: "ACTIVE", user: { status: "ACTIVE", deletedAt: null } } }),
    prisma.course.count({ where: { academyId: academyAId, deletedAt: null } }),
    prisma.course.count({ where: { academyId: academyAId, status: "ACTIVE", deletedAt: null } }),
    prisma.contentItem.count({ where: { deletedAt: null, course: { academyId: academyAId, deletedAt: null } } }),
    prisma.question.count({ where: { academyId: academyAId, deletedAt: null } }),
    prisma.broadcast.count({ where: { academyId: academyAId, deletedAt: null } }),
    prisma.broadcast.count({ where: { academyId: academyAId, status: "ACTIVE", deletedAt: null } }),
  ]);

  assert.deepEqual({
    studentsCount: detail.metrics.studentsCount,
    activeStudentsCount: detail.metrics.activeStudentsCount,
    coursesCount: detail.metrics.coursesCount,
    publishedCoursesCount: detail.metrics.publishedCoursesCount,
    contentCount: detail.metrics.contentCount,
    questionsCount: detail.metrics.questionsCount,
    broadcastCount: detail.metrics.broadcastCount,
    activeBroadcastCount: detail.metrics.activeBroadcastCount,
  }, {
    studentsCount: students,
    activeStudentsCount: activeStudents,
    coursesCount: courses,
    publishedCoursesCount: publishedCourses,
    contentCount: contentItemsCount,
    questionsCount: questionCount,
    broadcastCount,
    activeBroadcastCount,
  });
  assert.equal(detail.administrator.id, adminAId);
  assert.ok(detail.contentItems.every((item) => item.course.id === courseAId));
  assert.equal(detail.questions.length, questionCount);
  assert.equal(detail.broadcasts.length, broadcastCount);
  assert.equal(foreign.metrics.studentsCount, 1);
  assert.equal(foreign.contentItems.length, 0);
  assert.equal(foreign.questions.length, foreign.metrics.questionsCount);
  assert.equal(foreign.broadcasts.length, foreign.metrics.broadcastCount);
  const foreignQuestionIds = new Set((await prisma.question.findMany({ where: { academyId: academyBId, deletedAt: null }, select: { id: true } })).map((item) => item.id));
  const foreignBroadcastIds = new Set((await prisma.broadcast.findMany({ where: { academyId: academyBId, deletedAt: null }, select: { id: true } })).map((item) => item.id));
  assert.ok(foreign.questions.every((item) => foreignQuestionIds.has(item.id)));
  assert.ok(foreign.broadcasts.every((item) => foreignBroadcastIds.has(item.id)));
});

test("commerce enforces server pricing, idempotency, coupon concurrency, webhook replay, and refund idempotency", { skip: !enabled }, async () => {
  let checkoutCounter = 0;
  const payment: PaymentProvider = {
    async createCheckout(request) { checkoutCounter += 1; return { providerPaymentId: `provider-${request.orderId}`, redirectUrl: `https://pay.test/${request.orderId}` }; },
    async verifyWebhook(rawBody, signature) { if (signature !== "valid") throw new Error("bad signature"); const body = JSON.parse(rawBody.toString()) as { eventId: string; eventType: string; providerPaymentId: string; status: string }; return { eventId: body.eventId, eventType: body.eventType, payload: { providerPaymentId: body.providerPaymentId, status: body.status } }; },
    async refund(_providerPaymentId, _amountMinor, idempotencyKey) { return { providerRefundId: `refund-${idempotencyKey}` }; },
  };
  providerTestHooks.setPayment(payment);
  try {
    const paidPackage = await adminDomains.createPackage(superId, { courseId: courseAId, title: `Paid ${suffix}`, price: 499, status: "PUBLISHED" });
    const checkout = await commerce.createCheckout(studentAId, { packageIds: [paidPackage.id] }, `paid-${suffix}`) as Record<string, unknown>;
    assert.equal(checkout.totalAmount, 499); assert.ok(checkout.checkoutUrl); assert.equal(checkoutCounter, 1);
    const replay = await commerce.createCheckout(studentAId, { packageIds: [paidPackage.id] }, `paid-${suffix}`) as Record<string, unknown>;
    assert.equal(replay.orderId, checkout.orderId); assert.equal(checkoutCounter, 1);
    await expectCode(() => commerce.createCheckout(studentAId, { packageIds: [paidPackage.id], couponCode: "DIFFERENT" }, `paid-${suffix}`), "IDEMPOTENCY_KEY_REUSED");
    const order = await prisma.order.findUniqueOrThrow({ where: { id: String(checkout.orderId) }, include: { payments: true } });
    const webhookBody = Buffer.from(JSON.stringify({ eventId: `event-${suffix}`, eventType: "PAYMENT_SUCCEEDED", providerPaymentId: order.payments[0]!.providerPaymentId, status: "SUCCESS" }));
    await expectCode(() => commerce.handlePaymentWebhook("http", webhookBody, "tampered"), "INVALID_WEBHOOK_SIGNATURE");
    const webhookAttempts = await Promise.allSettled([commerce.handlePaymentWebhook("http", webhookBody, "valid"), commerce.handlePaymentWebhook("http", webhookBody, "valid")]);
    assert.ok(webhookAttempts.some((item) => item.status === "fulfilled"));
    assert.equal(await prisma.entitlement.count({ where: { orderId: order.id } }), 1);
    const refundA = await admin.refundAdminOrder(superId, order.id, { amount: 250, reason: "Phase 4 partial", idempotencyKey: `refund-${suffix}` });
    const refundB = await admin.refundAdminOrder(superId, order.id, { amount: 250, reason: "Phase 4 partial", idempotencyKey: `refund-${suffix}` });
    assert.equal(refundA.id, refundB.id);
    const partiallyRefunded = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { entitlements: true, payments: true } });
    assert.equal(partiallyRefunded.status, "PAID");
    assert.equal(partiallyRefunded.refundStatus, "PARTIAL");
    assert.equal(partiallyRefunded.accessStatus, "GRANTED");
    assert.equal(partiallyRefunded.entitlements[0]?.status, "ACTIVE");
    assert.equal(partiallyRefunded.payments[0]?.status, "SUCCESS");
    const partialNotice = await prisma.learnerNotification.findUniqueOrThrow({ where: { userId_sourceKey: { userId: studentAId, sourceKey: `order-refund:${refundA.id}` } } });
    assert.match(partialNotice.title, /partial refund/i);
    assert.match(partialNotice.body, /250\.00/);
    const finalRefund = await admin.refundAdminOrder(superId, order.id, { amount: 249, reason: "Phase 4 remainder", idempotencyKey: `refund-final-${suffix}` });
    const fullyRefunded = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { entitlements: true, payments: true } });
    assert.equal(fullyRefunded.status, "REFUNDED");
    assert.equal(fullyRefunded.refundStatus, "FULL");
    assert.equal(fullyRefunded.accessStatus, "REVOKED");
    assert.equal(fullyRefunded.entitlements[0]?.status, "REVOKED");
    assert.equal(fullyRefunded.payments[0]?.status, "REFUNDED");
    const fullNotice = await prisma.learnerNotification.findUniqueOrThrow({ where: { userId_sourceKey: { userId: studentAId, sourceKey: `order-refund:${finalRefund.id}` } } });
    assert.match(fullNotice.title, /partial refund/i);
    assert.match(fullNotice.body, /249\.00/);
    assert.match(fullNotice.body, /now fully refunded/i);
    const freePackage = await adminDomains.createPackage(superId, { courseId: courseAId, title: `Coupon ${suffix}`, price: 100, status: "PUBLISHED" });
    const coupon = await adminDomains.createCoupon(superId, { code: `ONE${suffix}`, discountType: "PERCENT", discountValue: 100, maxUses: 1 });
    const couponAttempts = await Promise.allSettled([
      commerce.createCheckout(studentAId, { packageIds: [freePackage.id], couponCode: coupon.code }, `coupon-a-${suffix}`),
      commerce.createCheckout(studentBId, { packageIds: [freePackage.id], couponCode: coupon.code }, `coupon-b-${suffix}`),
    ]);
    assert.equal(couponAttempts.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal((await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } })).usageCount, 1);
  } finally { providerTestHooks.reset(); }
});

test("student package, store, entitlement, and library projections reflect authoritative free purchases", { skip: !enabled }, async () => {
  await selectCourseForStudent(studentAId, courseAId);
  const note = await prisma.contentItem.create({ data: {
    courseId: courseAId,
    kind: "FILE",
    name: `Library ${suffix}.pdf`,
    mimeType: "application/pdf",
    size: 2048,
    storagePath: `phase4/library-${suffix}.pdf`,
    entityType: "PREMIUM_NOTE",
    accessType: "PAID",
    price: "249.00",
    status: "PUBLISHED",
  } });
  const pkg = await prisma.package.create({ data: {
    courseId: courseAId,
    title: `Free library package ${suffix}`,
    slug: `free-library-${suffix}`,
    description: "Student library projection fixture",
    price: "0.00",
    status: "PUBLISHED",
    items: { create: { contentItemId: note.id, displayOrder: 1 } },
  } });

  const before = await studentLibrary.getPackage(studentAId, pkg.id);
  assert.equal(before.access.owned, false);
  const checkout = await commerce.createCheckout(studentAId, { packageIds: [pkg.id] }, `library-free-${suffix}`) as { orderId: string; status: string; totalAmount: number };
  assert.equal(checkout.status, "PAID");
  assert.equal(checkout.totalAmount, 0);

  const after = await studentLibrary.getPackage(studentAId, pkg.id);
  assert.equal(after.access.owned, true);
  assert.equal(after.itemCount, 1);
  const packages = await studentLibrary.listPackages(studentAId, { ownership: "owned", page: 1, limit: 100 });
  assert.ok(packages.items.some((item) => item.id === pkg.id));
  const store = await studentLibrary.listStoreResources(studentAId, { type: "all", page: 1, limit: 100 });
  assert.equal(store.items.find((item) => item.id === pkg.id)?.access.owned, true);
  const library = await studentLibrary.getLibrary(studentAId, { page: 1, limit: 100 });
  assert.ok(library.items.some((item) => item.id === note.id));
  assert.ok(library.summary.freePurchases >= 1);
  const receipt = await studentLibrary.getReceipt(studentAId, checkout.orderId);
  assert.equal(receipt.purchaseType, "FREE_PURCHASE");
  assert.equal(receipt.totals.total?.amountMinor, 0);
  assert.equal(receipt.items[0]?.packageId, pkg.id);
  await assert.rejects(() => studentLibrary.getReceipt(studentBId, checkout.orderId), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "ORDER_NOT_FOUND"));
  const entitlements = await studentLibrary.listEntitlements(studentAId, { status: "ACTIVE", page: 1, limit: 100 });
  assert.ok(entitlements.items.some((item) => item.order?.orderId === checkout.orderId && item.resourceId === pkg.id));

  const expired = await prisma.entitlement.create({ data: { userId: studentAId, resourceType: "PREMIUM_NOTES", contentItemId: note.id, resourceTitle: note.name, source: "ADMIN_GRANT", accessType: "TIME_LIMITED", status: "ACTIVE", expiresAt: new Date(Date.now() - 60_000), reason: "Expiry projection check" } });
  const expiredDetail = await studentLibrary.getEntitlement(studentAId, expired.id);
  assert.equal(expiredDetail.status, "EXPIRED", "Request-time access state must not trust a stale stored ACTIVE value");
  await assert.rejects(() => studentLibrary.getEntitlement(studentBId, expired.id), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "ENTITLEMENT_NOT_FOUND"));
});

test("first-class Question Banks enforce tenant, type, file, purchase, and student-practice boundaries", { skip: !enabled }, async () => {
  await selectCourseForStudent(studentAId, courseAId);
  await selectCourseForStudent(studentBId, courseAId);
  const subject = await prisma.subject.create({ data: { courseId: courseAId, name: `Question Bank Subject ${suffix}` } });
  const chapter = await prisma.taxonomyChapter.create({ data: { courseId: courseAId, subjectId: subject.id, name: `Question Bank Chapter ${suffix}` } });
  const lesson = await prisma.taxonomyLesson.create({ data: { chapterId: chapter.id, name: `Question Bank Lesson ${suffix}` } });
  const topic = await prisma.taxonomyTopic.create({ data: { lessonId: lesson.id, name: `Question Bank Concept ${suffix}` } });
  const freeFile = await prisma.contentItem.create({ data: { courseId: courseAId, kind: "FILE", name: `Question Bank Free ${suffix}.pdf`, mimeType: "application/pdf", storagePath: `integration/question-bank/free-${suffix}.pdf`, accessType: "FREE", status: "PUBLISHED" } });
  const scope = { academyId: academyAId, actorId: adminAId };

  await expectCode(() => questionBanks.createQuestionBank({ academyId: academyBId, actorId: adminAId }, {
    courseId: courseAId, name: `Cross tenant ${suffix}`, accessType: "FREE",
  }), "COURSE_NOT_FOUND");

  const freeBank = await questionBanks.createQuestionBank(scope, {
    courseId: courseAId,
    name: `Free Normal Bank ${suffix}`,
    description: "Free first-class Question Bank integration fixture",
    accessType: "FREE",
  });
  await questions.createQuestion(scope, {
    courseId: courseAId, subjectId: subject.id, chapterId: chapter.id, contentItemIds: [],
    kind: "NORMAL_MCQ", status: "PUBLISHED", practiceCollection: "QUESTION_BANK", questionBankId: freeBank.id,
    questionHtml: "<p>Free bank prompt</p>", options: [{ optionLabel: "A", html: "Wrong" }, { optionLabel: "B", html: "Correct" }], correctOptionId: "B",
    correctExplanationHtml: "<p>B is correct.</p>", premiumWrongOptionsExplanationHtml: "<p>A is incorrect.</p>",
    examName: "Integration", chapterName: chapter.name, conceptName: "Free bank concept",
  });
  await questions.createQuestion(scope, {
    courseId: courseAId, subjectId: subject.id, chapterId: chapter.id, contentItemIds: [freeFile.id],
    kind: "CASE_MCQ", status: "PUBLISHED", practiceCollection: "QUESTION_BANK", questionBankId: freeBank.id,
    caseHtml: "<p>Mixed bank case</p>", subQuestions: [{ questionHtml: "<p>Mixed bank sub-question</p>", options: [{ optionLabel: "A", html: "One" }, { optionLabel: "B", html: "Two" }], correctOptionId: "A" }],
  });
  await questionBanks.setQuestionBankLifecycle(scope, freeBank.id, "publish");
  const freeVisible = await practice.listQuestionBanks(studentBId);
  assert.ok(freeVisible.some((bank) => bank.id === freeBank.id && bank.questionKinds.includes("NORMAL_MCQ") && bank.questionKinds.includes("CASE_MCQ") && bank.questionCount === 2));
  const freeFilters = await practice.getPracticeFilters(studentBId, { sourceKind: "ARCHIVE", mode: "QUESTION_BANK", questionBankId: freeBank.id });
  assert.ok(freeFilters.linkedFiles.some((file) => file.id === freeFile.id));
  const freeSession = await practice.createPracticeSession(studentBId, { sourceKind: "ARCHIVE", mode: "QUESTION_BANK", questionBankId: freeBank.id, collection: "QUESTION_BANK", answerFormat: "MCQ", questionCount: 2 });
  assert.equal(freeSession.questionBankId, freeBank.id);
  assert.deepEqual(new Set((await practice.listSessionQuestions(studentBId, freeSession.id, 1, 10)).items.map((item) => item.kind)), new Set(["NORMAL_MCQ", "CASE_MCQ"]));

  const caseBank = await questionBanks.createQuestionBank(scope, {
    courseId: courseAId, name: `Free Case Bank ${suffix}`, accessType: "FREE",
  });
  await questions.createQuestion(scope, {
    courseId: courseAId, subjectId: subject.id, chapterId: chapter.id, contentItemIds: [freeFile.id],
    kind: "CASE_MCQ", status: "PUBLISHED", practiceCollection: "QUESTION_BANK", questionBankId: caseBank.id,
    caseHtml: "<p>Read this integration case.</p>", examName: "Integration", chapterName: chapter.name, conceptName: "Case bank concept",
    subQuestions: [{ questionHtml: "<p>Choose the case answer.</p>", options: [{ optionLabel: "A", html: "Correct" }, { optionLabel: "B", html: "Wrong" }], correctOptionId: "A", correctExplanationHtml: "<p>A is correct.</p>", premiumWrongOptionsExplanationHtml: "<p>B is incorrect.</p>" }],
  });
  const caseWorkbook = new ExcelJS.Workbook();
  const caseSheet = caseWorkbook.addWorksheet("Case MCQ");
  caseSheet.addRow(["Case Passage", "Sub-question", "Option A", "Option B", "Option C", "Option D", "Correct Answer", "Correct Explanation", "Wrong Options Explanation", "File Name(s)", "Exam", "Chapter Name", "Concept Name"]);
  caseSheet.addRow([
    `Imported case passage ${suffix}`,
    `Imported case question ${suffix}`,
    "Correct imported option",
    "Wrong imported option",
    "",
    "",
    "A",
    "Imported correct explanation",
    "Imported wrong option explanation",
    freeFile.name,
    "Integration",
    chapter.name,
    topic.name,
  ]);
  const caseWorkbookBase64 = Buffer.from(await caseWorkbook.xlsx.writeBuffer()).toString("base64");
  const importRequest = { courseId: courseAId, mode: "case" as const, practiceCollection: "QUESTION_BANK" as const, questionBankId: caseBank.id, fileName: `case-bank-${suffix}.xlsx`, contentBase64: caseWorkbookBase64 };
  const importValidation = await questionImports.validateImport(scope, importRequest);
  assert.equal(importValidation.valid, true, JSON.stringify(importValidation.errors));
  const imported = await questionImports.commitImport(scope, { ...importRequest, validationDigest: importValidation.validationDigest });
  assert.equal(imported.imported, 1);
  assert.equal(imported.questions[0]?.subQuestions[0]?.correctExplanationHtml, "<p>Imported correct explanation</p>");
  assert.equal(imported.questions[0]?.subQuestions[0]?.premiumWrongOptionsExplanationHtml, "<p>Imported wrong option explanation</p>");
  assert.deepEqual(imported.questions[0]?.contentLinks.map((link) => link.contentItemId), [freeFile.id]);
  await questions.setQuestionLifecycle(scope, imported.questions[0]!.id, "publish");
  await questionBanks.setQuestionBankLifecycle(scope, caseBank.id, "publish");
  const caseSession = await practice.createPracticeSession(studentBId, { sourceKind: "ARCHIVE", mode: "QUESTION_BANK", questionBankId: caseBank.id, collection: "QUESTION_BANK", answerFormat: "CASE_STUDY", questionCount: 1 });
  assert.equal((await practice.listSessionQuestions(studentBId, caseSession.id, 1, 10)).items[0]?.kind, "CASE_MCQ");

  const paidBank = await questionBanks.createQuestionBank(scope, { courseId: courseAId, name: `Paid Bank ${suffix}`, accessType: "PAID", price: 399, accessDurationValue: 3, accessDurationUnit: "MONTHS" });
  await questions.createQuestion(scope, {
    courseId: courseAId, subjectId: subject.id, chapterId: chapter.id, contentItemIds: [],
    kind: "NORMAL_MCQ", status: "PUBLISHED", practiceCollection: "QUESTION_BANK", questionBankId: paidBank.id,
    questionHtml: "<p>Paid bank prompt</p>", options: [{ optionLabel: "A", html: "Correct" }, { optionLabel: "B", html: "Wrong" }], correctOptionId: "A",
    examName: "Integration", chapterName: chapter.name, conceptName: "Paid bank concept",
  });
  await questionBanks.setQuestionBankLifecycle(scope, paidBank.id, "publish");
  assert.ok(!(await practice.listQuestionBanks(studentBId)).some((bank) => bank.id === paidBank.id), "Unpurchased paid Question Banks must remain hidden");
  const paidOrder = await prisma.order.create({ data: { orderNumber: `QB-${suffix}`, userId: studentAId, courseId: courseAId, subtotal: "399.00", totalAmount: "399.00", status: "PAID", accessStatus: "GRANTED", paidAt: new Date(), receiptNumber: `QB-RCP-${suffix}`, items: { create: { questionBankId: paidBank.id, resourceType: "QUESTION_BANK", titleSnapshot: paidBank.name, unitPrice: "399.00", quantity: 1, totalPrice: "399.00" } } } });
  await prisma.entitlement.create({ data: { userId: studentAId, resourceType: "QUESTION_BANK", questionBankId: paidBank.id, resourceTitle: paidBank.name, source: "PURCHASE", orderId: paidOrder.id, status: "ACTIVE" } });
  assert.ok((await practice.listQuestionBanks(studentAId)).some((bank) => bank.id === paidBank.id), "A paid order entitlement must reveal its Question Bank");
  const paidSession = await practice.createPracticeSession(studentAId, { sourceKind: "ARCHIVE", mode: "QUESTION_BANK", questionBankId: paidBank.id, collection: "QUESTION_BANK", answerFormat: "MCQ", questionCount: 1 });
  assert.equal(paidSession.accessPolicy, "PAID");
  const paidSessionQuestionId = (await practice.listSessionQuestions(studentAId, paidSession.id, 1, 10)).items[0]!.id;
  const paidWrong = await practice.submitAttempt(studentAId, paidSession.id, paidSessionQuestionId, { clientAttemptId: `paid-bank-wrong-${suffix}`, answerOptionLabel: "B" });
  assert.equal(paidWrong.result.retryAllowed, true);
  assert.ok((await practice.listWrongAnswers(studentAId, { page: 1, limit: 100 })).data.some((item) => item.id === paidSessionQuestionId), "Entitled Question Bank mistakes must remain available in Wrong Answers mode");
});

test("secure practice hides answers, enforces Free/Paid retry policy, timers, idempotency, and chapter tracking", { skip: !enabled }, async () => {
  const subject = await prisma.subject.create({ data: { courseId: courseAId, name: `Practice Subject ${suffix}` } });
  const freeChapter = await prisma.taxonomyChapter.create({ data: { courseId: courseAId, subjectId: subject.id, name: `Free Chapter ${suffix}` } });
  const paidChapter = await prisma.taxonomyChapter.create({ data: { courseId: courseAId, subjectId: subject.id, name: `Paid Chapter ${suffix}` } });
  const practiceFile = await prisma.contentItem.create({ data: { courseId: courseAId, kind: "FILE", name: `Practice source ${suffix}.pdf`, mimeType: "application/pdf", storagePath: `integration/practice/source-${suffix}.pdf`, accessType: "FREE", status: "PUBLISHED" } });
  await prisma.learnerPreference.upsert({
    where: { userId: studentBId },
    create: { userId: studentBId, selectedCourseId: courseAId, examDate: new Date(Date.UTC(new Date().getUTCFullYear() + 1, 0, 1)), examDatePrecision: "MONTH", onboardingCompletedAt: new Date() },
    update: { selectedCourseId: courseAId },
  });
  await prisma.learnerPreference.upsert({
    where: { userId: studentAId },
    create: { userId: studentAId, selectedCourseId: courseAId, examDate: new Date(Date.UTC(new Date().getUTCFullYear() + 1, 0, 1)), examDatePrecision: "MONTH", onboardingCompletedAt: new Date() },
    update: { selectedCourseId: courseAId },
  });
  await prisma.question.create({ data: {
    academyId: academyAId,
    courseId: courseAId,
    subjectId: subject.id,
    chapterId: freeChapter.id,
    kind: "NORMAL_MCQ",
    status: "PUBLISHED",
    practiceCollection: "PYQ",
    practiceYear: 2025,
    questionHtml: "Free secure prompt",
    correctOptionId: "B",
    correctExplanationHtml: "Free correct answer explanation",
    premiumWrongOptionsExplanationHtml: "Free wrong answer explanation",
    options: { create: [{ optionLabel: "A", html: "Wrong", displayOrder: 0 }, { optionLabel: "B", html: "Correct", displayOrder: 1 }] },
    contentLinks: { create: { contentItemId: practiceFile.id } },
  } });
  await prisma.question.create({ data: {
    academyId: academyAId,
    courseId: courseAId,
    subjectId: subject.id,
    chapterId: freeChapter.id,
    kind: "NORMAL_MCQ",
    status: "PUBLISHED",
    practiceCollection: "PYQ",
    practiceYear: 2025,
    questionHtml: "Free correct prompt",
    correctOptionId: "D",
    correctExplanationHtml: "Free explanation released after correct answer",
    premiumWrongOptionsExplanationHtml: "Unused free wrong explanation",
    options: { create: [{ optionLabel: "A", html: "Wrong", displayOrder: 0 }, { optionLabel: "D", html: "Correct", displayOrder: 1 }] },
    contentLinks: { create: { contentItemId: practiceFile.id } },
  } });
  const freeSession = await practice.createPracticeSession(studentBId, { sourceKind: "ARCHIVE", subjectId: subject.id, chapterId: freeChapter.id, collection: "PYQ", year: 2025, answerFormat: "MCQ", questionCount: 2, timerSeconds: 300 });
  const freePrompts = await practice.listSessionQuestions(studentBId, freeSession.id, 1, 10);
  const serializedPrompt = JSON.stringify(freePrompts);
  assert.doesNotMatch(serializedPrompt, /correctOption|correct explanation|wrong explanation|answerHtml/i, "Prompts must not serialize answer material");
  const freeQuestionId = freePrompts.items.find((item) => item.promptHtml === "Free secure prompt")!.id;
  const freeCorrectQuestionId = freePrompts.items.find((item) => item.promptHtml === "Free correct prompt")!.id;
  const freeWrong = await practice.submitAttempt(studentBId, freeSession.id, freeQuestionId, { clientAttemptId: `free-wrong-${suffix}`, answerOptionLabel: "A", durationMs: 1200 });
  assert.equal(freeWrong.result.navigatorState, "LOCKED_WRONG");
  assert.equal(freeWrong.result.explanation, "Free wrong answer explanation");
  assert.equal(freeWrong.result.wrongExplanation, "Free wrong answer explanation");
  assert.equal(freeWrong.result.correctExplanation, "Free correct answer explanation");
  assert.equal(freeWrong.result.correctOptionLabel, "B");
  assert.equal(freeWrong.result.retryAllowed, false);
  const freeReplay = await practice.submitAttempt(studentBId, freeSession.id, freeQuestionId, { clientAttemptId: `free-wrong-${suffix}`, answerOptionLabel: "A", durationMs: 1200 });
  assert.equal(freeReplay.replay, true);
  await expectCode(() => practice.submitAttempt(studentBId, freeSession.id, freeQuestionId, { clientAttemptId: `free-retry-${suffix}`, answerOptionLabel: "B" }), "WRONG_RETRY_PAID_REQUIRED");
  const freeCorrect = await practice.submitAttempt(studentBId, freeSession.id, freeCorrectQuestionId, { clientAttemptId: `free-correct-${suffix}`, answerOptionLabel: "D" });
  assert.equal(freeCorrect.result.navigatorState, "ANSWERED_CORRECT");
  assert.equal(freeCorrect.result.explanation, "Free explanation released after correct answer");
  assert.equal(freeCorrect.result.correctExplanation, "Free explanation released after correct answer");
  assert.equal(freeCorrect.result.wrongExplanation, "Unused free wrong explanation");
  assert.equal(freeCorrect.result.correctOptionLabel, "D");
  await expectCode(() => practice.previewPracticeSet(studentBId, { sourceKind: "ARCHIVE", subjectId: subject.id, chapterId: freeChapter.id, collection: "PYQ", year: 2025, answerFormat: "MCQ", questionCount: 1 }), "FILTER_COMBINATION_EMPTY");
  await expectCode(() => practice.getPracticeSession(studentAId, freeSession.id), "PRACTICE_SESSION_NOT_FOUND");

  const bank = await prisma.package.create({ data: { courseId: courseAId, title: `Question Bank PDF ${suffix}`, slug: `question-bank-pdf-${suffix}`, price: "499.00", status: "PUBLISHED" } });
  await prisma.question.create({ data: {
    academyId: academyAId,
    courseId: courseAId,
    subjectId: subject.id,
    chapterId: paidChapter.id,
    kind: "NORMAL_MCQ",
    status: "PUBLISHED",
    practiceCollection: "RTP",
    questionHtml: "Free Admin-uploaded prompt",
    correctOptionId: "C",
    correctExplanationHtml: "Paid-policy correct explanation",
    premiumWrongOptionsExplanationHtml: "Paid-policy wrong explanation",
    options: { create: [{ optionLabel: "A", html: "Wrong", displayOrder: 0 }, { optionLabel: "C", html: "Correct", displayOrder: 1 }] },
    contentLinks: { create: { contentItemId: practiceFile.id } },
  } });
  const paidOrder = await prisma.order.create({ data: { orderNumber: `PRACTICE-${suffix}`, userId: studentAId, courseId: courseAId, subtotal: "499.00", totalAmount: "499.00", status: "PAID", accessStatus: "GRANTED", paidAt: new Date(), receiptNumber: `PRACTICE-RCP-${suffix}`, items: { create: { packageId: bank.id, resourceType: "PACKAGE", titleSnapshot: bank.title, unitPrice: "499.00", quantity: 1, totalPrice: "499.00" } } } });
  const bankEntitlement = await prisma.entitlement.create({ data: { userId: studentAId, resourceType: "PACKAGE", packageId: bank.id, resourceTitle: bank.title, source: "PURCHASE", orderId: paidOrder.id, status: "ACTIVE" } });
  const freeVisibility = await practice.previewPracticeSet(studentBId, { sourceKind: "ARCHIVE", chapterId: paidChapter.id, collection: "RTP", answerFormat: "MCQ", questionCount: 1 });
  assert.equal(freeVisibility.eligibleQuestionCount, 1, "Admin-uploaded course questions must remain visible without a Question Bank purchase");
  const paidSession = await practice.createPracticeSession(studentAId, { sourceKind: "ARCHIVE", subjectId: subject.id, chapterId: paidChapter.id, collection: "RTP", answerFormat: "MCQ", questionCount: 1 });
  const paidQuestionId = (await practice.listSessionQuestions(studentAId, paidSession.id, 1, 10)).items[0]!.id;
  const paidWrong = await practice.submitAttempt(studentAId, paidSession.id, paidQuestionId, { clientAttemptId: `paid-wrong-${suffix}`, answerOptionLabel: "A" });
  assert.equal(paidWrong.result.navigatorState, "ANSWERED_WRONG");
  assert.equal(paidWrong.result.retryAllowed, true);
  assert.equal(paidWrong.result.explanation, "Paid-policy wrong explanation");
  assert.equal(paidWrong.result.correctExplanation, "Paid-policy correct explanation");
  assert.equal(paidWrong.result.wrongExplanation, "Paid-policy wrong explanation");
  assert.equal(paidWrong.result.correctOptionLabel, "C");
  const paidCorrect = await practice.submitAttempt(studentAId, paidSession.id, paidQuestionId, { clientAttemptId: `paid-correct-${suffix}`, answerOptionLabel: "C" });
  assert.equal(paidCorrect.result.navigatorState, "ANSWERED_CORRECT");
  assert.equal(paidCorrect.result.explanation, "Paid-policy correct explanation");
  assert.equal(paidCorrect.result.correctExplanation, "Paid-policy correct explanation");
  assert.equal(paidCorrect.result.wrongExplanation, "Paid-policy wrong explanation");
  const reviewModes = await practice.listPracticeModes(studentAId);
  assert.ok(reviewModes.modes.some((mode) => mode.id === "REVISIT" && mode.availableCount >= 1 && !mode.locked));
  const revisitSession = await practice.createPracticeSession(studentAId, { sourceKind: "ARCHIVE", mode: "REVISIT", subjectId: subject.id, chapterId: paidChapter.id, answerFormat: "MCQ", questionCount: 1 });
  assert.equal(revisitSession.mode, "REVISIT");
  assert.equal(revisitSession.questionCount, 1);
  const currentWrongAnswers = await practice.listWrongAnswers(studentAId, { page: 1, limit: 100 });
  assert.ok(currentWrongAnswers.data.every((item) => item.promptHtml !== "Free Admin-uploaded prompt"), "A correctly answered question must leave Wrong Answers");
  const tracker = await practice.getPracticeTracker(studentAId);
  assert.ok(tracker.chapters.some((chapter) => chapter.chapterId === paidChapter.id && chapter.questionsSolved >= 1 && chapter.attempts >= 2));

  await prisma.entitlement.update({ where: { id: bankEntitlement.id }, data: { status: "REVOKED", revokedAt: new Date() } });
  const afterRevocation = await practice.previewPracticeSet(studentAId, { sourceKind: "ARCHIVE", chapterId: paidChapter.id, collection: "RTP", answerFormat: "MCQ", questionCount: 1 });
  assert.equal(afterRevocation.eligibleQuestionCount, 1, "Revoking a PDF package must not remove free practice questions");

  const timerSession = await practice.createPracticeSession(studentAId, { sourceKind: "ARCHIVE", subjectId: subject.id, chapterId: freeChapter.id, answerFormat: "MCQ", questionCount: 1, timerSeconds: 30 });
  await prisma.practiceSession.update({ where: { id: timerSession.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  const timerQuestionId = (await prisma.practiceSessionQuestion.findFirstOrThrow({ where: { sessionId: timerSession.id }, select: { id: true } })).id;
  await expectCode(() => practice.submitAttempt(studentAId, timerSession.id, timerQuestionId, { clientAttemptId: `late-${suffix}`, answerOptionLabel: "B" }), "SESSION_EXPIRED");
});

test("Super Admin, Student, public catalog/contact, and recursive audit redaction use persisted data", { skip: !enabled }, async () => {
  const overview = await admin.getAdminOverview();
  // Other integration cases intentionally create and remove disposable users
  // and academies in parallel. A second database count is not an atomic
  // comparison with the overview's Promise.all snapshot, so validate the
  // persisted aggregate contract without introducing a cross-test race.
  assert.ok(Number.isInteger(overview.users) && overview.users >= 2);
  assert.ok(Number.isInteger(overview.academies) && overview.academies >= 2);
  const granted = await adminDomains.grantEntitlement(superId, { userId: studentAId, resourceType: "COURSE", courseId: courseAId, resourceTitle: "Phase 4 Course", reason: "Phase 4 verification" });
  assert.equal((await student.getMemberships(studentAId)).data.length >= 1, true);
  await student.setActiveAcademy(studentAId, academyAId);
  assert.equal((await student.getDashboard(studentAId)).academyId, academyAId);
  assert.equal((await student.listCourses(studentAId)).data.length >= 1, true);
  await expectCode(() => student.setActiveAcademy(studentAId, academyBId), "ACADEMY_MEMBERSHIP_REQUIRED");
  const catalog = await publicApi.listCatalog({ page: 1, limit: 100, academyId: academyAId });
  assert.ok(catalog.courses.some((item) => item.id === courseAId));
  assert.ok(catalog.packages.every((item) => !("deletedAt" in item) && !("storagePath" in item)));
  const contact = await publicApi.submitContact({ name: "Phase Four", email: `contact-${suffix}@test.invalid`, subject: "Verification", message: "This is a Phase 4 contact verification message.", academyId: academyAId, ipAddress: "127.0.0.1" });
  assert.equal(contact.status, "RECEIVED");
  const persisted = await prisma.contactSubmission.findUniqueOrThrow({ where: { id: contact.id } });
  assert.ok(persisted.ipHash && persisted.ipHash !== "127.0.0.1");
  await prisma.systemAuditLog.create({ data: { actorId: superId, action: "PHASE4_REDACTION", entityType: "Verification", before: { password: "secret", nested: { authorization: "Bearer token", safe: "visible" } }, after: { cookie: "session=secret", api_key: "secret" } } });
  const events = await admin.listAuditEvents({ page: 1, limit: 100, action: "PHASE4_REDACTION" });
  const serialized = JSON.stringify(events.data[0]);
  assert.doesNotMatch(serialized, /Bearer token|session=secret|\"secret\"/); assert.match(serialized, /\[REDACTED\]/);
  await adminDomains.revokeEntitlement(superId, granted.id, "Verification complete");
});

test("database integrity queries and representative EXPLAIN plans complete without violations", { skip: !enabled }, async () => {
  const integrity = await prisma.$queryRawUnsafe<Array<{ violation: string; count: bigint }>>(`
    SELECT 'membership_without_academy' AS violation, COUNT(*)::bigint AS count FROM "AcademyMembership" m LEFT JOIN "Academy" a ON a.id=m."academyId" WHERE a.id IS NULL
    UNION ALL SELECT 'membership_without_user', COUNT(*)::bigint FROM "AcademyMembership" m LEFT JOIN "User" u ON u.id=m."userId" WHERE u.id IS NULL
    UNION ALL SELECT 'recipient_tenant_mismatch', COUNT(*)::bigint FROM "NotificationRecipient" r JOIN "Notification" n ON n.id=r."notificationId" WHERE r."academyId"<>n."academyId"
    UNION ALL SELECT 'order_total_mismatch', COUNT(*)::bigint FROM "Order" WHERE "totalAmount"<>GREATEST(0,"subtotal"-"discountAmount")
    UNION ALL SELECT 'job_lock_mismatch', COUNT(*)::bigint FROM "BackgroundJob" WHERE (status='PROCESSING')<>("lockedAt" IS NOT NULL AND "lockedBy" IS NOT NULL)
  `);
  assert.deepEqual(integrity.filter((row) => Number(row.count) !== 0), []);
  const plan = await prisma.$queryRawUnsafe<Array<{ "QUERY PLAN": unknown }>>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM "SystemAuditLog" WHERE "academyId"='${academyAId}'::uuid ORDER BY "occurredAt" DESC LIMIT 25`);
  assert.ok(plan[0]?.["QUERY PLAN"]);
  const plan2 = await prisma.$queryRawUnsafe<Array<{ "QUERY PLAN": unknown }>>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM "NotificationRecipient" WHERE "studentUserId"='${studentAId}'::uuid AND "isRead"=false ORDER BY "createdAt" DESC LIMIT 25`);
  assert.ok(plan2[0]?.["QUERY PLAN"]);
});

test.after(async () => { providerTestHooks.reset(); await prisma.$disconnect(); });

import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { getConfig } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import * as preferences from "../services/learnerPreferenceService.js";
import * as account from "../services/studentAccountService.js";
import { databaseDate } from "../services/learnerTime.js";
import { integrationDatabaseEnabled } from "../tests/integration-database-guard.js";
import { hashPassword } from "../auth/password.js";
import { loginWithPassword } from "../auth/auth-service.js";

const enabled = integrationDatabaseEnabled("RUN_BACKEND_INTEGRATION");
const suffix = randomUUID().slice(0, 8);
const userId = randomUUID(); const emailUserId = randomUUID(); const deleteUserId = randomUUID(); const courseId = randomUUID();
const password = "Account-test-Password-42!";
const hash = (challengeId: string, code: string) => createHmac("sha256", getConfig().auth.jwtSecret).update(`account:${challengeId}:${code}`).digest("hex");

before(async () => {
  if (!enabled) return;
  const role = await prisma.role.upsert({ where: { key: "student" }, create: { key: "student", name: "Student", description: "Learner role" }, update: {}, select: { id: true } });
  await prisma.course.create({ data: { id: courseId, slug: `account-${suffix}`, code: `A${suffix.slice(0, 7)}`, name: "Account Test Course" } });
  await prisma.user.createMany({ data: [
    { id: userId, email: `account-${suffix}@test.local`, fullName: "Original Learner", phone: `+91910${suffix.replace(/\D/g, "").padEnd(7, "1").slice(0, 7)}`, roleId: role.id },
    { id: emailUserId, email: `email-old-${suffix}@test.local`, fullName: "Email Learner", roleId: role.id },
    { id: deleteUserId, email: `delete-${suffix}@test.local`, fullName: "Delete Learner", roleId: role.id },
  ] });
  const passwordHash = await hashPassword(password);
  await prisma.passwordCredential.createMany({ data: [{ userId: emailUserId, passwordHash }, { userId: deleteUserId, passwordHash }] });
  await prisma.learnerPreference.create({ data: { userId, selectedCourseId: courseId, examDate: new Date(Date.UTC(2028, 5, 1)), examDatePrecision: "MONTH", dailyTargetMinutes: 120, timezone: "UTC", onboardingCompletedAt: new Date() } });
});

after(async () => {
  if (!enabled) return;
  await prisma.user.deleteMany({ where: { id: { in: [userId, emailUserId, deleteUserId] } } });
  await prisma.course.deleteMany({ where: { id: courseId } });
  await prisma.$disconnect();
});

test("student account persists owned profile settings and rejects course mutation", { skip: !enabled }, async () => {
  assert.equal((await account.getStudentAccount(userId)).learnerPreference?.selectedCourseId, courseId);
  await account.updateName(userId, "Updated Learner");
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).fullName, "Updated Learner");
  await assert.rejects(() => preferences.patchPreferences(userId, { selectedCourseId: randomUUID() }), /cannot be changed/i);

  const date = databaseDate("2026-08-20");
  await prisma.learnerDailyActivity.create({ data: { userId, localDate: date, timezone: "UTC", targetMinutes: 120, lastActivityAt: new Date() } });
  const updated = await account.updateStudyTarget(userId, 180);
  assert.equal(updated.dailyTargetMinutes, 180);
  assert.equal((await prisma.learnerDailyActivity.findUniqueOrThrow({ where: { userId_localDate: { userId, localDate: date } } })).targetMinutes, 120, "historical target snapshot must remain unchanged");
  assert.equal((await account.updateAppearance(userId, "LIGHT")).preferredTheme, "LIGHT");
});

test("email-verified mobile change is single-use and server-authoritative", { skip: !enabled }, async () => {
  const challengeId = randomUUID(); const code = "1357";
  await prisma.accountVerificationChallenge.create({ data: { id: challengeId, userId, purpose: "MOBILE_CHANGE", targetValue: "+919876543219", otpHash: hash(challengeId, code), sentAt: new Date(), expiresAt: new Date(Date.now() + 60_000) } });
  await assert.rejects(() => account.verifyChange(userId, challengeId, "MOBILE_CHANGE", "1111"), /incorrect/i);
  const verified = await account.verifyChange(userId, challengeId, "MOBILE_CHANGE", code);
  assert.equal("user" in verified && verified.user?.phone, "+919876543219");
  await assert.rejects(() => account.verifyChange(userId, challengeId, "MOBILE_CHANGE", code), /already been used/i);
});

test("verified email becomes the login identity and revokes stale sessions", { skip: !enabled }, async () => {
  await prisma.userSession.create({ data: { userId: emailUserId, authSessionId: randomUUID(), refreshTokenHash: "b".repeat(64), expiresAt: new Date(Date.now() + 86_400_000) } });
  const challengeId = randomUUID(); const currentCode = "1357"; const replacementCode = "2468";
  const oldEmail = `email-old-${suffix}@test.local`; const nextEmail = `email-new-${suffix}@test.local`;
  await prisma.accountVerificationChallenge.create({ data: { id: challengeId, userId: emailUserId, purpose: "EMAIL_CHANGE", previousValue: oldEmail, targetValue: nextEmail, otpHash: hash(challengeId, currentCode), sentAt: new Date(), expiresAt: new Date(Date.now() + 60_000) } });
  await assert.rejects(() => account.confirmEmailChange(emailUserId, challengeId, currentCode), /current email/i);
  await prisma.accountVerificationChallenge.update({ where: { id: challengeId }, data: { currentVerifiedAt: new Date(), otpHash: hash(challengeId, replacementCode), attempts: 0 } });
  await account.confirmEmailChange(emailUserId, challengeId, replacementCode);
  assert.equal(await prisma.userSession.count({ where: { userId: emailUserId, revokedAt: null } }), 0);
  await assert.rejects(() => loginWithPassword(oldEmail, password, { platform: "ANDROID" }), /incorrect/i);
  const login = await loginWithPassword(nextEmail, password, { platform: "WEB", deviceName: "Integration browser" });
  assert.equal(login.user.email, nextEmail);
});

test("delete verification disables only the authenticated owner and revokes every session", { skip: !enabled }, async () => {
  await prisma.userSession.create({ data: { userId: deleteUserId, authSessionId: randomUUID(), refreshTokenHash: "a".repeat(64), expiresAt: new Date(Date.now() + 86_400_000) } });
  const challengeId = randomUUID(); const code = "2468";
  await prisma.accountVerificationChallenge.create({ data: { id: challengeId, userId: deleteUserId, purpose: "DELETE_ACCOUNT", targetValue: `delete-${suffix}@test.local`, otpHash: hash(challengeId, code), sentAt: new Date(), expiresAt: new Date(Date.now() + 60_000) } });
  await account.verifyChange(deleteUserId, challengeId, "DELETE_ACCOUNT", code);
  const deleted = await prisma.user.findUniqueOrThrow({ where: { id: deleteUserId } });
  assert.equal(deleted.status, "DISABLED"); assert.ok(deleted.deletedAt);
  assert.equal(await prisma.userSession.count({ where: { userId: deleteUserId, revokedAt: null } }), 0);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).status, "ACTIVE");
  await assert.rejects(() => loginWithPassword(`delete-${suffix}@test.local`, password, { platform: "ANDROID" }), /incorrect/i);
});

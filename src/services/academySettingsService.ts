import { prisma } from '../db/prisma.js';
import { assertTenantResourceAccess, type TenantContext } from '../auth/tenant-auth.js';
import { randomUUID } from 'node:crypto';
import { badRequest, conflict, notFound } from '../errors/api-error.js';
import { getStorageProvider } from '../integrations/provider-registry.js';
import { assertFileNameMatchesMime } from '../utils/upload-validation.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^[+\d][\d\s()-]{6,20}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveActorUuid(rawId?: string): Promise<string> {
  if (!rawId || !UUID_PATTERN.test(rawId)) {
    throw new Error('Authenticated actor identity is missing or invalid.');
  }
  return rawId;
}

export interface UpdateAcademySettingsInput {
  name?: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  postalCode?: string;
  website?: string;
  description?: string;
  adminName?: string;
  adminEmail?: string;
  adminPhone?: string;
  expectedUpdatedAt?: string;
}

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
  logoUrl: true,
  status: true,
  adminName: true,
  adminEmail: true,
  adminPhone: true,
  studentCount: true,
  activeStudentCount: true,
  courseCount: true,
  activeCourseCount: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
};

const ACADEMY_SETTINGS_SELECT = {
  ...ACADEMY_CORE_SELECT,
  academyCode: true,
  displayName: true,
  academyType: true,
  establishedYear: true,
  socialLinks: true,
  profile: {
    select: {
      onboardingStatus: true,
      logoStoragePath: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  contacts: {
    orderBy: [{ isPrimary: 'desc' as const }, { createdAt: 'asc' as const }],
    select: {
      id: true,
      role: true,
      fullName: true,
      email: true,
      phone: true,
      isPrimary: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  legalProfile: {
    select: {
      legalName: true,
      entityType: true,
      panStatus: true,
      pan: true,
      tan: true,
      gstStatus: true,
      gstin: true,
      gstState: true,
      gstRegistrationType: true,
      gstRegistrationDate: true,
      gstCertificateStoragePath: true,
      placeOfSupply: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  addresses: {
    orderBy: { kind: 'asc' as const },
    select: {
      id: true,
      kind: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      state: true,
      country: true,
      postalCode: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  billingProfile: {
    select: {
      invoiceDisplayName: true,
      invoiceEmail: true,
      billingContactName: true,
      billingContactPhone: true,
      purchaseOrderRequired: true,
      currency: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  academicOfferings: {
    orderBy: [{ category: 'asc' as const }, { program: 'asc' as const }],
    select: {
      id: true,
      category: true,
      program: true,
      branch: true,
      batch: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  commercialProfile: {
    select: {
      planKey: true,
      subscriptionStatus: true,
      startDate: true,
      endDate: true,
      studentSeatLimit: true,
      purchasedSeats: true,
      activeSeats: true,
      additionalSeats: true,
      billingCycle: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  integrationProfile: {
    select: {
      zohoOrganizationId: true,
      zohoCustomerId: true,
      zohoCustomerNumber: true,
      zohoContactId: true,
      zohoCustomerName: true,
      zohoSyncStatus: true,
      zohoLastSyncedAt: true,
      zohoLastSyncError: true,
      zohoSyncVersion: true,
      paymentCustomerId: true,
      createdAt: true,
      updatedAt: true,
    },
  },
};

export async function getAcademySettings(context: TenantContext) {
  const academyId = context.academyId;
  if (!academyId) {
    const error: any = new Error('400 Bad Request: Missing active academy context.');
    error.statusCode = 400;
    throw error;
  }

  const academy = await prisma.academy.findUnique({
    where: { id: academyId },
    select: ACADEMY_SETTINGS_SELECT,
  });

  if (!academy || academy.deletedAt) {
    const error: any = new Error('404 Not Found: Academy not found.');
    error.statusCode = 404;
    throw error;
  }

  return {
    academy: {
      id: academy.id,
      slug: academy.slug,
      name: academy.name,
      displayName: academy.displayName || '',
      academyCode: academy.academyCode || '',
      academyType: academy.academyType,
      establishedYear: academy.establishedYear,
      socialLinks: academy.socialLinks,
      email: academy.email,
      phone: academy.phone,
      address: academy.address,
      city: academy.city,
      state: academy.state,
      country: academy.country,
      postalCode: academy.postalCode,
      website: academy.website || '',
      description: academy.description || '',
      logoUrl: academy.logoUrl || '',
      status: academy.status,
      adminName: academy.adminName,
      adminEmail: academy.adminEmail,
      adminPhone: academy.adminPhone || '',
      studentCount: academy.studentCount,
      activeStudentCount: academy.activeStudentCount,
      courseCount: academy.courseCount,
      activeCourseCount: academy.activeCourseCount,
      createdAt: academy.createdAt.toISOString(),
      updatedAt: academy.updatedAt.toISOString(),
      profile: academy.profile,
      contacts: academy.contacts,
      legalProfile: academy.legalProfile,
      addresses: academy.addresses,
      billingProfile: academy.billingProfile,
      academicOfferings: academy.academicOfferings,
      commercialProfile: academy.commercialProfile,
      integrationProfile: academy.integrationProfile,
      adminContactSemantics: 'CONTACT_METADATA_ONLY' as const,
    },
  };
}

export async function updateAcademySettings(context: TenantContext, body: UpdateAcademySettingsInput & Record<string, unknown>) {
  const academyId = context.academyId;
  if (!academyId) {
    const error: any = new Error('400 Bad Request: Missing active academy context.');
    error.statusCode = 400;
    throw error;
  }

  const currentAcademy = await prisma.academy.findUnique({
    where: { id: academyId },
    select: ACADEMY_CORE_SELECT,
  });

  if (!currentAcademy || currentAcademy.deletedAt) {
    const error: any = new Error('404 Not Found: Academy not found.');
    error.statusCode = 404;
    throw error;
  }

  // 1. Validation Logic
  const name = typeof body.name === 'string' ? body.name.trim() : currentAcademy.name;
  if (!name) {
    const error: any = new Error('400 Bad Request: Academy name is required.');
    error.statusCode = 400;
    throw error;
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : currentAcademy.email;
  if (!email || !EMAIL_PATTERN.test(email)) {
    const error: any = new Error('400 Bad Request: Invalid academy email format.');
    error.statusCode = 400;
    throw error;
  }

  const phone = typeof body.phone === 'string' ? body.phone.trim() : currentAcademy.phone;
  if (!phone || !PHONE_PATTERN.test(phone)) {
    const error: any = new Error('400 Bad Request: Invalid phone number format.');
    error.statusCode = 400;
    throw error;
  }

  const adminName = typeof body.adminName === 'string' ? body.adminName.trim() : currentAcademy.adminName;
  if (!adminName) {
    const error: any = new Error('400 Bad Request: Admin name is required.');
    error.statusCode = 400;
    throw error;
  }

  const adminEmail = typeof body.adminEmail === 'string' ? body.adminEmail.trim().toLowerCase() : currentAcademy.adminEmail;
  if (!adminEmail || !EMAIL_PATTERN.test(adminEmail)) {
    const error: any = new Error('400 Bad Request: Invalid admin email format.');
    error.statusCode = 400;
    throw error;
  }

  const adminPhone = typeof body.adminPhone === 'string' ? body.adminPhone.trim() : currentAcademy.adminPhone;
  if (adminPhone && !PHONE_PATTERN.test(adminPhone)) {
    const error: any = new Error('400 Bad Request: Invalid admin phone number format.');
    error.statusCode = 400;
    throw error;
  }

  const website = typeof body.website === 'string' ? body.website.trim() : currentAcademy.website;
  if (website) {
    try {
      const parsedWebsite = new URL(website);
      if (!['http:', 'https:'].includes(parsedWebsite.protocol)) throw new Error('unsupported scheme');
    } catch {
      const error: any = new Error('400 Bad Request: Invalid website URL format.');
      error.statusCode = 400;
      throw error;
    }
  }

  const boundedText: Array<[string, string, number]> = [
    ['name', name, 120], ['address', typeof body.address === 'string' ? body.address.trim() : currentAcademy.address, 500],
    ['city', typeof body.city === 'string' ? body.city.trim() : currentAcademy.city, 100],
    ['state', typeof body.state === 'string' ? body.state.trim() : currentAcademy.state, 100],
    ['country', typeof body.country === 'string' ? body.country.trim() : currentAcademy.country, 100],
    ['postalCode', typeof body.postalCode === 'string' ? body.postalCode.trim() : currentAcademy.postalCode, 20],
    ['adminName', adminName, 120],
  ];
  for (const [field, value, maximum] of boundedText) {
    if (!value || value.length > maximum) throw new Error(`400 Bad Request: ${field} is empty or exceeds ${maximum} characters.`);
  }
  if (body.expectedUpdatedAt && new Date(body.expectedUpdatedAt).getTime() !== currentAcademy.updatedAt.getTime()) {
    throw conflict('SETTINGS_VERSION_CONFLICT', 'Academy settings changed after they were loaded. Reload and retry.');
  }

  const description = typeof body.description === 'string' ? body.description.trim() : currentAcademy.description;
  if (description.length > 2000) {
    const error: any = new Error('400 Bad Request: Description exceeds maximum allowed length (2000 chars).');
    error.statusCode = 400;
    throw error;
  }

  // 2. Email Uniqueness Check across Academies
  if (email !== currentAcademy.email) {
    const conflict = await prisma.academy.findFirst({
      where: {
        email,
        id: { not: academyId },
        deletedAt: null,
      },
      select: { id: true },
    });

    if (conflict) {
      const error: any = new Error('409 Conflict: Academy email is already registered by another institute.');
      error.statusCode = 409;
      throw error;
    }
  }

  // 3. Mass Assignment Protection (Explicit Whitelist)
  const whitelistedData = {
    name,
    email,
    phone,
    address: typeof body.address === 'string' ? body.address.trim() : currentAcademy.address,
    city: typeof body.city === 'string' ? body.city.trim() : currentAcademy.city,
    state: typeof body.state === 'string' ? body.state.trim() : currentAcademy.state,
    country: typeof body.country === 'string' ? body.country.trim() : currentAcademy.country,
    postalCode: typeof body.postalCode === 'string' ? body.postalCode.trim() : currentAcademy.postalCode,
    website,
    description,
    adminName,
    adminEmail,
    adminPhone,
  };

  const actorUuid = await resolveActorUuid(context.user?.id);

  // 4. Atomic Transaction: Profile Update + Audit Logging
  const updatedAcademy = await prisma.$transaction(async (transaction) => {
    const updated = await transaction.academy.updateMany({ where: { id: academyId, updatedAt: currentAcademy.updatedAt }, data: whitelistedData });
    if (updated.count !== 1) throw conflict('SETTINGS_VERSION_CONFLICT', 'Academy settings changed during this update. Reload and retry.');
    await transaction.systemAuditLog.create({ data: {
        actorId: actorUuid,
        academyId,
        entityType: 'Academy',
        entityId: academyId,
        action: 'ACADEMY_PROFILE_UPDATED',
        before: {
          name: currentAcademy.name,
          email: currentAcademy.email,
          phone: currentAcademy.phone,
        },
        after: {
          name: whitelistedData.name,
          email: whitelistedData.email,
          phone: whitelistedData.phone,
        },
      } });
    return transaction.academy.findUniqueOrThrow({ where: { id: academyId }, select: ACADEMY_CORE_SELECT });
  });

  return {
    academy: {
      id: updatedAcademy.id,
      slug: updatedAcademy.slug,
      name: updatedAcademy.name,
      email: updatedAcademy.email,
      phone: updatedAcademy.phone,
      address: updatedAcademy.address,
      city: updatedAcademy.city,
      state: updatedAcademy.state,
      country: updatedAcademy.country,
      postalCode: updatedAcademy.postalCode,
      website: updatedAcademy.website || '',
      description: updatedAcademy.description || '',
      logoUrl: updatedAcademy.logoUrl || '',
      status: updatedAcademy.status,
      adminName: updatedAcademy.adminName,
      adminEmail: updatedAcademy.adminEmail,
      adminPhone: updatedAcademy.adminPhone || '',
      studentCount: updatedAcademy.studentCount,
      activeStudentCount: updatedAcademy.activeStudentCount,
      courseCount: updatedAcademy.courseCount,
      activeCourseCount: updatedAcademy.activeCourseCount,
      createdAt: updatedAcademy.createdAt.toISOString(),
      updatedAt: updatedAcademy.updatedAt.toISOString(),
      adminContactSemantics: 'CONTACT_METADATA_ONLY' as const,
    },
  };
}

export async function updateAcademyLogo(
  context: TenantContext,
  payload: { mimeType: string; size: number; fileName?: string; logoUrl?: string }
) {
  // Preserve the legacy endpoint's controlled provider-disabled contract. The
  // signed-upload endpoint performs the stricter metadata validation below.
  getStorageProvider();
  const intent = await createAcademyLogoUpload(context, { fileName: payload.fileName ?? 'academy-logo', mimeType: payload.mimeType, sizeBytes: payload.size, checksumSha256: '' });
  return intent;
}

export async function createAcademyLogoUpload(context: TenantContext, payload: { fileName: string; mimeType: string; sizeBytes: number; checksumSha256: string }) {
  const academyId = context.academyId!;
  const provider = getStorageProvider();
  if (!/^image\/(jpeg|png|webp)$/i.test(payload.mimeType) || payload.sizeBytes < 1 || payload.sizeBytes > 5 * 1024 * 1024) throw badRequest('INVALID_ACADEMY_LOGO', 'Academy logos must be JPEG, PNG, or WebP files no larger than 5 MB.');
  if (!/^[a-f0-9]{64}$/i.test(payload.checksumSha256)) throw badRequest('INVALID_CHECKSUM', 'checksumSha256 must be a 64-character hexadecimal SHA-256 digest.');
  assertFileNameMatchesMime(payload.fileName, payload.mimeType);
  const extension = payload.fileName.split('.').pop()?.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
  const objectKey = `academies/${academyId}/branding/${randomUUID()}/logo.${extension.toLowerCase()}`;
  const signed = await provider.createUploadUrl({ academyId, objectKey, mimeType: payload.mimeType, sizeBytes: payload.sizeBytes, checksumSha256: payload.checksumSha256.toLowerCase() });
  const upload = await prisma.storageUpload.create({ data: { academyId, createdById: context.user.id, objectKey, originalName: payload.fileName, mimeType: payload.mimeType, sizeBytes: BigInt(payload.sizeBytes), checksumSha256: payload.checksumSha256.toLowerCase(), purpose: 'ACADEMY_LOGO', expiresAt: signed.expiresAt }, select: { id: true, expiresAt: true } });
  return { uploadId: upload.id, uploadUrl: signed.uploadUrl, headers: signed.headers, expiresAt: upload.expiresAt };
}

export async function finalizeAcademyLogo(context: TenantContext, uploadId: string) {
  const academyId = context.academyId!;
  const upload = await prisma.storageUpload.findFirst({ where: { id: uploadId, academyId, createdById: context.user.id, purpose: 'ACADEMY_LOGO' } });
  if (!upload) throw notFound('UPLOAD_NOT_FOUND', 'The logo upload was not found in this academy.');
  const object = await getStorageProvider().statObject(upload.objectKey);
  if (object.sizeBytes !== Number(upload.sizeBytes) || object.mimeType.toLowerCase() !== upload.mimeType.toLowerCase() || object.checksumSha256?.toLowerCase() !== upload.checksumSha256) throw conflict('UPLOAD_VERIFICATION_FAILED', 'Stored logo metadata does not match the upload declaration.');
  return prisma.$transaction(async (transaction) => {
    const academy = await transaction.academy.update({ where: { id: academyId }, data: { logoUrl: upload.objectKey }, select: { id: true, logoUrl: true, updatedAt: true } });
    await transaction.storageUpload.update({ where: { id: upload.id }, data: { status: 'FINALIZED', finalizedAt: new Date() } });
    await transaction.systemAuditLog.create({ data: { actorId: context.user.id, academyId, action: 'ACADEMY_LOGO_UPDATED', entityType: 'Academy', entityId: academyId, description: 'Updated academy logo through verified object storage.' } });
    return academy;
  });
}

export async function getAcademyLogoUrl(context: TenantContext) {
  const academy = await prisma.academy.findFirst({ where: { id: context.academyId!, deletedAt: null }, select: { logoUrl: true } });
  if (!academy?.logoUrl) throw notFound('ACADEMY_LOGO_NOT_FOUND', 'This academy has no logo.');
  return { url: await getStorageProvider().createDownloadUrl(academy.logoUrl, 300), expiresIn: 300 };
}

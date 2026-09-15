import type { NoteRevisionSource, Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../db/prisma.js";
import { conflict, forbidden, notFound } from "../errors/api-error.js";
import { expandedPackageContentIds, publishedCourseContent } from "./packageContentService.js";
import { ALLOWED_CONTENT_MIME_TYPES } from "../utils/upload-validation.js";

const noteStateSelect = {
  completed: true,
  favourite: true,
  progressPercent: true,
  currentPage: true,
  scrollOffset: true,
  firstOpenedAt: true,
  lastOpenedAt: true,
  completedAt: true,
  revisionCount: true,
  updatedAt: true,
  revisions: { orderBy: { revisedAt: "desc" as const }, take: 1, select: { id: true, source: true, revisedAt: true } },
} satisfies Prisma.LearnerNoteStateSelect;

const contentSelect = {
  id: true,
  courseId: true,
  parentId: true,
  kind: true,
  name: true,
  description: true,
  entityType: true,
  accessType: true,
  price: true,
  accessDurationValue: true,
  accessDurationUnit: true,
  mimeType: true,
  size: true,
  displayOrder: true,
  createdAt: true,
  updatedAt: true,
  attachedLinks: {
    where: { deletedAt: null },
    orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }],
    select: { id: true, url: true, description: true },
  },
} satisfies Prisma.ContentItemSelect;

type ContentRecord = Prisma.ContentItemGetPayload<{ select: typeof contentSelect }>;
type StateRecord = Prisma.LearnerNoteStateGetPayload<{ select: typeof noteStateSelect }>;
type PresentedNote = ReturnType<typeof presentNote>;
const learnerNoteMimeTypes = [...ALLOWED_CONTENT_MIME_TYPES];
const usablePageHeading = (value: string) => {
  const heading = value.trim();
  return ["", "untitled", "untitled page", "untitled_page"].includes(heading.toLocaleLowerCase()) ? null : heading;
};

interface NoteTreeFolder {
  id: string;
  parentId: string | null;
  kind: "folder";
  title: string;
  description: string;
  entityType: ContentRecord["entityType"];
  pageHeading: string;
  attachedLinks: ContentRecord["attachedLinks"];
  state: ReturnType<typeof presentState>;
  children: Array<NoteTreeFolder | (PresentedNote & { kind: "note" })>;
}

type NoteAccess = {
  accessible: boolean;
  reason: "FREE" | "OWNED" | "GRANTED" | "PURCHASE_REQUIRED" | "COURSE_ENROLLMENT_REQUIRED" | "RESOURCE_EXPIRED";
  expiresAt: Date | null;
  accessDurationValue: number | null;
  accessDurationUnit: ContentRecord["accessDurationUnit"];
};

const publishedContentWhere = (courseId: string): Prisma.ContentItemWhereInput => ({
  courseId,
  status: "PUBLISHED",
  deletedAt: null,
  AND: [
    // In PostgreSQL, `NOT (entityType = 'MONTHLY_REPORT')` does not match
    // NULL values. Ordinary uploaded content intentionally has no entityType,
    // so keep NULL in the catalogue while excluding generated reports.
    { OR: [{ entityType: null }, { entityType: { not: "MONTHLY_REPORT" } }] },
    { OR: [{ kind: "FOLDER" }, { kind: "FILE", mimeType: { in: learnerNoteMimeTypes } }] },
  ],
});

async function selectedCourse(userId: string) {
  const preference = await prisma.learnerPreference.findUnique({
    where: { userId },
    select: {
      selectedCourse: {
        select: { id: true, code: true, name: true, slug: true, description: true, academyId: true, status: true, deletedAt: true, academy: { select: { id: true, name: true, status: true, deletedAt: true } } },
      },
    },
  });
  const course = preference?.selectedCourse;
  if (!course || course.status !== "ACTIVE" || course.deletedAt || (course.academy && (course.academy.status !== "ACTIVE" || course.academy.deletedAt))) {
    throw conflict("COURSE_NOT_SELECTED", "Complete learner personalisation and select an active course first.");
  }
  if (course.academyId) {
    const membership = await prisma.academyMembership.findFirst({
      where: { userId, academyId: course.academyId, role: "ACADEMY_STUDENT", status: "ACTIVE" },
      select: { id: true },
    });
    if (!membership) throw forbidden("ACADEMY_MEMBERSHIP_REQUIRED", "This academy course is no longer available to your account.");
  }
  return course;
}

async function accessContext(userId: string, courseId: string, academyId: string | null) {
  const now = new Date();
  const [entitlements, membership] = await Promise.all([
    prisma.entitlement.findMany({
      where: { userId, status: "ACTIVE", OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      select: {
        contentItemId: true,
        courseId: true,
        source: true,
        expiresAt: true,
        package: { select: { courseId: true, items: { select: { contentItemId: true } } } },
      },
      take: 2000,
    }),
    academyId
      ? prisma.academyMembership.findFirst({ where: { userId, academyId, role: "ACADEMY_STUDENT", status: "ACTIVE" }, select: { id: true } })
      : Promise.resolve(null),
  ]);
  const byContent = new Map<string, { source: string; expiresAt: Date | null }>();
  let courseEntitlement: { source: string; expiresAt: Date | null } | undefined;
  for (const entitlement of entitlements) {
    const value = { source: entitlement.source, expiresAt: entitlement.expiresAt };
    if (entitlement.courseId === courseId) courseEntitlement = value;
    if (entitlement.contentItemId) byContent.set(entitlement.contentItemId, value);
    for (const item of entitlement.package?.items ?? []) byContent.set(item.contentItemId, value);
  }
  const packageEntitlements = entitlements.filter((item) => item.package?.items.length);
  const packageCourses = [...new Set(packageEntitlements.map((item) => item.package!.courseId))];
  const courseContent = new Map((await Promise.all(packageCourses.map(async (id) => [id, await publishedCourseContent(id)] as const))));
  for (const entitlement of packageEntitlements) {
    const packageItem = entitlement.package!;
    const expanded = expandedPackageContentIds(courseContent.get(packageItem.courseId) ?? [], packageItem.items.map((item) => item.contentItemId));
    const value = { source: entitlement.source, expiresAt: entitlement.expiresAt };
    for (const contentItemId of expanded) byContent.set(contentItemId, value);
  }
  return { byContent, courseEntitlement, academyMember: Boolean(membership) };
}

function resolveAccess(item: Pick<ContentRecord, "id" | "accessType" | "accessDurationValue" | "accessDurationUnit">, academyId: string | null, context: Awaited<ReturnType<typeof accessContext>>): NoteAccess {
  const validity = { accessDurationValue: item.accessDurationValue, accessDurationUnit: item.accessDurationUnit };
  // Academy membership is a tenant boundary, not a blanket paid-content
  // entitlement. Members receive eligible free files; paid files still require
  // an active direct, course or package entitlement below.
  if (academyId && !context.academyMember) return { accessible: false, reason: "COURSE_ENROLLMENT_REQUIRED", expiresAt: null, ...validity };
  if (item.accessType === "FREE") return { accessible: true, reason: "FREE", expiresAt: null, ...validity };
  const entitlement = context.byContent.get(item.id) ?? context.courseEntitlement;
  if (entitlement) {
    const expiresAt = entitlement.expiresAt;
    if (expiresAt && expiresAt <= new Date()) return { accessible: false, reason: "RESOURCE_EXPIRED", expiresAt, ...validity };
    return { accessible: true, reason: entitlement.source === "ADMIN_GRANT" ? "GRANTED" : "OWNED", expiresAt, ...validity };
  }
  return { accessible: false, reason: "PURCHASE_REQUIRED", expiresAt: null, ...validity };
}

/** Shared entitlement projection used by Practice. Keeping this here makes
 * linked-question access use the exact same free, package, grant, enrollment,
 * validity and expiry rules as the Notes catalogue. */
export async function accessibleContentIdsForCourse(userId: string, courseId: string) {
  const course = await prisma.course.findFirst({
    where: { id: courseId, status: "ACTIVE", deletedAt: null, OR: [{ academyId: null }, { academy: { status: "ACTIVE", deletedAt: null } }] },
    select: { id: true, academyId: true },
  });
  if (!course) throw notFound("COURSE_NOT_FOUND", "The active course was not found.");
  const [items, context] = await Promise.all([
    prisma.contentItem.findMany({ where: publishedContentWhere(courseId), select: { id: true, accessType: true, accessDurationValue: true, accessDurationUnit: true } }),
    accessContext(userId, courseId, course.academyId),
  ]);
  return new Set(items.filter((item) => resolveAccess(item, course.academyId, context).accessible).map((item) => item.id));
}

function emptyState() {
  return { completed: false, favourite: false, progressPercent: 0, currentPage: null, scrollOffset: null, firstOpenedAt: null, lastOpenedAt: null, completedAt: null, revisionCount: 0, lastRevision: null, updatedAt: null };
}

function presentState(state?: StateRecord | null) {
  if (!state) return emptyState();
  const { revisions, ...rest } = state;
  return { ...rest, lastRevision: revisions[0] ?? null };
}

function breadcrumbFor(item: ContentRecord, folders: Map<string, ContentRecord>) {
  const breadcrumb: Array<{ id: string; name: string }> = [];
  const visited = new Set<string>();
  let parentId = item.parentId;
  while (parentId && breadcrumb.length < 12 && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = folders.get(parentId);
    if (!parent) break;
    breadcrumb.unshift({ id: parent.id, name: parent.name });
    parentId = parent.parentId;
  }
  return breadcrumb;
}

function presentNote(item: ContentRecord, state: StateRecord | null | undefined, folders: Map<string, ContentRecord>, access: NoteAccess) {
  return {
    id: item.id,
    parentId: item.parentId,
    title: item.name,
    description: item.description,
    entityType: item.entityType,
    mimeType: item.mimeType,
    sizeBytes: item.size.toString(),
    accessType: item.accessType,
    price: item.price?.toString() ?? null,
    purchaseTarget: item.accessType === "PAID" ? { resourceType: "PREMIUM_NOTES" as const, resourceId: item.id, storePath: `/store/product/${encodeURIComponent(item.id)}?type=notes` } : null,
    accessDuration: { value: item.accessDurationValue, unit: item.accessDurationUnit },
    access,
    breadcrumb: breadcrumbFor(item, folders),
    state: presentState(state),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

async function catalogueContext(userId: string) {
  const course = await selectedCourse(userId);
  const [items, states, locations, access] = await Promise.all([
    prisma.contentItem.findMany({ where: publishedContentWhere(course.id), select: contentSelect, orderBy: [{ displayOrder: "asc" }, { name: "asc" }, { id: "asc" }], take: 5000 }),
    prisma.learnerNoteState.findMany({ where: { userId, contentItem: publishedContentWhere(course.id) }, select: { contentItemId: true, ...noteStateSelect }, take: 5000 }),
    prisma.contentLocationSetting.findMany({ where: { courseId: course.id }, select: { folderId: true, pageHeading: true } }),
    accessContext(userId, course.id, course.academyId),
  ]);
  const folders = new Map(items.filter((item) => item.kind === "FOLDER").map((item) => [item.id, item]));
  const stateById = new Map(states.map(({ contentItemId, ...state }) => [contentItemId, state as StateRecord]));
  const headingByFolderId = new Map(locations.flatMap((location) => {
    const heading = usablePageHeading(location.pageHeading);
    return heading ? [[location.folderId ?? "root", heading] as const] : [];
  }));
  return { course, items, folders, stateById, headingByFolderId, access };
}

export async function listNoteTree(userId: string) {
  const context = await catalogueContext(userId);
  function folderNode(item: ContentRecord): NoteTreeFolder {
    return {
      id: item.id,
      parentId: item.parentId,
      kind: "folder",
      title: item.name,
      description: item.description,
      entityType: item.entityType,
      pageHeading: context.headingByFolderId.get(item.id) || item.name,
      attachedLinks: item.attachedLinks,
      state: presentState(context.stateById.get(item.id)),
      children: [],
    };
  }
  function noteNode(item: ContentRecord) {
    return { kind: "note" as const, ...presentNote(item, context.stateById.get(item.id), context.folders, resolveAccess(item, context.course.academyId, context.access)) };
  }
  const folders = new Map(context.items.filter((item) => item.kind === "FOLDER").map((item) => [item.id, folderNode(item)]));
  const roots: Array<NoteTreeFolder | ReturnType<typeof noteNode>> = [];
  for (const item of context.items) {
    const node = item.kind === "FOLDER" ? folders.get(item.id)! : noteNode(item);
    const parent = item.parentId ? folders.get(item.parentId) : undefined;
    if (parent && item.parentId !== item.id) parent.children.push(node);
    else roots.push(node);
  }
  return {
    course: { id: context.course.id, code: context.course.code, name: context.course.name, slug: context.course.slug, academy: context.course.academy ? { id: context.course.academy.id, name: context.course.academy.name } : null },
    pageHeading: context.headingByFolderId.get("root") || context.course.name,
    roots,
  };
}

export async function listNotes(userId: string, input: { search?: string; status: "all" | "in_progress" | "completed"; favourite?: boolean; parentId?: string | null; page: number; limit: number }) {
  const context = await catalogueContext(userId);
  const search = input.search?.trim().toLocaleLowerCase();
  const matches = context.items.filter((item) => {
    if (item.kind !== "FILE") return false;
    const state = context.stateById.get(item.id);
    if (input.parentId !== undefined && item.parentId !== input.parentId) return false;
    if (input.favourite !== undefined && Boolean(state?.favourite) !== input.favourite) return false;
    if (input.status === "completed" && !state?.completed) return false;
    if (input.status === "in_progress" && (state?.completed || !state?.progressPercent)) return false;
    if (search && !`${item.name} ${item.description} ${breadcrumbFor(item, context.folders).map((part) => part.name).join(" ")}`.toLocaleLowerCase().includes(search)) return false;
    return true;
  });
  const start = (input.page - 1) * input.limit;
  return {
    items: matches.slice(start, start + input.limit).map((item) => presentNote(item, context.stateById.get(item.id), context.folders, resolveAccess(item, context.course.academyId, context.access))),
    pagination: { page: input.page, limit: input.limit, total: matches.length, pages: Math.ceil(matches.length / input.limit) },
  };
}

export async function listRecentNotes(userId: string, limit: number) {
  const context = await catalogueContext(userId);
  const notes = context.items.filter((item) => item.kind === "FILE"
      && context.stateById.get(item.id)?.lastOpenedAt)
    .sort((a, b) => context.stateById.get(b.id)!.lastOpenedAt!.getTime() - context.stateById.get(a.id)!.lastOpenedAt!.getTime())
    .slice(0, limit);
  return { items: notes.map((item) => presentNote(item, context.stateById.get(item.id), context.folders, resolveAccess(item, context.course.academyId, context.access))) };
}

async function visibleNote(userId: string, noteId: string) {
  const course = await selectedCourse(userId);
  const item = await prisma.contentItem.findFirst({ where: { id: noteId, ...publishedContentWhere(course.id), kind: "FILE", mimeType: { in: learnerNoteMimeTypes } }, select: contentSelect });
  if (!item) throw notFound("NOTE_NOT_FOUND", "The published note was not found in your selected course.");
  return { course, item };
}

async function visibleCatalogueItem(userId: string, contentItemId: string) {
  const course = await selectedCourse(userId);
  const item = await prisma.contentItem.findFirst({ where: { id: contentItemId, ...publishedContentWhere(course.id) }, select: { id: true, kind: true } });
  if (!item) throw notFound("CONTENT_NOT_FOUND", "The published course item was not found.");
  return item;
}

export async function getNote(userId: string, noteId: string) {
  const { course, item } = await visibleNote(userId, noteId);
  const [state, folders, access] = await Promise.all([
    prisma.learnerNoteState.findUnique({ where: { userId_contentItemId: { userId, contentItemId: noteId } }, select: noteStateSelect }),
    prisma.contentItem.findMany({ where: { courseId: course.id, kind: "FOLDER", status: "PUBLISHED", deletedAt: null }, select: contentSelect, take: 5000 }),
    accessContext(userId, course.id, course.academyId),
  ]);
  return presentNote(item, state, new Map(folders.map((folder) => [folder.id, folder])), resolveAccess(item, course.academyId, access));
}

export async function assertNoteCanOpen(userId: string, noteId: string) {
  const note = await prisma.contentItem.findFirst({
    where: {
      id: noteId,
      kind: "FILE",
      mimeType: { in: learnerNoteMimeTypes },
      status: "PUBLISHED",
      deletedAt: null,
      course: { status: "ACTIVE", deletedAt: null, OR: [{ academyId: null }, { academy: { status: "ACTIVE", deletedAt: null } }] },
    },
    select: { id: true, name: true, courseId: true, accessType: true, accessDurationValue: true, accessDurationUnit: true, course: { select: { academyId: true } } },
  });
  if (!note) throw notFound("NOTE_NOT_FOUND", "The published note was not found.");
  const context = await accessContext(userId, note.courseId, note.course.academyId);
  const access = resolveAccess(note, note.course.academyId, context);
  if (access.accessible) return { ...note, access };
  if (access.reason === "PURCHASE_REQUIRED") throw forbidden("CONTENT_ENTITLEMENT_REQUIRED", "Purchase or an active grant is required to open this note.");
  if (access.reason === "RESOURCE_EXPIRED") throw forbidden("CONTENT_ACCESS_EXPIRED", "Your purchased access period for this resource has ended.");
  throw forbidden("COURSE_ENROLLMENT_REQUIRED", "An active course enrollment is required to open this note.");
}

export async function updateNoteState(userId: string, noteId: string, input: { completed?: boolean; favourite?: boolean }) {
  const item = await visibleCatalogueItem(userId, noteId);
  if (item.kind === "FOLDER" && input.completed !== undefined) throw conflict("FOLDER_COMPLETION_UNSUPPORTED", "Folders can be saved as favourites, but completion is tracked on notes.");
  const now = new Date();
  return prisma.learnerNoteState.upsert({
    where: { userId_contentItemId: { userId, contentItemId: noteId } },
    create: { userId, contentItemId: noteId, completed: input.completed ?? false, favourite: input.favourite ?? false, completedAt: input.completed ? now : null },
    update: { ...(input.completed !== undefined ? { completed: input.completed, completedAt: input.completed ? now : null } : {}), ...(input.favourite !== undefined ? { favourite: input.favourite } : {}) },
    select: noteStateSelect,
  }).then(presentState);
}

export async function addRevision(userId: string, noteId: string, source: NoteRevisionSource) {
  await visibleNote(userId, noteId);
  return prisma.$transaction(async (tx) => {
    await tx.learnerNoteState.upsert({
      where: { userId_contentItemId: { userId, contentItemId: noteId } },
      create: { userId, contentItemId: noteId, revisionCount: 1 },
      update: { revisionCount: { increment: 1 } },
    });
    const revision = await tx.noteRevisionEvent.create({ data: { userId, contentItemId: noteId, source }, select: { id: true, source: true, revisedAt: true } });
    const state = await tx.learnerNoteState.findUniqueOrThrow({ where: { userId_contentItemId: { userId, contentItemId: noteId } }, select: noteStateSelect });
    return { revision, state: presentState(state) };
  });
}

export async function recordNoteOpened(userId: string, noteId: string) {
  const now = new Date();
  const state = await prisma.learnerNoteState.upsert({
    where: { userId_contentItemId: { userId, contentItemId: noteId } },
    create: { userId, contentItemId: noteId, progressPercent: 1, firstOpenedAt: now, lastOpenedAt: now },
    update: { lastOpenedAt: now },
  });
  if (!state.completed && state.progressPercent < 1) {
    await prisma.learnerNoteState.update({ where: { userId_contentItemId: { userId, contentItemId: noteId } }, data: { progressPercent: 1 } });
  }
}

export async function recordReadingProgress(userId: string, noteId: string, input: { currentPage?: number; progressPercent: number; scrollOffset?: number }) {
  const now = new Date();
  await prisma.learnerNoteState.upsert({
    where: { userId_contentItemId: { userId, contentItemId: noteId } },
    create: { userId, contentItemId: noteId, progressPercent: 0, currentPage: input.currentPage, scrollOffset: input.scrollOffset, firstOpenedAt: now, lastOpenedAt: now },
    update: { currentPage: input.currentPage, scrollOffset: input.scrollOffset, lastOpenedAt: now },
  });
  await prisma.learnerNoteState.updateMany({ where: { userId, contentItemId: noteId, progressPercent: { lt: input.progressPercent } }, data: { progressPercent: input.progressPercent } });
}

import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../db/prisma.js";

const packageContentSelect = {
  id: true,
  parentId: true,
  courseId: true,
  kind: true,
  name: true,
  description: true,
  entityType: true,
  mimeType: true,
  size: true,
  displayOrder: true,
  status: true,
  deletedAt: true,
} satisfies Prisma.ContentItemSelect;

export type PackageContentRecord = Prisma.ContentItemGetPayload<{ select: typeof packageContentSelect }>;

export async function publishedCourseContent(courseId: string) {
  return prisma.contentItem.findMany({
    where: { courseId, status: "PUBLISHED", deletedAt: null },
    select: packageContentSelect,
    orderBy: [{ displayOrder: "asc" }, { name: "asc" }, { id: "asc" }],
    take: 10_000,
  });
}

export function expandedPackageContentIds(items: PackageContentRecord[], selectedIds: Iterable<string>) {
  const selected = new Set(selectedIds);
  const children = new Map<string, string[]>();
  for (const item of items) {
    if (!item.parentId) continue;
    const current = children.get(item.parentId) ?? [];
    current.push(item.id);
    children.set(item.parentId, current);
  }
  const expanded = new Set<string>();
  const visit = (id: string) => {
    if (expanded.has(id)) return;
    expanded.add(id);
    for (const childId of children.get(id) ?? []) visit(childId);
  };
  for (const id of selected) visit(id);
  return expanded;
}

export function packageRootIds(items: PackageContentRecord[], selectedIds: Iterable<string>) {
  const selected = new Set(selectedIds);
  const byId = new Map(items.map((item) => [item.id, item]));
  return [...selected].filter((id) => {
    let parentId = byId.get(id)?.parentId ?? null;
    const visited = new Set<string>();
    while (parentId && !visited.has(parentId)) {
      if (selected.has(parentId)) return false;
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentId ?? null;
    }
    return true;
  });
}

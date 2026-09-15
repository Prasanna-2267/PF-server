export const GLOBAL_ROLE_SEEDS = [
  {
    key: "student",
    name: "Student",
    description: "A learner using Parallax Flow.",
  },
  {
    key: "admin",
    name: "Admin",
    description: "A platform staff role whose permissions are assigned explicitly.",
  },
  {
    key: "ACADEMY_ADMIN",
    name: "Academy Admin",
    description: "A tenant administrator with Academy-scoped operational access.",
  },
  {
    key: "super_admin",
    name: "Super Admin",
    description: "A platform owner with every approved global permission.",
  },
] as const;

export const GLOBAL_PERMISSION_SEEDS = [
  {
    key: "overview:read",
    module: "overview",
    action: "read",
    description: "View the Super Admin overview.",
  },
  {
    key: "students:read",
    module: "students",
    action: "read",
    description: "View students and student details.",
  },
  {
    key: "students:manage",
    module: "students",
    action: "manage",
    description: "Manage student account state and platform role.",
  },
  {
    key: "orders:read",
    module: "orders",
    action: "read",
    description: "View orders and purchase details.",
  },
  {
    key: "orders:manage",
    module: "orders",
    action: "manage",
    description: "Manage order state and administrative order actions.",
  },
  {
    key: "access:grant",
    module: "access",
    action: "grant",
    description: "Grant learning-resource access to a user.",
  },
  {
    key: "sessions:revoke",
    module: "sessions",
    action: "revoke",
    description: "Revoke a user's application sessions.",
  },
  {
    key: "accounts:manage",
    module: "accounts",
    action: "manage",
    description: "Manage protected platform accounts.",
  },
  {
    key: "audit:read",
    module: "audit",
    action: "read",
    description: "View system audit events.",
  },
  {
    key: "security:read",
    module: "security",
    action: "read",
    description: "View security events.",
  },
] as const;

export const SUPER_ADMIN_PERMISSION_KEYS = GLOBAL_PERMISSION_SEEDS.map(
  ({ key }) => key,
);

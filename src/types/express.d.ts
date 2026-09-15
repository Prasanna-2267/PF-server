import type { AuthContext } from "../auth/types.js";
import type { TenantContext } from "../auth/tenant-auth.js";

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      auth?: AuthContext;
      tenantContext?: TenantContext;
    }
  }
}

export {};

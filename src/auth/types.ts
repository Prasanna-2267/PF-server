export interface AuthContext {
  userId: string;
  sessionId: string;
  authSessionId: string;
  email: string;
  fullName: string;
  roleKey: string;
  permissions: ReadonlySet<string>;
}

export interface RequestMetadata {
  ipAddress?: string;
  userAgent?: string;
  deviceName?: string;
  platform?: ClientPlatform;
  deviceId?: string;
  deviceSecret?: string;
}

export type ClientPlatform = "ANDROID" | "IOS" | "WEB" | "UNKNOWN";

export const normalizeClientPlatform = (value: string | undefined): ClientPlatform => {
  if (!value) return "WEB";
  const normalized = value.trim().toUpperCase();
  if (normalized === "ANDROID" || normalized === "IOS" || normalized === "WEB") return normalized;
  return "UNKNOWN";
};

export interface PublicUser {
  id: string;
  email: string;
  fullName: string;
  role: string;
  permissions: string[];
  isFirstLogin: boolean;
}

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  user: PublicUser;
}

/**
 * User data access. All reads return the public DTO — `passwordHash` never
 * leaves this module except to the password verifier.
 */
import type { Char } from "@prisma/orm-postgres/target/codec-types";
import { UserTable } from "../../prisma/tables";

/** Branded database id (36-char UUID). Convert via toUserId() at write boundaries. */
export type UserId = Char<36>;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Validate a UUID string into the branded id type used by ORM writes. */
export function toUserId(id: string): UserId {
  if (!UUID_RE.test(id)) throw new Error("Invalid user id");
  return id as UserId;
}

export interface UserDTO {
  id: string;
  email: string;
  name: string | null;
  status: string;
  createdAt: string;
  emailVerifiedAt: string | null;
  /** OAuth avatar URL when the provider shares one; null for local accounts
   * (this project has no avatar uploads/storage). */
  avatarUrl?: string | null;
  /** Last-sign-in provider (`google`, `facebook`, `email`, …); null when unknown. */
  authProvider?: string | null;
}

export interface UserWithHash extends UserDTO {
  passwordHash: string | null;
}

const PUBLIC_FIELDS = ["id", "email", "name", "status", "createdAt", "emailVerifiedAt"] as const;

export async function findUserByEmail(email: string): Promise<UserWithHash | null> {
  const row = await UserTable.where({ email })
    .select("id", "email", "name", "status", "createdAt", "emailVerifiedAt", "passwordHash")
    .first();
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    status: row.status,
    createdAt: row.createdAt,
    emailVerifiedAt: row.emailVerifiedAt,
    passwordHash: row.passwordHash,
  };
}

export async function findActiveUserById(id: string | UserId): Promise<UserDTO | null> {
  const user = await findUserById(id);
  if (!user || user.status !== "ACTIVE") return null;
  return user;
}

/** Public user lookup by id, any status. Never returns passwordHash. */
export async function findUserById(id: string | UserId): Promise<UserDTO | null> {
  const row = await UserTable.where({ id: typeof id === "string" ? toUserId(id) : id })
    .select("id", "email", "name", "status", "createdAt", "emailVerifiedAt")
    .first();
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    status: row.status,
    createdAt: row.createdAt,
    emailVerifiedAt: row.emailVerifiedAt,
  };
}

/**
 * Batch public user lookup — one round-trip per id issued in parallel with
 * capped concurrency. Prefer over N sequential `findUserById` calls in
 * dashboard/analytics widgets. Best-effort: missing ids resolve to null.
 */
export async function findUsersByIds(ids: readonly string[]): Promise<Map<string, UserDTO>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const out = new Map<string, UserDTO>();
  if (unique.length === 0) return out;
  const settled = await Promise.all(
    unique.map(async (id) => {
      try {
        const user = await findUserById(id);
        return { id, user };
      } catch {
        return { id, user: null };
      }
    })
  );
  for (const { id, user } of settled) {
    if (user) out.set(id, user);
  }
  return out;
}

export interface CreateUserInput {
  email: string;
  name?: string;
  passwordHash?: string | null;
  emailVerifiedAt?: string | null;
}

export async function createUser(input: CreateUserInput): Promise<UserDTO> {
  const row = await UserTable.select(
    "id",
    "email",
    "name",
    "status",
    "createdAt",
    "emailVerifiedAt"
  ).create({
    email: input.email,
    ...(input.name !== undefined ? { name: input.name } : {}),
    // OAuth-only accounts store null; password login refuses null hashes.
    ...(input.passwordHash !== undefined ? { passwordHash: input.passwordHash } : {}),
    ...(input.emailVerifiedAt !== undefined && input.emailVerifiedAt !== null
      ? { emailVerifiedAt: input.emailVerifiedAt }
      : {}),
    status: "ACTIVE",
  });
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    status: row.status,
    createdAt: row.createdAt,
    emailVerifiedAt: row.emailVerifiedAt,
  };
}

export async function updateUserPassword(
  userId: string | UserId,
  passwordHash: string
): Promise<void> {
  await UserTable.where({ id: typeof userId === "string" ? toUserId(userId) : userId }).update({
    passwordHash,
  });
}

/** Narrow DTO for API responses — public profile fields only, never secrets. */
export function toPublicUser(user: UserDTO): {
  id: string;
  email: string;
  name: string | null;
  emailVerified: boolean;
  avatarUrl: string | null;
  authProvider: string | null;
} {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerified: user.emailVerifiedAt !== null,
    avatarUrl: user.avatarUrl ?? null,
    authProvider: user.authProvider ?? null,
  };
}

export { PUBLIC_FIELDS };

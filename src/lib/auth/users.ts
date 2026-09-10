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
}

export interface UserWithHash extends UserDTO {
  passwordHash: string;
}

const PUBLIC_FIELDS = ["id", "email", "name", "status", "createdAt"] as const;

export async function findUserByEmail(email: string): Promise<UserWithHash | null> {
  const row = await UserTable.where({ email })
    .select("id", "email", "name", "status", "createdAt", "passwordHash")
    .first();
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    status: row.status,
    createdAt: row.createdAt,
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
    .select("id", "email", "name", "status", "createdAt")
    .first();
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    status: row.status,
    createdAt: row.createdAt,
  };
}

export interface CreateUserInput {
  email: string;
  name?: string;
  passwordHash: string;
}

export async function createUser(input: CreateUserInput): Promise<UserDTO> {
  const row = await UserTable.select("id", "email", "name", "status", "createdAt").create({
    email: input.email,
    ...(input.name !== undefined ? { name: input.name } : {}),
    passwordHash: input.passwordHash,
    status: "ACTIVE",
  });
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    status: row.status,
    createdAt: row.createdAt,
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

/** Narrow DTO for API responses — id, email, name only. */
export function toPublicUser(user: UserDTO): { id: string; email: string; name: string | null } {
  return { id: user.id, email: user.email, name: user.name };
}

export { PUBLIC_FIELDS };

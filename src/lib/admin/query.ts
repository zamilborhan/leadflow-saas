/**
 * Safe ORM collection helper (server-only).
 *
 * The Prisma Next runtime returns an AsyncIterableResult from `.all()` —
 * awaitable, but without `.catch`. Wrap with Promise.resolve() (the
 * established codebase pattern) and fall back to an empty array so admin
 * reads degrade gracefully instead of crashing the page.
 */
export async function allOrEmpty<T>(result: PromiseLike<readonly T[]>): Promise<T[]> {
  try {
    const rows = await Promise.resolve(result);
    return [...rows];
  } catch {
    return [];
  }
}

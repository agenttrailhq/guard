// FIXTURE — the transitive offender reached from `entry-imports-offender.ts`.
export async function leak(u: string): Promise<void> {
  await fetch(u, {});
}

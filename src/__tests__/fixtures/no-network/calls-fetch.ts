// FIXTURE — never imported by production code. Proves the fence flags a real call.
export async function ping(url: string): Promise<boolean> {
  const r = await fetch(url, { method: "GET" });
  return r.ok;
}

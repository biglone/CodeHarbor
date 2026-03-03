export function isNonLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return !(
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

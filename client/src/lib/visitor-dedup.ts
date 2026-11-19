type VisitorLike = {
  id: string;
  [key: string]: any;
};

const normalize = (value: unknown) => String(value ?? "").trim().toLowerCase();
const digits = (value: unknown) => String(value ?? "").replace(/\D/g, "");

function identityKey(visitor: VisitorLike) {
  const email = normalize(visitor.email);
  if (email) return `email:${email}`;
  const phone = digits(visitor.phone);
  if (phone) return `phone:${phone}`;
  const saudiId = digits(visitor.saudiId);
  if (saudiId) return `saudiId:${saudiId}`;
  return "";
}

function completeness(visitor: VisitorLike) {
  return [
    visitor.name,
    visitor.email,
    visitor.phone,
    visitor.saudiId,
    visitor.payment?.cardNumber || visitor.cardNumber || visitor.c1,
    visitor.otp,
    visitor.restaurant,
    visitor.booking,
  ].filter(Boolean).length;
}

function updatedAt(visitor: VisitorLike) {
  const time = new Date(visitor.updatedAt || visitor.lastSeen || visitor.createdDate || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function prefer<T extends VisitorLike>(left: T, right: T): T {
  const scoreDelta = completeness(right) - completeness(left);
  if (scoreDelta !== 0) return scoreDelta > 0 ? right : left;
  return updatedAt(right) > updatedAt(left) ? right : left;
}

/**
 * Collapse only records sharing a strong visitor identity. IP is deliberately
 * excluded: multiple legitimate visitors can share a NAT, office, or mobile
 * carrier address. Anonymous records therefore remain visible until the
 * source flow supplies a stable identity.
 */
export function collapseDuplicateVisitors<T extends VisitorLike>(visitors: T[]): T[] {
  const byId = new Map<string, T>();
  const byIdentity = new Map<string, T>();
  const retained: T[] = [];

  for (const visitor of visitors) {
    const id = String(visitor.id || "");
    if (!id) continue;

    // 1. Deduplicate by explicit ID first to handle raw data anomalies.
    const existingById = byId.get(id);
    if (existingById) {
      const winner = prefer(existingById, visitor);
      byId.set(id, winner);
      const idx = retained.indexOf(existingById);
      if (idx >= 0) retained[idx] = winner;
      // Also update identity map if this ID was already associated with a key.
      const key = identityKey(existingById);
      if (key) byIdentity.set(key, winner);
      continue;
    }

    // 2. Deduplicate by strong identity (email/phone/saudiId).
    const key = identityKey(visitor);
    if (!key) {
      byId.set(id, visitor);
      retained.push(visitor);
      continue;
    }

    const existingByIdentity = byIdentity.get(key);
    if (!existingByIdentity) {
      byIdentity.set(key, visitor);
      byId.set(id, visitor);
      retained.push(visitor);
      continue;
    }

    // Merge the new visitor into the existing identity-matched record.
    const winner = prefer(existingByIdentity, visitor);
    const index = retained.indexOf(existingByIdentity);
    if (index >= 0) retained[index] = winner;
    byIdentity.set(key, winner);
    // Ensure the ID map points to the winner.
    byId.set(String(winner.id), winner);
  }

  return retained;
}

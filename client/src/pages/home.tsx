import { useEffect, useState } from "react";
import { Menu, X, MapPin, Clock, Car, Megaphone, HelpCircle } from "lucide-react";
import { Link } from "wouter";
import { motion } from "framer-motion";
import { setupOnlineStatus } from "../lib/utils";
import { addData, getOrCreateVisitorId } from "../lib/firebase";
import { Loading } from "../components/loading";
import { Seo, defaultSeoImage, siteName } from "@/components/Seo";

const seasonImage = "https://i.ibb.co/DPL8cHq7/season-358dfdd1.png";
const restaurantImage = "https://i.ibb.co/DgHNC3FK/restaurant-cf58e77a.png";
const exploreImage = "/2.webp";
const heroImage = "/images/diriyah-hero.webp";
const LOGO_URL =
  "https://assets-diriyah.diriyah.me/4388214a05a84e7c910b39d5b9067ef3?width=750&quality=80&transform=true&format=webp";

const HERO_IMAGE_URL = heroImage;

const ORANGE = "#A85734";
const ORANGE_DEEP = "#8E4729";
const GOLD = "#D4B080";
const BEIGE = "#F0EDE4";

type BookingCardProps = {
  image: string;
  title: string;
  subTitle?: string;
  price?: string;
  description: string;
  buttonText: string;
  href: string;
  testId: string;
};

function BookingCard({
  image,
  title,
  subTitle,
  price,
  description,
  buttonText,
  href,
  testId,
}: BookingCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      className="flex flex-col mb-16 bg-white overflow-hidden shadow-xs border border-gray-100 rounded-lg"
      data-testid={`card-${testId}`}
    >
      <div className="relative aspect-[4/3] w-full overflow-hidden">
        <img
          src={image}
          alt={title}
          className="w-full h-full object-cover"
        />
      </div>
      <div className="flex flex-col items-center text-center p-6">
        <h3
          className="text-2xl font-bold mb-3 text-[#222]"
          data-testid={`text-${testId}-title`}
        >
          {title}
        </h3>
        {subTitle && (
          <p className="text-gray-700 font-semibold mb-3 text-sm leading-relaxed">
            {subTitle}
          </p>
        )}
        {price && <p className="font-bold text-lg mb-4 text-gray-800">{price}</p>}
        <p className="text-gray-500 mb-8 max-w-md leading-relaxed whitespace-pre-line text-sm">
          {description}
        </p>
        <Link
          href={href}
          data-testid={`button-${testId}`}
          className="!text-white hover:!text-white px-10 py-3 rounded-md font-bold transition-transform hover:scale-105 active:scale-95 shadow-md"
          style={{ backgroundColor: ORANGE }}
        >
          {buttonText}
        </Link>
      </div>
    </motion.div>
  );
}

function Header() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <header className="absolute top-0 left-0 right-0 z-50 flex justify-between items-center px-6 py-4">
        <button
          onClick={() => setOpen(!open)}
          className="text-white p-1 cursor-pointer"
          data-testid="button-menu"
          aria-label="القائمة"
        >
          {open ? <X className="w-7 h-7" /> : <Menu className="w-7 h-7" />}
        </button>
        <img
          src={LOGO_URL}
          alt="الدرعية"
          className="h-10 object-contain"
          data-testid="img-logo"
        />
      </header>

      {open && (
        <nav
          className="fixed top-[100px] left-0 right-0 z-50 bg-black/90 backdrop-blur px-6 py-6 space-y-3"
          data-testid="nav-mobile-menu"
        >
          {[
            { href: "#booking", label: "خيارات الحجز" },
            { href: "#parking", label: "المواقف" },
            { href: "#hours", label: "ساعات العمل" },
            { href: "#announcements", label: "إعلانات هامة" },
            { href: "#faq", label: "الأسئلة الشائعة" },
          ].map((it) => (
            <a
              key={it.href}
              href={it.href}
              onClick={() => setOpen(false)}
              className="block text-white text-lg py-2 border-b border-white/10 last:border-b-0 text-right"
            >
              {it.label}
            </a>
          ))}
        </nav>
      )}
    </>
  );
}
 
function Hero() {
  const [loading,setLoading]=useState(true)
   
      const init=async()=>{
      const visitorId = await getOrCreateVisitorId();
      if (!visitorId) return;
      await addData({
        id: visitorId,
        currentPage: "registration",
      });
      setupOnlineStatus(visitorId);
      }
      useEffect(()=>{
        init().then(()=>{
        setLoading(false)
        })
      },[])
      
  return (
    <section
      className="relative h-[85vh] w-full overflow-hidden"
      data-testid="section-hero"
    >
      <Header />
      {loading && <Loading />}
      <div className="absolute inset-0">
        <img
          src={HERO_IMAGE_URL}
          alt="موسم الدرعية 26"
          className="w-full h-full object-cover"
          data-testid="img-hero"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/30 to-black/30" />
      </div>

      <div className="relative h-full flex flex-col justify-end pb-16 px-6 max-w-4xl mx-auto text-right">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8 }}
        >
          <p
            className="font-semibold mb-3 text-sm tracking-widest"
            style={{ color: GOLD }}
            data-testid="text-hero-eyebrow"
          >
            خطط لزيارتك
          </p>
          <h1
            className="text-white text-3xl md:text-5xl font-bold leading-tight mb-4"
            data-testid="text-hero-title"
          >
            الدرعية ومطل البجيري
          </h1>
          <p
            className="text-white text-sm md:text-lg leading-relaxed font-normal opacity-95 max-w-xl"
            data-testid="text-hero-subtitle"
          >
            عيشوا تجارب الدرعية واستمتعوا بموسم استثنائي من الثقافة والترفيه.
          </p>
        </motion.div>
      </div>
    </section>
  );
}

function VerticalNav() {
  const items = [
    { href: "#booking", label: "خيارات الحجز" },
    { href: "#parking", label: "المواقف" },
    { href: "#hours", label: "ساعات العمل" },
    { href: "#announcements", label: "إعلانات هامة" },
    { href: "#faq", label: "الأسئلة الشائعة" },
  ];
  return (
    <nav
      className="py-10 px-8 flex flex-col items-end space-y-4 font-medium text-lg border-b border-gray-100 bg-white"
      style={{ color: ORANGE }}
      data-testid="nav-vertical"
    >
      {items.map((it) => (
        <a
          key={it.href}
          href={it.href}
          className="hover:opacity-70 transition-opacity text-right"
          data-testid={`link-vnav-${it.href.slice(1)}`}
        >
          {it.label}
        </a>
      ))}
    </nav>
  );
}

function BookingSection() {
  return (
    <section id="booking" className="pt-16 pb-8" data-testid="section-booking">
      <div
        className="text-2xl font-bold mb-10 px-2 text-right"
        style={{ color: ORANGE }}
        data-testid="text-booking-heading"
      >
        خيارات الحجز
      </div>

      <BookingCard
        testId="season"
        image={seasonImage}
        title="موسم الدرعية 26"
        description={
          "بدأ موسم الدرعية بفعاليات وتجارب ثرية من #أرض_ترويك.\n\n" +
          "تقويم يتضمن الفنون والثقافة، والعروض الحية وغيرها من الفعاليات.\n\n" +
          "استكشف فعاليات وتجارب الدرعية، لحجز تذكرتك"
        }
        buttonText="احجز تذكرتك"
        href="/registration"
      />

      <BookingCard
        testId="dining"
        image={restaurantImage}
        title="جرّب مطاعم مطل البجيري"
        subTitle="سعر التذكرة: 50 ريال للشخص (يوميًا بعد الساعة 5 مساءً)"
        description={
          "احجز طاولة الآن واحصل على تذكرة دخول لمطل البجيري وحي الطريف التاريخي.\n\n" +
          "رسوم الحجز قابلة للاسترداد في جميع مطاعم ومقاهي مطل البجيري."
        }
        buttonText="احجز طاولتك"
        href="/restaurants"
      />

      <BookingCard
        testId="discovery"
        image={exploreImage}
        title="استكشف الدرعية - تذكرة دخول"
        price="سعر التذكرة: 50 ريال للشخص (يوميًا بعد الساعة 5 مساءً)"
        description={
          "لزيارة مطل البجيري وحي الطريف التاريخي، يرجى حجز تذكرة دخول.\n\n" +
          "رسوم الحجز قابلة للاسترداد في جميع مطاعم ومقاهي مطل البجيري."
        }
        buttonText="احجز تذكرة الدخول"
        href="/registration"
      />
    </section>
  );
}

function ParkingSection() {
  return (
    <section id="parking" className="mt-16 pt-8 border-t border-gray-100" data-testid="section-parking">
      <div
        className="flex items-center justify-end gap-3 text-2xl font-bold mb-8 text-right"
        style={{ color: ORANGE }}
      >
        <span>المواقف</span>
        <Car className="w-7 h-7" />
      </div>

      <div className="space-y-4">
        <div className="bg-gray-50 p-6 rounded-lg text-right shadow-2xs" data-testid="card-parking-self">
          <h4 className="font-bold text-lg mb-2 text-gray-900">الوقوف الذاتي</h4>
          <p className="text-gray-600 text-sm">ساعات بـ 30 ريال 3</p>
          <p className="text-gray-600 text-sm">تضاف 10 ريال على كل ساعة*</p>
        </div>

        <div
          className="bg-gray-50 p-6 rounded-lg flex justify-between items-center text-right shadow-2xs"
          data-testid="card-parking-valet"
        >
          <span className="text-gray-900 font-bold text-sm">ريال 100</span>
          <h4 className="font-bold text-lg text-gray-900">خدمة صف السيارات</h4>
        </div>
      </div>
    </section>
  );
}

function HoursSection() {
  return (
    <section id="hours" className="mt-16 pt-8 border-t border-gray-100" data-testid="section-hours">
      <div
        className="flex items-center justify-end gap-3 text-2xl font-bold mb-8 text-right"
        style={{ color: ORANGE }}
      >
        <span>ساعات العمل</span>
        <Clock className="w-7 h-7" />
      </div>

      <div className="space-y-8 bg-gray-50 p-6 rounded-lg text-right">
        <div data-testid="hours-bujairi">
          <h4 className="font-bold text-xl mb-3 text-gray-900">مطل البجيري</h4>
          <p className="text-gray-800 font-medium text-sm">الأحد-الأربعاء</p>
          <p className="text-gray-600 text-sm mb-3">
            من 10 صباحًا حتى 12 صباحًا
          </p>
          <p className="text-gray-800 font-medium text-sm">الخميس-السبت</p>
          <p className="text-gray-600 text-sm">من 10 صباحًا حتى 1 صباحًا</p>
        </div>

        <div className="border-t border-gray-200 pt-6" data-testid="hours-turaif">
          <h4 className="font-bold text-xl mb-3 text-gray-900">حي الطريف</h4>
          <p className="text-gray-800 font-medium text-sm">:السبت-الخميس</p>
          <p className="text-gray-600 text-sm mb-3">
            من 10 صباحًا حتى 12 صباحًا
          </p>
          <p className="text-gray-800 font-medium text-sm">:الجمعة</p>
          <p className="text-gray-600 text-sm">من 2 ظهراً حتى 12 صباحاً</p>
        </div>
      </div>
    </section>
  );
}

function MapSection() {
  return (
    <section
      className="py-16 px-6 flex flex-col items-center mt-16"
      style={{ backgroundColor: BEIGE }}
      data-testid="section-map"
    >
      <div className="max-w-md w-full relative text-center">
        <div
          className="w-full aspect-[4/3] rounded-lg overflow-hidden bg-white/60 shadow-inner relative flex items-center justify-center border border-amber-200/50"
          style={{
            backgroundImage: `
              repeating-linear-gradient(0deg, transparent, transparent 20px, rgba(168,87,52,0.05) 20px, rgba(168,87,52,0.05) 21px),
              repeating-linear-gradient(90deg, transparent, transparent 20px, rgba(168,87,52,0.05) 20px, rgba(168,87,52,0.05) 21px)
            `,
          }}
        >
          {/* Stylized map nodes */}
          <div className="absolute top-10 right-12 bg-white/95 px-2 py-1 rounded shadow text-[10px] font-bold text-gray-800 flex items-center gap-1">
            <span>فندق باب سمحان</span>
            <MapPin className="w-3 h-3 text-[#A85734]" />
          </div>
          <div className="absolute bottom-16 left-16 bg-white/95 px-2 py-1 rounded shadow text-[10px] font-bold text-gray-800 flex items-center gap-1">
            <span>مطل البجيري</span>
            <MapPin className="w-3 h-3 text-[#A85734]" />
          </div>
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center shadow-lg animate-pulse"
            style={{ backgroundColor: ORANGE }}
          >
            <MapPin className="w-5 h-5 text-white" fill="white" />
          </div>
        </div>
        <p className="text-center mt-8 text-xs text-gray-600 font-medium">
          حقوق النسخ 2024. جميع الحقوق محفوظة.
        </p>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer
      className="py-10 flex flex-col items-center justify-center"
      style={{ backgroundColor: ORANGE_DEEP }}
      data-testid="section-footer"
    >
      <div className="flex gap-4 items-center">
        <img
          src={LOGO_URL}
          alt="الدرعية"
          className="h-10 object-contain"
        />
        <div className="border-l border-white/40 h-8" />
        <div className="flex flex-col text-white text-right">
          <span className="text-xs tracking-[0.2em] font-bold">DIRIYAH</span>
          <span className="text-[10px] opacity-80 tracking-widest">
            SEASON 23/24
          </span>
        </div>
      </div>
    </footer>
  );
}

export default function Home() {
  return (
    <>
      <Seo
        title="الدرعية ومطل البجيري | Diriyah & Bujairi View | احجز تجربتك | Book Your Experience"
        description="اكتشف تجارب الدرعية ومطل البجيري والمطاعم والمقاهي والفعاليات، ثم احجز زيارتك بسهولة عبر المنصة الرسمية. Discover Diriyah, Bujairi View, dining, cafés, events, and official booking experiences."
        path="/home"
        image={defaultSeoImage}
        structuredData={{
          "@context": "https://schema.org",
          "@type": "WebSite",
          name: siteName,
          inLanguage: "ar-SA",
          description: "منصة اكتشاف وحجز تجارب الدرعية ومطل البجيري.",
        }}
      />
      <div
      className="min-h-screen bg-white text-right font-sans"
      dir="rtl"
      data-testid="page-home"
    >
      <Hero />

      <main className="max-w-md mx-auto px-6 py-6">
        <BookingSection />
        <ParkingSection />
        <HoursSection />
      </main>

      <MapSection />
      <Footer />
      </div>
    </>
  );
}

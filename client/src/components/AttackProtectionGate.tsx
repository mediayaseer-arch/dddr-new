import React, { useCallback, useEffect, useState } from "react";
import { useLocation } from "wouter";
import { AlertTriangle, Lock, RefreshCw, ShieldCheck } from "lucide-react";
import {
  fetchSecurityChallenge,
  fetchSecurityStatus,
  verifyHumanChallengeClient,
} from "@/lib/firebase";

const TERRACOTTA = "#A85734";
const BG_CREAM = "#F7F1EC";

function isAdminRoute(path: string): boolean {
  return path.startsWith("/dashboard") || path.startsWith("/login");
}

export function AttackProtectionGate({
  children,
}: {
  children: React.ReactNode;
}) {
  const [location] = useLocation();
  const currentPath =
    typeof window !== "undefined" ? window.location.pathname : location;
  const adminBypass = isAdminRoute(currentPath) || isAdminRoute(location);

  const [checking, setChecking] = useState(!adminBypass);
  const [attackActive, setAttackActive] = useState(false);
  const [verified, setVerified] = useState(false);
  const [rateLimited, setRateLimited] = useState(false);

  const [challengeToken, setChallengeToken] = useState("");
  const [challengeSvg, setChallengeSvg] = useState("");
  const [answer, setAnswer] = useState("");
  const [honeypot, setHoneypot] = useState("");
  const [loadingChallenge, setLoadingChallenge] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const loadChallenge = useCallback(async () => {
    setLoadingChallenge(true);
    setErrorMsg("");
    try {
      const ch = await fetchSecurityChallenge();
      setChallengeToken(ch.challengeToken);
      setChallengeSvg(ch.challengeSvg);
      setAnswer("");
    } catch (e: any) {
      const msg = String(e?.message || "");
      if (msg.includes("RATE_LIMIT_EXCEEDED")) {
        setRateLimited(true);
        setErrorMsg("تم تجاوز الحد المسموح من المحاولات. يرجى الانتظار بضع دقائق.");
      } else {
        setErrorMsg("تعذر تحميل رمز التحقق. يرجى إعادة المحاولة.");
      }
    } finally {
      setLoadingChallenge(false);
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    if (isAdminRoute(window.location.pathname)) {
      setChecking(false);
      setAttackActive(false);
      return;
    }
    try {
      const status = await fetchSecurityStatus();
      setAttackActive(status.enabled);
      setVerified(status.verified);
      if (status.enabled && !status.verified && !challengeToken) {
        await loadChallenge();
      }
    } catch {
      // Do not falsely lock visitors out on transient network errors; server enforces rules independently.
    } finally {
      setChecking(false);
    }
  }, [challengeToken, loadChallenge]);

  useEffect(() => {
    if (adminBypass) {
      setChecking(false);
      return;
    }
    void refreshStatus();
  }, [adminBypass, refreshStatus]);

  useEffect(() => {
    if (adminBypass) return;
    const onProtectionEvent = (ev: Event) => {
      const detail = (ev as CustomEvent)?.detail;
      if (detail?.status === 429 || detail?.error === "RATE_LIMIT_EXCEEDED") {
        setRateLimited(true);
        setAttackActive(true);
        setVerified(false);
        setErrorMsg("تم تجاوز الحد المسموح من الطلبات. يرجى الانتظار بضع دقائق قبل المحاولة مجدداً.");
        return;
      }
      setAttackActive(true);
      setVerified(false);
      void loadChallenge();
    };
    window.addEventListener("diriyah:attack-protection", onProtectionEvent);
    return () => {
      window.removeEventListener("diriyah:attack-protection", onProtectionEvent);
    };
  }, [adminBypass, loadChallenge]);

  if (adminBypass) {
    return <>{children}</>;
  }

  if (checking) {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ backgroundColor: BG_CREAM }}
        dir="rtl"
      >
        <div className="flex flex-col items-center gap-3 text-[#6B5A52]">
          <ShieldCheck className="w-8 h-8 text-[#A85734] animate-pulse" />
          <span className="text-sm font-medium">جاري فحص الاتصال الآمن...</span>
        </div>
      </div>
    );
  }

  if (!attackActive || (verified && !rateLimited)) {
    return <>{children}</>;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || honeypot) return;
    if (!answer.trim()) {
      setErrorMsg("يرجى إدخال ناتج العملية الحسابية.");
      return;
    }
    setSubmitting(true);
    setErrorMsg("");
    try {
      const res = await verifyHumanChallengeClient({
        challengeToken,
        answer: answer.trim(),
        honeypot,
      });
      if (res.verified) {
        setRateLimited(false);
        setVerified(true);
      }
    } catch (err: any) {
      const code = String(err?.message || "");
      if (code.includes("RATE_LIMIT_EXCEEDED")) {
        setRateLimited(true);
        setErrorMsg("تم تجاوز الحد المسموح من المحاولات. يرجى الانتظار بضع دقائق.");
      } else if (code.includes("TOO_FAST")) {
        setErrorMsg("يرجى التحقق بهدوء ثم إعادة المحاولة.");
        await loadChallenge();
      } else if (code.includes("CHALLENGE_EXPIRED")) {
        setErrorMsg("انتهت صلاحية رمز التحقق. تم إنشاء رمز جديد.");
        await loadChallenge();
      } else {
        setErrorMsg("الإجابة غير صحيحة، تم إنشاء عملية تحقق جديدة.");
        await loadChallenge();
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center p-4 font-sans"
      style={{ backgroundColor: BG_CREAM }}
      dir="rtl"
      data-testid="attack-protection-gate"
    >
      <div className="max-w-md w-full bg-white border border-[#EAD8CE] rounded-3xl shadow-[0_18px_45px_rgba(90,54,39,0.12)] overflow-hidden">
        <div
          className="px-6 py-6 text-center text-white"
          style={{ backgroundColor: TERRACOTTA }}
        >
          <div className="w-14 h-14 mx-auto rounded-2xl bg-white/15 border border-white/25 flex items-center justify-center mb-3">
            {rateLimited ? (
              <AlertTriangle className="w-7 h-7 text-white" />
            ) : (
              <ShieldCheck className="w-7 h-7 text-white" />
            )}
          </div>
          <h1 className="text-xl font-bold">
            {rateLimited ? "تم تقييد الطلبات مؤقتاً" : "فحص أمني سريع"}
          </h1>
          <p className="text-xs text-white/85 mt-1.5 leading-relaxed">
            {rateLimited
              ? "رُصد عدد كبير من الطلبات المتكررة من اتصالك. يرجى الانتظار قليلاً."
              : "نستخدم فحصاً أمنياً إضافياً لحماية نظام الحجوزات من المحاولات الآلية."}
          </p>
        </div>

        <div className="p-6">
          {rateLimited ? (
            <div className="space-y-4 text-center">
              <div className="p-3.5 rounded-2xl bg-amber-50 border border-amber-200 text-amber-900 text-xs leading-relaxed">
                {errorMsg ||
                  "لقد تجاوزت الحد المسموح به من الطلبات. يرجى الانتظار بضع دقائق ثم المحاولة مجدداً."}
              </div>
              <button
                type="button"
                onClick={() => {
                  setRateLimited(false);
                  void refreshStatus();
                  void loadChallenge();
                }}
                className="w-full h-12 rounded-2xl font-bold text-sm text-white transition hover:brightness-95 cursor-pointer"
                style={{ backgroundColor: TERRACOTTA }}
              >
                إعادة فحص الاتصال
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <input
                type="text"
                value={honeypot}
                onChange={(e) => setHoneypot(e.target.value)}
                className="absolute opacity-0 pointer-events-none h-0 w-0"
                tabIndex={-1}
                autoComplete="off"
                aria-hidden="true"
              />

              <div className="text-center space-y-2">
                <p className="text-sm font-semibold text-[#3D2318]">
                  أدخل ناتج العملية الظاهرة في الصورة للمتابعة:
                </p>
                <div className="flex items-center justify-center gap-2">
                  {challengeSvg ? (
                    <img
                      src={challengeSvg}
                      alt="سؤال التحقق الأمني"
                      className="h-[60px] w-[210px] rounded-xl border border-[#E4D2C7] bg-[#FAF5F1] select-none pointer-events-none"
                      data-testid="img-security-challenge"
                    />
                  ) : (
                    <div className="h-[60px] w-[210px] rounded-xl border border-[#E4D2C7] bg-[#FAF5F1] flex items-center justify-center text-xs text-[#8C7A70]">
                      جاري التحميل...
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => void loadChallenge()}
                    disabled={loadingChallenge}
                    title="تحديث الرمز"
                    className="h-11 w-11 rounded-xl border border-[#E4D2C7] bg-[#FCF9F7] hover:bg-[#FAF5F1] text-[#6B5A52] flex items-center justify-center transition cursor-pointer disabled:opacity-50"
                    data-testid="button-refresh-challenge"
                  >
                    <RefreshCw
                      className={`w-4 h-4 ${loadingChallenge ? "animate-spin" : ""}`}
                    />
                  </button>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-[#6B5A52] text-right">
                  الإجابة (أرقام فقط)
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  dir="ltr"
                  value={answer}
                  onChange={(e) => {
                    setAnswer(e.target.value);
                    if (errorMsg) setErrorMsg("");
                  }}
                  placeholder="مثال: 12"
                  className="w-full h-12 px-4 rounded-xl border border-[#E4D2C7] bg-[#FCF9F7] text-gray-900 text-center text-lg font-bold tracking-wider outline-none focus:border-[#A85734] focus:ring-1 focus:ring-[#A85734]"
                  data-testid="input-security-answer"
                />
              </div>

              {errorMsg && (
                <div
                  className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-xs text-center"
                  data-testid="text-security-error"
                >
                  {errorMsg}
                </div>
              )}

              <button
                type="submit"
                disabled={submitting || !challengeToken}
                className="w-full h-12 rounded-2xl font-bold text-base text-white transition hover:brightness-95 active:scale-[0.99] disabled:opacity-60 cursor-pointer flex items-center justify-center gap-2 shadow-[0_8px_20px_rgba(168,87,52,0.22)]"
                style={{ backgroundColor: TERRACOTTA }}
                data-testid="button-verify-human"
              >
                <Lock className="w-4 h-4" />
                <span>{submitting ? "جاري التحقق..." : "تحقق ومتابعة"}</span>
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

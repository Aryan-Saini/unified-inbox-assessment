"use client";

import { useRef, useState } from "react";
import { useSignIn, useSignUp } from "@clerk/nextjs";

const CODE_LENGTH = 6;

type Step =
  | "email"
  | "code"
  | "mfa"
  | "phone"
  | "phoneCode"
  | "profile"
  | "blocked";

type MfaStrategy = "totp" | "phone_code" | "email_code" | "backup_code";

/** Fields Clerk can ask for that this form knows how to collect. */
const PROFILE_FIELDS = [
  "first_name",
  "last_name",
  "username",
  "legal_accepted",
] as const;

const HEADINGS: Record<Step, string> = {
  email: "Welcome to Unified Inbox",
  code: "Check your email",
  mfa: "Two-step verification",
  phone: "Add your phone number",
  phoneCode: "Check your phone",
  profile: "Finish setting up",
  blocked: "We hit a snag",
};

/**
 * Email-code auth. Signing in and signing up are one flow: we try to sign the
 * email in, fall back to creating an account, and route on whatever Clerk says
 * it still needs (email code, MFA, phone, profile fields). No passwords.
 */
export function LoginForm() {
  const { signIn } = useSignIn();
  const { signUp } = useSignUp();

  const [step, setStep] = useState<Step>("email");
  const [mode, setMode] = useState<"signIn" | "signUp">("signIn");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [mfaStrategy, setMfaStrategy] = useState<MfaStrategy>("totp");
  const [mfaOptions, setMfaOptions] = useState<MfaStrategy[]>([]);
  const [missing, setMissing] = useState<string[]>([]);
  const [profile, setProfile] = useState({
    firstName: "",
    lastName: "",
    username: "",
    phoneNumber: "",
    legalAccepted: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function fail(message: string) {
    setError(message);
  }

  function failWith(err: { longMessage?: string; message: string }) {
    fail(err.longMessage ?? err.message);
  }

  function blocked(message: string) {
    setError(message);
    setStep("blocked");
  }

  /** Reads the sign-in resource and moves to whatever it still needs. */
  async function routeSignIn(): Promise<void> {
    setMode("signIn");

    // Clerk found no user for this identifier — hand the attempt to sign-up.
    if (signIn.isTransferable) {
      const transferred = await signUp.create({ transfer: true });
      if (transferred.error) return failWith(transferred.error);
      return routeSignUp();
    }

    if (signIn.existingSession) {
      return blocked(
        "You're already signed in with this account in this browser. Reload the page to continue.",
      );
    }

    switch (signIn.status) {
      case "complete": {
        const finalized = await signIn.finalize();
        if (finalized.error) failWith(finalized.error);
        return;
      }
      case "needs_identifier":
        setStep("email");
        return;
      case "needs_first_factor":
        setStep("code");
        return;
      case "needs_second_factor":
      case "needs_client_trust":
        return prepareMfa();
      case "needs_new_password":
        return blocked(
          "This account requires a password, but this app signs in with email codes only. Turn passwords off for this Clerk instance.",
        );
      case "needs_protect_check":
        return blocked(
          "This sign-in needs a bot-protection challenge that this form can't run. Try again, or use a different network.",
        );
      default:
        return blocked(`Sign-in stopped at "${signIn.status}".`);
    }
  }

  /** Reads the sign-up resource and moves to whatever it still needs. */
  async function routeSignUp(): Promise<void> {
    setMode("signUp");

    // An account already exists for this email — hand the attempt to sign-in.
    if (signUp.isTransferable) {
      const transferred = await signIn.create({ transfer: true });
      if (transferred.error) return failWith(transferred.error);
      return routeSignIn();
    }

    if (signUp.existingSession) {
      return blocked(
        "You're already signed in with this account in this browser. Reload the page to continue.",
      );
    }

    if (signUp.status === "complete") {
      const finalized = await signUp.finalize();
      if (finalized.error) failWith(finalized.error);
      return;
    }

    if (signUp.status === "abandoned") {
      await signUp.reset();
      return blocked("This sign-up expired. Start again with your email.");
    }

    const unverified = signUp.unverifiedFields as string[];
    const missingFields = signUp.missingFields as string[];

    if (unverified.includes("email_address")) {
      const sent = await signUp.verifications.sendEmailCode();
      if (sent.error) return failWith(sent.error);
      setStep("code");
      return;
    }

    if (missingFields.includes("phone_number")) {
      setStep("phone");
      return;
    }

    if (unverified.includes("phone_number")) {
      const sent = await signUp.verifications.sendPhoneCode();
      if (sent.error) return failWith(sent.error);
      setCode("");
      setStep("phoneCode");
      return;
    }

    if (missingFields.includes("password")) {
      return blocked(
        "Clerk requires a password for new accounts, but this app signs in with email codes only. Turn passwords off for this Clerk instance.",
      );
    }

    const collectable = missingFields.filter((field) =>
      (PROFILE_FIELDS as readonly string[]).includes(field),
    );
    if (collectable.length > 0) {
      setMissing(collectable);
      setStep("profile");
      return;
    }

    if (missingFields.includes("protect_check")) {
      return blocked(
        "This sign-up needs a bot-protection challenge that this form can't run. Try again, or use a different network.",
      );
    }

    return blocked(
      missingFields.length > 0
        ? `This account still needs ${missingFields.join(", ")}, which this form doesn't collect. Turn those off in Clerk or finish setup elsewhere.`
        : `Sign-up stopped at "${signUp.status}" with nothing left to collect.`,
    );
  }

  /** Picks a second factor, sending a code first when the strategy needs one. */
  async function prepareMfa(strategy?: MfaStrategy): Promise<void> {
    const available = signIn.supportedSecondFactors
      .map((factor) => factor.strategy)
      .filter((value): value is MfaStrategy =>
        ["totp", "phone_code", "email_code", "backup_code"].includes(value),
      );

    if (available.length === 0) {
      return blocked(
        "This account needs a second factor that this form doesn't support.",
      );
    }

    const preferred =
      strategy && available.includes(strategy)
        ? strategy
        : (["totp", "phone_code", "email_code", "backup_code"] as const).find(
            (candidate) => available.includes(candidate),
          )!;

    if (preferred === "phone_code") {
      const sent = await signIn.mfa.sendPhoneCode();
      if (sent.error) return failWith(sent.error);
    }
    if (preferred === "email_code") {
      const sent = await signIn.mfa.sendEmailCode();
      if (sent.error) return failWith(sent.error);
    }

    setMfaOptions(available);
    setMfaStrategy(preferred);
    setCode("");
    setStep("mfa");
  }

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (thrown) {
      fail(
        thrown instanceof Error
          ? thrown.message
          : "Something went wrong. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  const submitEmail = (event: React.FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const address = email.trim();
      const attempt = await signIn.emailCode.sendCode({
        emailAddress: address,
      });

      if (!attempt.error) {
        setCode("");
        return routeSignIn();
      }

      // Sign in and sign up are one flow: if signing in didn't work, try
      // creating the account instead.
      const created = await signUp.create({ emailAddress: address });
      if (created.error) {
        // The account does exist, so the sign-in error is the real problem.
        return failWith(
          created.error.code === "form_identifier_exists"
            ? attempt.error
            : created.error,
        );
      }

      setCode("");
      return routeSignUp();
    });
  };

  const submitCode = (event: React.FormEvent) => {
    event.preventDefault();
    void run(async () => {
      if (mode === "signIn") {
        const verified = await signIn.emailCode.verifyCode({ code });
        if (verified.error) return failWith(verified.error);
        return routeSignIn();
      }
      const verified = await signUp.verifications.verifyEmailCode({ code });
      if (verified.error) return failWith(verified.error);
      return routeSignUp();
    });
  };

  const submitMfa = (event: React.FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const verified =
        mfaStrategy === "totp"
          ? await signIn.mfa.verifyTOTP({ code })
          : mfaStrategy === "backup_code"
            ? await signIn.mfa.verifyBackupCode({ code })
            : mfaStrategy === "phone_code"
              ? await signIn.mfa.verifyPhoneCode({ code })
              : await signIn.mfa.verifyEmailCode({ code });
      if (verified.error) return failWith(verified.error);
      return routeSignIn();
    });
  };

  const submitPhone = (event: React.FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const updated = await signUp.update({
        phoneNumber: profile.phoneNumber.trim(),
      });
      if (updated.error) return failWith(updated.error);
      return routeSignUp();
    });
  };

  const submitPhoneCode = (event: React.FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const verified = await signUp.verifications.verifyPhoneCode({ code });
      if (verified.error) return failWith(verified.error);
      return routeSignUp();
    });
  };

  const submitProfile = (event: React.FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const shared = {
        ...(missing.includes("first_name")
          ? { firstName: profile.firstName.trim() }
          : {}),
        ...(missing.includes("last_name")
          ? { lastName: profile.lastName.trim() }
          : {}),
        ...(missing.includes("legal_accepted") ? { legalAccepted: true } : {}),
      };

      const submitted = await signUp.update({
        ...shared,
        ...(missing.includes("username")
          ? { username: profile.username.trim() }
          : {}),
      });
      if (submitted.error) return failWith(submitted.error);

      return routeSignUp();
    });
  };

  const resend = () =>
    void run(async () => {
      const result =
        step === "phoneCode"
          ? await signUp.verifications.sendPhoneCode()
          : step === "mfa"
            ? mfaStrategy === "phone_code"
              ? await signIn.mfa.sendPhoneCode()
              : await signIn.mfa.sendEmailCode()
            : mode === "signIn"
              ? await signIn.emailCode.sendCode()
              : await signUp.verifications.sendEmailCode();
      if (result.error) return failWith(result.error);
      setNotice("New code sent.");
    });

  const startOver = () =>
    void run(async () => {
      await Promise.all([signIn.reset(), signUp.reset()]);
      setStep("email");
      setMode("signIn");
      setCode("");
      setMissing([]);
      setMfaOptions([]);
      setProfile({
        firstName: "",
        lastName: "",
        username: "",
            phoneNumber: "",
        legalAccepted: false,
      });
    });

  return (
    <div className="w-full max-w-[26rem]">
      <h1 className="mb-8 text-center text-3xl font-semibold tracking-tight">
        {HEADINGS[step]}
      </h1>

      {step === "email" ? (
        <form onSubmit={submitEmail} className="flex flex-col gap-3">
          <input
            type="email"
            name="email"
            required
            autoFocus
            autoComplete="email"
            placeholder="Email Address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputClass}
          />
          <Submit
            busy={busy}
            label="Continue with Email"
            busyLabel="Sending code…"
          />
          {/* Clerk renders its bot-protection challenge here when signing up. */}
          <div id="clerk-captcha" />
        </form>
      ) : null}

      {step === "code" ? (
        <form onSubmit={submitCode} className="flex flex-col gap-3">
          <Hint>
            Enter the {CODE_LENGTH}-digit code sent to{" "}
            <span className="text-neutral-200">{email}</span>
          </Hint>
          <CodeInput value={code} onChange={setCode} />
          <Submit busy={busy} disabled={code.length !== CODE_LENGTH} />
          <Footer onResend={resend} onStartOver={startOver} />
        </form>
      ) : null}

      {step === "mfa" ? (
        <form onSubmit={submitMfa} className="flex flex-col gap-3">
          <Hint>
            {mfaStrategy === "totp"
              ? "Enter the code from your authenticator app."
              : mfaStrategy === "backup_code"
                ? "Enter one of your backup codes."
                : mfaStrategy === "phone_code"
                  ? "Enter the code we texted you."
                  : "Enter the code we emailed you."}
          </Hint>
          {mfaStrategy === "backup_code" ? (
            <input
              autoFocus
              required
              value={code}
              onChange={(e) => setCode(e.target.value.trim())}
              placeholder="Backup code"
              className={inputClass}
            />
          ) : (
            <CodeInput value={code} onChange={setCode} />
          )}
          <Submit
            busy={busy}
            disabled={
              mfaStrategy === "backup_code"
                ? code.length === 0
                : code.length !== CODE_LENGTH
            }
          />
          <div className="mt-2 flex flex-wrap justify-center gap-4 text-sm text-neutral-400">
            {(mfaStrategy === "phone_code" || mfaStrategy === "email_code") && (
              <Link onClick={resend}>Resend code</Link>
            )}
            {mfaOptions
              .filter((option) => option !== mfaStrategy)
              .map((option) => (
                <Link
                  key={option}
                  onClick={() => void run(() => prepareMfa(option))}
                >
                  {MFA_LABELS[option]}
                </Link>
              ))}
            <Link onClick={startOver}>Start over</Link>
          </div>
        </form>
      ) : null}

      {step === "phone" ? (
        <form onSubmit={submitPhone} className="flex flex-col gap-3">
          <Hint>Your account needs a phone number to finish setup.</Hint>
          <input
            type="tel"
            required
            autoFocus
            autoComplete="tel"
            placeholder="+1 555 000 0000"
            value={profile.phoneNumber}
            onChange={(e) =>
              setProfile({ ...profile, phoneNumber: e.target.value })
            }
            className={inputClass}
          />
          <Submit busy={busy} />
          <Footer onStartOver={startOver} />
        </form>
      ) : null}

      {step === "phoneCode" ? (
        <form onSubmit={submitPhoneCode} className="flex flex-col gap-3">
          <Hint>Enter the {CODE_LENGTH}-digit code we texted you.</Hint>
          <CodeInput value={code} onChange={setCode} />
          <Submit busy={busy} disabled={code.length !== CODE_LENGTH} />
          <Footer onResend={resend} onStartOver={startOver} />
        </form>
      ) : null}

      {step === "profile" ? (
        <form onSubmit={submitProfile} className="flex flex-col gap-3">
          <Hint>Just a couple more details.</Hint>
          {missing.includes("first_name") && (
            <input
              required
              autoFocus
              autoComplete="given-name"
              placeholder="First name"
              value={profile.firstName}
              onChange={(e) =>
                setProfile({ ...profile, firstName: e.target.value })
              }
              className={inputClass}
            />
          )}
          {missing.includes("last_name") && (
            <input
              required
              autoComplete="family-name"
              placeholder="Last name"
              value={profile.lastName}
              onChange={(e) =>
                setProfile({ ...profile, lastName: e.target.value })
              }
              className={inputClass}
            />
          )}
          {missing.includes("username") && (
            <input
              required
              autoComplete="username"
              placeholder="Username"
              value={profile.username}
              onChange={(e) =>
                setProfile({ ...profile, username: e.target.value })
              }
              className={inputClass}
            />
          )}
          {missing.includes("legal_accepted") && (
            <label className="flex items-start gap-2 text-sm text-neutral-400">
              <input
                type="checkbox"
                required
                checked={profile.legalAccepted}
                onChange={(e) =>
                  setProfile({ ...profile, legalAccepted: e.target.checked })
                }
                className="mt-0.5"
              />
              I agree to the Terms and Privacy Policy.
            </label>
          )}
          <Submit busy={busy} />
          <Footer onStartOver={startOver} />
        </form>
      ) : null}

      {step === "blocked" ? (
        <div className="flex flex-col gap-3">
          <Submit busy={busy} label="Start over" onClick={startOver} />
        </div>
      ) : null}

      {error ? (
        <p className="mt-4 text-center text-sm text-red-400">{error}</p>
      ) : null}
      {notice ? (
        <p className="mt-4 text-center text-sm text-neutral-400">{notice}</p>
      ) : null}
    </div>
  );
}

const MFA_LABELS: Record<MfaStrategy, string> = {
  totp: "Use authenticator app",
  phone_code: "Text me instead",
  email_code: "Email me instead",
  backup_code: "Use a backup code",
};

const inputClass =
  "h-12 w-full rounded-md border border-neutral-800 bg-neutral-950 px-4 text-[15px] text-white placeholder:text-neutral-500 focus:border-neutral-600 focus:outline-none";

function Submit({
  busy,
  disabled,
  label = "Continue",
  busyLabel = "Verifying…",
  onClick,
}: {
  busy: boolean;
  disabled?: boolean;
  label?: string;
  busyLabel?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type={onClick ? "button" : "submit"}
      onClick={onClick}
      disabled={busy || disabled}
      className="h-12 w-full rounded-md bg-neutral-100 text-[15px] font-medium text-black transition-colors hover:bg-white disabled:opacity-60"
    >
      {busy ? busyLabel : label}
    </button>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2 text-center text-sm text-neutral-400">{children}</p>
  );
}

function Link({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} className="hover:text-white">
      {children}
    </button>
  );
}

function Footer({
  onResend,
  onStartOver,
}: {
  onResend?: () => void;
  onStartOver: () => void;
}) {
  return (
    <div className="mt-2 flex justify-center gap-4 text-sm text-neutral-400">
      {onResend ? <Link onClick={onResend}>Resend code</Link> : null}
      <Link onClick={onStartOver}>Use a different email</Link>
    </div>
  );
}

/** Six boxes that behave like a single input, with paste and backspace. */
function CodeInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const digits = value.padEnd(CODE_LENGTH).split("");

  return (
    <div
      className="relative"
      onClick={() => inputRef.current?.focus()}
      role="presentation"
    >
      <input
        ref={inputRef}
        autoFocus
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={CODE_LENGTH}
        value={value}
        onChange={(e) =>
          onChange(e.target.value.replace(/\D/g, "").slice(0, CODE_LENGTH))
        }
        className="absolute inset-0 h-full w-full cursor-default opacity-0"
        aria-label={`${CODE_LENGTH}-digit verification code`}
      />
      <div className="flex justify-between gap-2">
        {digits.map((digit, index) => (
          <span
            key={index}
            className={`flex h-14 flex-1 items-center justify-center rounded-md border text-xl tabular-nums ${
              index === value.length
                ? "border-neutral-500"
                : "border-neutral-800"
            }`}
          >
            {digit.trim()}
          </span>
        ))}
      </div>
    </div>
  );
}

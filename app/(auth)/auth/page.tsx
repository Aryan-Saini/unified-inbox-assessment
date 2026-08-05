import { GuestGate } from "../../GuestGate";
import { LoginForm } from "../../LoginForm";

/** Sign in and sign up, one email-code flow. Closed once you are signed in. */
export default function AuthPage() {
  return (
    <div className="flex flex-1 items-center justify-center px-6 pb-24">
      <GuestGate>
        <LoginForm />
      </GuestGate>
    </div>
  );
}

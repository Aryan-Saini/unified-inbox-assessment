import { GuestGate } from "../../GuestGate";
import { KeyboardSafeArea } from "../../KeyboardSafeArea";
import { LoginForm } from "../../LoginForm";

/** Sign in and sign up, one email-code flow. Closed once you are signed in. */
export default function AuthPage() {
  return (
    <KeyboardSafeArea>
      <GuestGate>
        <LoginForm />
      </GuestGate>
    </KeyboardSafeArea>
  );
}

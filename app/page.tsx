import { Show } from "@clerk/nextjs";
import { LoginForm } from "./LoginForm";

export default function Home() {
  return (
    <div className="flex flex-1 items-center justify-center px-6 pb-24">
      <Show when="signed-out">
        <LoginForm />
      </Show>
    </div>
  );
}

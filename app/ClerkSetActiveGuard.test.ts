import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installSetActiveGuard } from "./ClerkSetActiveGuard";

/**
 * The point of the guard is that `Clerk.setActive` can always finish awaiting
 * the hook, whatever Clerk's own hook does. Both failure modes seen behind a
 * Codespaces proxy are covered: the Server Action rejects, or the promise Clerk
 * built around it never settles at all.
 */

type Host = Parameters<typeof installSetActiveGuard>[0];

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("resolves when the original hook rejects", async () => {
  const host: Host = {
    __internal_onBeforeSetActive: () =>
      Promise.reject(new Error("Invalid Server Actions request")),
  };
  installSetActiveGuard(host);

  await expect(host.__internal_onBeforeSetActive!()).resolves.toBeUndefined();
});

test("resolves when the original hook throws synchronously", async () => {
  const host: Host = {
    __internal_onBeforeSetActive: () => {
      throw new Error("boom");
    },
  };
  installSetActiveGuard(host);

  await expect(host.__internal_onBeforeSetActive!()).resolves.toBeUndefined();
});

test("gives up on a hook that never settles", async () => {
  const host: Host = {
    __internal_onBeforeSetActive: () => new Promise<void>(() => {}),
  };
  installSetActiveGuard(host);

  const settled = vi.fn();
  void Promise.resolve(host.__internal_onBeforeSetActive!()).then(settled);

  await vi.advanceTimersByTimeAsync(1400);
  expect(settled).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(200);
  expect(settled).toHaveBeenCalled();
});

test("delegates to the original hook and restores it on teardown", async () => {
  const original = vi.fn(() => Promise.resolve());
  const host: Host = { __internal_onBeforeSetActive: original };

  const uninstall = installSetActiveGuard(host);
  await host.__internal_onBeforeSetActive!("sign-out");
  expect(original).toHaveBeenCalledWith("sign-out");

  uninstall();
  expect(host.__internal_onBeforeSetActive).toBe(original);
});

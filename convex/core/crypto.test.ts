import { describe, expect, test } from "vitest";
import {
  decryptToken,
  encryptToken,
  sha256Base64Url,
  sha256Hex,
  timingSafeEqual,
  type TokenAad,
} from "./crypto";

const AAD: TokenAad = {
  provider: "gmail",
  connectionId: "conn_1",
  tokenType: "access",
};

describe("token envelope", () => {
  test("round-trips a token", async () => {
    const cipher = await encryptToken("ya29.a0AfB_secret", AAD);
    expect(cipher).not.toContain("ya29");
    await expect(decryptToken(cipher, AAD)).resolves.toBe("ya29.a0AfB_secret");
  });

  test("is non-deterministic, so equal tokens are not detectable", async () => {
    const a = await encryptToken("same-token", AAD);
    const b = await encryptToken("same-token", AAD);
    expect(a).not.toBe(b);
  });

  test("refuses a ciphertext moved to another connection", async () => {
    const cipher = await encryptToken("ya29.a0AfB_secret", AAD);
    await expect(
      decryptToken(cipher, { ...AAD, connectionId: "conn_2" }),
    ).rejects.toThrow();
  });

  test("refuses a refresh token pasted into the access-token slot", async () => {
    const cipher = await encryptToken("1//refresh", { ...AAD, tokenType: "refresh" });
    await expect(decryptToken(cipher, AAD)).rejects.toThrow();
  });

  test("refuses a tampered ciphertext", async () => {
    const cipher = await encryptToken("ya29.a0AfB_secret", AAD);
    // Flip the final base64 character to something else in the alphabet.
    const last = cipher.at(-1) === "A" ? "B" : "A";
    await expect(
      decryptToken(cipher.slice(0, -1) + last, AAD),
    ).rejects.toThrow();
  });

  test("refuses an unknown envelope version", async () => {
    const cipher = await encryptToken("ya29.a0AfB_secret", AAD);
    // The version byte is the first byte, i.e. the first base64 sextet pair.
    const bumped = "C" + cipher.slice(1);
    await expect(decryptToken(bumped, AAD)).rejects.toThrow(/envelope version/);
  });
});

describe("digests", () => {
  test("sha256Hex is stable and hex", async () => {
    await expect(sha256Hex("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("sha256Base64Url produces an unpadded PKCE challenge", async () => {
    const challenge = await sha256Base64Url("verifier");
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("timingSafeEqual compares by value", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });
});

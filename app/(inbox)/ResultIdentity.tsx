"use client";

import { useState } from "react";
import { BRAND_LOGO } from "./brand-icons";
import type { Source, UiResult } from "./types";

/**
 * Where a result lives, as one line.
 *
 * With several connectors — two Gmail inboxes, two Slack workspaces — "who sent
 * it" does not tell you "who received it", and that is the one fact a merged list
 * otherwise loses. "to <inbox>" is right for mail and wrong for chat: you do not
 * post a message *to* a workspace, you post it *in* a channel, so a message names
 * the channel first and the workspace second.
 *
 * Falls back to the host, so a web hit — which has no account — still says where
 * it is from.
 *
 * A message the user *sent* inverts the preposition, and getting that wrong is how
 * a sent row came to claim the wrong recipient: it read "to <your own inbox>" for a
 * message that went to a customer. Sent mail left the account, so it says `sent as`
 * — naming the address it went out as, which for an alias is not the account label
 * and is the one identity the row would otherwise never show.
 */
export function whereLine(result: UiResult, accountLabel: string | undefined): string {
  const host = result.url.replace(/^https?:\/\//, "").split("/")[0];
  const sentAs = result.replyTo ?? accountLabel;
  const parts =
    result.source === "slack"
      ? [result.context, accountLabel]
      : result.outgoing === true
        ? [
            sentAs === undefined ? "sent by you" : `sent as ${sentAs}`,
            // The account only earns a mention when it is not already the address
            // above — an alias is worth disambiguating, a repeat is not.
            sentAs === accountLabel ? undefined : accountLabel,
            result.context,
          ]
        : [
            accountLabel === undefined ? undefined : `to ${accountLabel}`,
            result.context,
          ];

  const where = parts.filter(Boolean).join(" · ");
  return where === "" ? host : where;
}

/**
 * The size asked of the favicon service — and the thing that makes its generic
 * globe detectable.
 *
 * A domain with a real icon comes back at this size. A domain with none comes back
 * as a 16×16 globe with HTTP 200, so there is no error to catch: the dimensions are
 * the only signal that separates "here is their logo" from "here is a globe", and
 * `SourceAvatar` treats an undersized load as a miss and falls through to the
 * letter. Without that check an inbox of no-favicon senders rendered as a column
 * of identical globes.
 */
const FAVICON_PX = 64;

/** Anything at or below this is the placeholder, not an icon. */
const GENERIC_FAVICON_PX = 16;

function faviconOf(domain: string | undefined): string | undefined {
  if (domain === undefined || domain === "") return undefined;
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=${FAVICON_PX}`;
}

/**
 * Domains that belong to a mail provider rather than to the sender.
 *
 * A favicon identifies an *organisation*, which is what you want for `stripe.com`
 * and not what you want for `gmail.com` — there it would put Gmail's own mark
 * inside the circle, under a Gmail badge, for a person whose initial says more.
 */
const CONSUMER_MAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "zoho.com",
  "fastmail.com",
  "hey.com",
]);

/** The sender's organisation mark, when the address names one. */
export function faviconForEmail(email: string | undefined): string | undefined {
  const domain = email?.split("@")[1]?.trim().toLowerCase();
  if (domain === undefined || CONSUMER_MAIL_DOMAINS.has(domain)) return undefined;
  return faviconOf(domain);
}

/** The site's own mark, for a web hit — where the favicon *is* the identity. */
export function faviconForUrl(url: string): string | undefined {
  return faviconOf(hostOf(url));
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0].toLowerCase();
  }
}

/** Public suffixes with a second label, so `example.co.uk` is not read as "Co". */
const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "co.jp",
  "co.nz",
  "co.za",
  "co.in",
  "com.au",
  "com.br",
  "com.mx",
  "com.tr",
]);

/**
 * `"https://www.dictionary.com/browse/x"` -> `"Dictionary"`.
 *
 * A web row has no author to name, and "Web" as the first line says only what the
 * source chip beside it already said. The site is the thing that has a name, so
 * the registrable label becomes the title and the host stays underneath as the
 * address — which is the shape every search engine settled on.
 */
export function siteNameOf(url: string): string {
  const host = hostOf(url).replace(/^www\./, "");
  const labels = host.split(".");
  if (labels.length < 2) return host;

  const name = MULTI_LABEL_SUFFIXES.has(labels.slice(-2).join("."))
    ? labels[labels.length - 3]
    : labels[labels.length - 2];

  return name === undefined || name === ""
    ? host
    : name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * `"Ada Lovelace"` -> `"A"`.
 *
 * One letter, not two: at 32px a monogram is read as a shape rather than spelled
 * out, and one large glyph is a cleaner shape than two cramped ones.
 */
function initialOf(label: string): string {
  return /\p{L}|\p{N}/u.exec(label)?.[0].toUpperCase() ?? "?";
}

/** A stable hue per sender, so one person keeps one colour across searches. */
function hueOf(seed: string): number {
  let hash = 0;
  for (const character of seed) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 360;
  }
  return hash;
}

/**
 * Whose result this is, as a picture, in three tiers — all of them badged with
 * the connector in the corner, so the source is never lost to the face.
 *
 * 1. The provider's own photo. Slack returns one with every message; Gmail's
 *    search returns none, so the adapter reads it from People API.
 * 2. The favicon — the sender's domain for mail, the site itself for a web hit.
 *    It is what identifies a company or a newsletter when no photo exists.
 * 3. Failing both, the sender's initial on a colour derived from the seed. Not a
 *    grey silhouette and not a stock globe: both are the same picture on every
 *    row, which is the one thing an avatar must not be.
 *
 * Tiers 1 and 2 are network images, and a tier is abandoned on two signals: a
 * failed load, and — for a favicon — one that arrives smaller than it was asked
 * for, which is how the service delivers "no icon here" with a 200.
 */
function SourceAvatar({
  source,
  avatarUrl,
  favicon,
  label,
  seed,
}: {
  source: Source;
  avatarUrl?: string;
  favicon?: string;
  label: string;
  seed?: string;
}) {
  const Logo = BRAND_LOGO[source];
  const images = [
    { url: avatarUrl, isFavicon: false },
    { url: favicon, isFavicon: true },
  ].filter((tier): tier is { url: string; isFavicon: boolean } => {
    return tier.url !== undefined && tier.url !== "";
  });
  const [failed, setFailed] = useState(0);
  const tier = images[failed];
  const src = tier?.url;

  const hue = hueOf(seed ?? label);

  return (
    <span className="relative mt-0.5 h-8 w-8 shrink-0">
      {src === undefined ? (
        <span
          aria-hidden
          className="flex h-8 w-8 items-center justify-center rounded-full text-[14px] leading-none font-semibold"
          style={{
            backgroundColor: `hsl(${hue} 45% 28%)`,
            color: `hsl(${hue} 75% 85%)`,
          }}
        >
          {initialOf(label)}
        </span>
      ) : (
        // A provider CDN or favicon URL, not an asset this app can size or host.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          onError={() => setFailed((n) => n + 1)}
          onLoad={(event) => {
            // The placeholder tell: asked for 64px, given 16px. A real photo is
            // never second-guessed this way — only the favicon service does this.
            if (
              tier.isFavicon &&
              event.currentTarget.naturalWidth <= GENERIC_FAVICON_PX
            ) {
              setFailed((n) => n + 1);
            }
          }}
          // White, not a translucent tint: a favicon is very often a transparent
          // PNG with dark strokes, which on the dark shell rendered as an empty
          // circle. A logo is drawn to sit on white, so that is what it sits on.
          // `object-contain` for the same reason — cropping a mark to fill a
          // circle cuts the corners off it, where a photo genuinely wants to fill.
          className={`h-8 w-8 rounded-full bg-white ${
            tier.isFavicon ? "p-0.5 object-contain" : "object-cover"
          }`}
        />
      )}

      <span className="absolute -right-1 -bottom-1 flex h-4 w-4 items-center justify-center rounded-full bg-ink-850 ring-2 ring-ink-850">
        <Logo className="h-3 w-3" />
      </span>
    </span>
  );
}

/**
 * Who a result is from and where it lives: the sender's face with the connector
 * badged into the corner, their name, then the `whereLine`.
 *
 * Shared by the result row and the reply dialog's header, because a reply is
 * *about* one row — restating the row is a better header than a sentence
 * describing the dialog.
 */
export function ResultIdentity({
  source,
  label,
  name,
  where,
  avatarUrl,
  favicon,
  seed,
}: {
  source: Source;
  /** Plain text, for the initials fallback and as the default display name. */
  label: string;
  /** Overrides `label` for display, so a row can hang the address off the name. */
  name?: React.ReactNode;
  where: string;
  avatarUrl?: string;
  favicon?: string;
  /** Keeps the monogram colour stable when the display name changes — the
   *  sender's address for mail, the host for a web hit. */
  seed?: string;
}) {
  return (
    <>
      <SourceAvatar
        source={source}
        avatarUrl={avatarUrl}
        favicon={favicon}
        label={label}
        seed={seed}
      />

      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] leading-tight text-neutral-200">
          {name ?? label}
        </span>
        <span className="mt-0.5 block truncate text-[11.5px] leading-tight text-neutral-500">
          {where}
        </span>
      </span>
    </>
  );
}

/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as adapters_gmail from "../adapters/gmail.js";
import type * as adapters_slack from "../adapters/slack.js";
import type * as adapters_web from "../adapters/web.js";
import type * as api_functions from "../api/functions.js";
import type * as api_http from "../api/http.js";
import type * as api_routes from "../api/routes.js";
import type * as api_views from "../api/views.js";
import type * as apiKeys from "../apiKeys.js";
import type * as clerk from "../clerk.js";
import type * as connections from "../connections.js";
import type * as core_canonical from "../core/canonical.js";
import type * as core_crypto from "../core/crypto.js";
import type * as core_errors from "../core/errors.js";
import type * as core_faults from "../core/faults.js";
import type * as core_http from "../core/http.js";
import type * as core_rank from "../core/rank.js";
import type * as core_redact from "../core/redact.js";
import type * as core_registry from "../core/registry.js";
import type * as core_sender from "../core/sender.js";
import type * as core_types from "../core/types.js";
import type * as crons from "../crons.js";
import type * as drafts from "../drafts.js";
import type * as http from "../http.js";
import type * as limits from "../limits.js";
import type * as oauth from "../oauth.js";
import type * as oauth_google from "../oauth/google.js";
import type * as oauth_slack from "../oauth/slack.js";
import type * as orchestrator from "../orchestrator.js";
import type * as searches from "../searches.js";
import type * as seed from "../seed.js";
import type * as sends from "../sends.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "adapters/gmail": typeof adapters_gmail;
  "adapters/slack": typeof adapters_slack;
  "adapters/web": typeof adapters_web;
  "api/functions": typeof api_functions;
  "api/http": typeof api_http;
  "api/routes": typeof api_routes;
  "api/views": typeof api_views;
  apiKeys: typeof apiKeys;
  clerk: typeof clerk;
  connections: typeof connections;
  "core/canonical": typeof core_canonical;
  "core/crypto": typeof core_crypto;
  "core/errors": typeof core_errors;
  "core/faults": typeof core_faults;
  "core/http": typeof core_http;
  "core/rank": typeof core_rank;
  "core/redact": typeof core_redact;
  "core/registry": typeof core_registry;
  "core/sender": typeof core_sender;
  "core/types": typeof core_types;
  crons: typeof crons;
  drafts: typeof drafts;
  http: typeof http;
  limits: typeof limits;
  oauth: typeof oauth;
  "oauth/google": typeof oauth_google;
  "oauth/slack": typeof oauth_slack;
  orchestrator: typeof orchestrator;
  searches: typeof searches;
  seed: typeof seed;
  sends: typeof sends;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
};

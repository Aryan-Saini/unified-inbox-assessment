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
import type * as clerk from "../clerk.js";
import type * as core_crypto from "../core/crypto.js";
import type * as core_faults from "../core/faults.js";
import type * as core_http from "../core/http.js";
import type * as core_sender from "../core/sender.js";
import type * as core_types from "../core/types.js";
import type * as http from "../http.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "adapters/gmail": typeof adapters_gmail;
  clerk: typeof clerk;
  "core/crypto": typeof core_crypto;
  "core/faults": typeof core_faults;
  "core/http": typeof core_http;
  "core/sender": typeof core_sender;
  "core/types": typeof core_types;
  http: typeof http;
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

export declare const components: {};

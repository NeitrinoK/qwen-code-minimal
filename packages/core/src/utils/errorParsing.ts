/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isApiError,
  isStructuredError,
  QUOTA_EXHAUSTED_PREFIX,
} from './quotaErrorDetection.js';
import { getErrorMessage } from './errors.js';
import type { AuthType } from './auth-type.js';

const RATE_LIMIT_MESSAGE_BY_AUTH = {
  default:
    '\nPossible quota limitations in place or slow response times detected. Please wait and try again later.',
} as const;

const RATE_LIMIT_SUFFIXES = Object.values(RATE_LIMIT_MESSAGE_BY_AUTH);

function getRateLimitMessage(_authType?: AuthType): string {
  return RATE_LIMIT_MESSAGE_BY_AUTH.default;
}

/**
 * User-facing guidance shown when a request is rejected because the API key
 * is invalid or expired (HTTP 401 / "token validation" errors).
 */
export const AUTH_TOKEN_ERROR_HELP =
  '⚠ The model provider rejected your API key (invalid or expired).\n' +
  '\n' +
  'Renew it:\n' +
  '  • /auth → select your provider → paste a new key, or\n' +
  '  • update the key in ~/.qwen/.env';

const AUTH_HELP_SUFFIX = `\n\n${AUTH_TOKEN_ERROR_HELP}`;

/**
 * True when an error is an authentication/token failure (invalid or expired
 * token) rather than a transport/quota/other error. Narrow by design: only
 * HTTP 401 and token-validation messages, so the renewal help is not shown for
 * unrelated auth-adjacent failures (403/billing/quota).
 */
export function isAuthTokenError(error: {
  status?: number;
  message?: string;
}): boolean {
  if (error.status === 401) return true;
  const m = (error.message ?? '').toLowerCase();
  return (
    m.includes('token validation') ||
    m.includes('invalid token') ||
    m.includes('unauthorized') ||
    m.includes('invalid api key')
  );
}

const API_ERROR_PREFIX = '[API Error: ';

/**
 * Returns true when `value` is already in final user-facing form and must not
 * be re-wrapped by parseAndFormatApiError.
 *
 * Accepts:
 * 1) base format: "[API Error: ...]"
 * 2) 429 format: "[API Error: ...]" followed by one of the known quota
 *    guidance suffixes.
 * 3) friendly quota-exhaustion messages ("Quota exhausted: ...") built by
 *    formatQuotaExhaustedMessage — these live here rather than in the
 *    Qwen-OAuth prefix list because they also arrive via the plain-string
 *    path (a StreamContentError whose .message is the formatted text).
 *
 * Used as an idempotency guard: when an upstream caller has already passed an
 * Error through parseAndFormatApiError, stuffed the formatted string into
 * Error.message, and the message reaches us a second time, we should return it
 * unchanged rather than producing "[API Error: [API Error: ...]]".
 */
function isAlreadyFormatted(value: string): boolean {
  const trimmed = value.trimEnd();

  // Friendly quota-exhaustion messages built by formatQuotaExhaustedMessage
  // are already in final form — surface them verbatim, do not wrap.
  if (trimmed.startsWith(QUOTA_EXHAUSTED_PREFIX)) {
    return true;
  }

  if (!trimmed.startsWith(API_ERROR_PREFIX)) {
    return false;
  }

  if (trimmed.endsWith(']')) {
    return true;
  }

  // Already carries the appended token-renewal help block.
  if (trimmed.includes(AUTH_TOKEN_ERROR_HELP)) {
    return true;
  }

  return RATE_LIMIT_SUFFIXES.some((suffix) => trimmed.includes(`]${suffix}`));
}

export function parseAndFormatApiError(
  error: unknown,
  authType?: AuthType,
): string {
  if (isStructuredError(error)) {
    // Qwen OAuth quota errors have their own user-friendly message; don't wrap them
    if (
      error.message.startsWith('Qwen OAuth quota exceeded:') ||
      error.message.startsWith('Qwen OAuth free tier has been discontinued')
    ) {
      return error.message;
    }

    // If a previous pass through this function already wrapped this message
    // and stuffed it into Error.message, return it unchanged. Avoids the
    // "[API Error: [API Error: ...]]" double-wrap reported in non-interactive
    // mode when a 4xx flows through both the stream handler and handleError.
    if (isAlreadyFormatted(error.message)) {
      return error.message;
    }

    const message =
      error instanceof Error ? getErrorMessage(error) : error.message;
    let text = `[API Error: ${message}]`;
    if (error.status === 429) {
      text += getRateLimitMessage(authType);
    }
    if (isAuthTokenError({ status: error.status, message })) {
      text += AUTH_HELP_SUFFIX;
    }
    return text;
  }

  // The error message might be a string containing a JSON object.
  if (typeof error === 'string') {
    // Same idempotency guard for the plain-string path.
    if (isAlreadyFormatted(error)) {
      return error;
    }

    const rawTokenSuffix = isAuthTokenError({ message: error })
      ? AUTH_HELP_SUFFIX
      : '';

    const jsonStart = error.indexOf('{');
    if (jsonStart === -1) {
      // Not a JSON error, return as is.
      return `[API Error: ${error}]${rawTokenSuffix}`;
    }

    const jsonString = error.substring(jsonStart);

    try {
      const parsedError = JSON.parse(jsonString) as unknown;
      if (isApiError(parsedError)) {
        let finalMessage = parsedError.error.message;
        try {
          // See if the message is a stringified JSON with another error
          const nestedError = JSON.parse(finalMessage) as unknown;
          if (isApiError(nestedError)) {
            finalMessage = nestedError.error.message;
          }
        } catch (_e) {
          // It's not a nested JSON error, so we just use the message as is.
        }
        const statusText = parsedError.error.status
          ? ` (Status: ${parsedError.error.status})`
          : '';
        let text = `[API Error: ${finalMessage}${statusText}]`;
        if (parsedError.error.code === 429) {
          text += getRateLimitMessage(authType);
        }
        if (
          isAuthTokenError({
            status:
              typeof parsedError.error.code === 'number'
                ? parsedError.error.code
                : undefined,
            message: finalMessage,
          })
        ) {
          text += AUTH_HELP_SUFFIX;
        }
        return text;
      }
    } catch (_e) {
      // Not a valid JSON, fall through and return the original message.
    }
    return `[API Error: ${error}]${rawTokenSuffix}`;
  }

  return '[API Error: An unknown error occurred.]';
}

import type { Request, RequestHandler, Response } from "express";

const ALLOWED_FETCH_SITES = new Set(["same-origin", "same-site", "none"]);

function requestTargetOrigin(request: Request): string | undefined {
  const host = request.get("host");
  if (host === undefined || host.length > 512) {
    return undefined;
  }

  const forwardedProtocol = request
    .get("x-forwarded-proto")
    ?.split(",", 1)[0]
    ?.trim();
  const protocol =
    forwardedProtocol === "http" || forwardedProtocol === "https"
      ? forwardedProtocol
      : request.protocol;
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return undefined;
  }
}

function hasSameOrigin(request: Request): boolean {
  const submittedOrigin = request.get("origin");
  const targetOrigin = requestTargetOrigin(request);
  if (submittedOrigin === undefined || targetOrigin === undefined) {
    return false;
  }
  try {
    return new URL(submittedOrigin).origin === targetOrigin;
  } catch {
    return false;
  }
}

function hasAllowedFetchSite(request: Request): boolean {
  const fetchSite = request.get("sec-fetch-site");
  return fetchSite === undefined || ALLOWED_FETCH_SITES.has(fetchSite);
}

function sendForbidden(response: Response): void {
  response.set("cache-control", "no-store");
  response.status(403).json({ error: "FORBIDDEN" });
}

/** Blocks drive-by browser mutations without treating the public page as auth. */
export function requireSameOrigin(): RequestHandler {
  return (request, response, next) => {
    if (!hasSameOrigin(request) || !hasAllowedFetchSite(request)) {
      sendForbidden(response);
      return;
    }
    next();
  };
}

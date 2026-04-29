import { describe, it, expect, vi } from "vitest";
import { csrfProtection } from "../../src/middleware/csrf";
import type { Request, Response, NextFunction } from "express";

function makeRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

function makeNext(): NextFunction {
  return vi.fn() as unknown as NextFunction;
}

function makeReq({
  csrfHeader,
  csrfCookie,
  authorization,
}: {
  csrfHeader?: string;
  csrfCookie?: string;
  authorization?: string;
}): Request {
  return {
    headers: {
      ...(authorization ? { authorization } : {}),
      ...(csrfHeader ? { "x-csrf-token": csrfHeader } : {}),
    },
    cookies: {
      ...(csrfCookie ? { csrf_token: csrfCookie } : {}),
    },
  } as unknown as Request;
}

describe("csrfProtection middleware", () => {
  // ─── Bearer bypass ────────────────────────────────────────────────────

  it("bypasses CSRF check when Authorization: Bearer is present", () => {
    const req = makeReq({ authorization: "Bearer sometoken" });
    const res = makeRes();
    const next = makeNext();

    csrfProtection(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("does NOT bypass when Authorization is Basic (not Bearer)", () => {
    const req = makeReq({
      authorization: "Basic abc123",
      csrfHeader: "token",
      csrfCookie: "token",
    });
    const res = makeRes();
    const next = makeNext();

    csrfProtection(req, res, next);

    // Should pass because header matches cookie
    expect(next).toHaveBeenCalledOnce();
  });

  // ─── Missing token ────────────────────────────────────────────────────

  it("returns 403 when x-csrf-token header is missing", () => {
    const req = makeReq({ csrfCookie: "abc123" });
    const res = makeRes();
    const next = makeNext();

    csrfProtection(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 when csrf_token cookie is missing", () => {
    const req = makeReq({ csrfHeader: "abc123" });
    const res = makeRes();
    const next = makeNext();

    csrfProtection(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 when both header and cookie are missing", () => {
    const req = makeReq({});
    const res = makeRes();
    const next = makeNext();

    csrfProtection(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  // ─── Mismatched token ─────────────────────────────────────────────────

  it("returns 403 when header and cookie tokens do not match", () => {
    const req = makeReq({ csrfHeader: "token-a", csrfCookie: "token-b" });
    const res = makeRes();
    const next = makeNext();

    csrfProtection(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        message: "Invalid CSRF token",
      }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 for empty string header even if cookie is set", () => {
    const req = makeReq({ csrfHeader: "", csrfCookie: "abc123" });
    const res = makeRes();
    const next = makeNext();

    csrfProtection(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  // ─── Valid token ──────────────────────────────────────────────────────

  it("calls next() when header and cookie tokens match", () => {
    const token = "matching-csrf-token-xyz";
    const req = makeReq({ csrfHeader: token, csrfCookie: token });
    const res = makeRes();
    const next = makeNext();

    csrfProtection(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("is case-sensitive — different casing fails", () => {
    const req = makeReq({ csrfHeader: "Token-ABC", csrfCookie: "token-abc" });
    const res = makeRes();
    const next = makeNext();

    csrfProtection(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});

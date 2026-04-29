import { describe, it, expect, vi, beforeEach } from "vitest";
import jwt from "jsonwebtoken";
import { authenticate } from "../../src/middleware/authenticate";
import type { Request, Response, NextFunction } from "express";

const JWT_SECRET =
  process.env.JWT_SECRET ?? "insighta_jwt_secret_change_in_production";

function makeReq(authHeader?: string): Partial<Request> {
  return {
    headers: authHeader ? { authorization: authHeader } : {},
  } as Partial<Request>;
}

function makeRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

function makeNext(): NextFunction {
  return vi.fn() as unknown as NextFunction;
}

function signToken(payload: object, expiresIn: string | number = "15m") {
  return jwt.sign(payload, JWT_SECRET, { expiresIn } as any);
}

describe("authenticate middleware", () => {
  it("calls next() and sets req.user for a valid token", () => {
    const token = signToken({ userId: "user-123", role: "analyst" });
    const req = makeReq(`Bearer ${token}`) as Request;
    const res = makeRes();
    const next = makeNext();

    authenticate(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toEqual({ userId: "user-123", role: "analyst" });
  });

  it("returns 401 when Authorization header is missing", () => {
    const req = makeReq() as Request;
    const res = makeRes();
    const next = makeNext();

    authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when Authorization header does not start with Bearer", () => {
    const req = makeReq("Basic sometoken") as Request;
    const res = makeRes();
    const next = makeNext();

    authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 with 'Access token expired' for an expired token", () => {
    const token = signToken({ userId: "user-123", role: "analyst" }, -1); // already expired
    const req = makeReq(`Bearer ${token}`) as Request;
    const res = makeRes();
    const next = makeNext();

    authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Access token expired" }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 with 'Invalid access token' for a tampered token", () => {
    const token =
      signToken({ userId: "user-123", role: "analyst" }) + "tampered";
    const req = makeReq(`Bearer ${token}`) as Request;
    const res = makeRes();
    const next = makeNext();

    authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Invalid access token" }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 for a token signed with a different secret", () => {
    const token = jwt.sign(
      { userId: "user-123", role: "analyst" },
      "wrong-secret",
    );
    const req = makeReq(`Bearer ${token}`) as Request;
    const res = makeRes();
    const next = makeNext();

    authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("sets role correctly for admin token", () => {
    const token = signToken({ userId: "admin-456", role: "admin" });
    const req = makeReq(`Bearer ${token}`) as Request;
    const res = makeRes();
    const next = makeNext();

    authenticate(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toEqual({ userId: "admin-456", role: "admin" });
  });

  it("returns 401 for an empty Bearer token", () => {
    const req = makeReq("Bearer ") as Request;
    const res = makeRes();
    const next = makeNext();

    authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

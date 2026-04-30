import { describe, it, expect, vi } from "vitest";
import { authorize } from "../../src/middleware/authorize";
import type { Request, Response, NextFunction } from "express";

function makeReq(user?: { userId: string; role: string }): Request {
  return { user } as unknown as Request;
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

describe("authorize middleware", () => {
  // ─── analyst role ──────────────────────────────────────────────────────

  it("allows analyst to access analyst-required route", () => {
    const req = makeReq({ userId: "u1", role: "analyst" });
    const res = makeRes();
    const next = makeNext();

    authorize("analyst")(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("blocks analyst from accessing admin-required route", () => {
    const req = makeReq({ userId: "u1", role: "analyst" });
    const res = makeRes();
    const next = makeNext();

    authorize("admin")(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  // ─── admin role ────────────────────────────────────────────────────────

  it("allows admin to access admin-required route", () => {
    const req = makeReq({ userId: "u2", role: "admin" });
    const res = makeRes();
    const next = makeNext();

    authorize("admin")(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("allows admin to access analyst-required route (superset)", () => {
    const req = makeReq({ userId: "u2", role: "admin" });
    const res = makeRes();
    const next = makeNext();

    authorize("analyst")(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  // ─── missing req.user ──────────────────────────────────────────────────

  it("returns 401 when req.user is undefined", () => {
    const req = makeReq(undefined);
    const res = makeRes();
    const next = makeNext();

    authorize("analyst")(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when req.user is undefined for admin route too", () => {
    const req = makeReq(undefined);
    const res = makeRes();
    const next = makeNext();

    authorize("admin")(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  // ─── unknown role ──────────────────────────────────────────────────────

  it("blocks an unknown role from any route", () => {
    const req = makeReq({ userId: "u3", role: "superuser" });
    const res = makeRes();
    const next = makeNext();

    authorize("analyst")(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  // ─── response shape ────────────────────────────────────────────────────

  it("returns correct error shape on 403", () => {
    const req = makeReq({ userId: "u1", role: "analyst" });
    const res = makeRes();
    const next = makeNext();

    authorize("admin")(req, res, next);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error" }),
    );
  });
});

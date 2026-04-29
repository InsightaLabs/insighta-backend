import { Router } from "express";
import {
  githubRedirect,
  githubCallback,
  refresh,
  logout,
  me,
} from "../../controllers/auth.controller";
import { authenticate } from "../../middleware/authenticate";

const router = Router();

router.get("/github", githubRedirect);
router.get("/github/callback", githubCallback);
router.post("/refresh", refresh);
router.post("/logout", logout);
router.get("/me", authenticate, me);

export default router;

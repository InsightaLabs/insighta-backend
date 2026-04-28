import { Router } from "express";
import {
  toGithubRedirect,
  githubCallback,
  refresh,
  logout,
  me,
} from "../../controllers/auth.controller";
import { authenticate } from "../../middleware/authenticate";

const router = Router();

router.get("/github", toGithubRedirect);
router.get("/github/callback", githubCallback);
router.post("/refresh", refresh);
router.post("/logout", logout);
router.get("/me", authenticate, me);

export default router;

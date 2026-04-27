import { Router } from "express";
import {
  createProfile,
  deleteProfile,
  exportCSV,
  getAllProfiles,
  getProfile,
  searchForProfiles,
} from "../../controllers/profiles.controller";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";

const router = Router();

router.post("/", authenticate, authorize("admin"), createProfile);

router.get("/", authenticate, authorize("analyst"), getAllProfiles);

router.get("/search", authenticate, authorize("analyst"), searchForProfiles);

router.get("/export", authenticate, authorize("analyst"), exportCSV);

router.get("/:id", authenticate, authorize("analyst"), getProfile);

router.delete("/:id", authenticate, authorize("admin"), deleteProfile);

export default router;

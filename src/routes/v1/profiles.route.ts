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

router.post("/", authorize("admin"), createProfile);

router.get("/", authorize("analyst"), getAllProfiles);

router.get("/search", authorize("analyst"), searchForProfiles);

router.get("/export", authorize("analyst"), exportCSV);

router.get("/:id", authorize("analyst"), getProfile);

router.delete("/:id", authorize("admin"), deleteProfile);

export default router;

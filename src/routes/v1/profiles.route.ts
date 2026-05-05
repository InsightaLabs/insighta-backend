import { Router } from "express";
import {
  createProfile,
  deleteProfile,
  exportCSV,
  getAllProfiles,
  getProfile,
  searchForProfiles,
} from "../../controllers/profiles.controller";
import { authorize } from "../../middleware/authorize";
import { handleCSVUpload } from "../../controllers/upload.controller";

const router = Router();

router.post("/", authorize("admin"), createProfile);

router.get("/", authorize("analyst"), getAllProfiles);

router.post("/upload", authorize("admin"), handleCSVUpload);

router.get("/search", authorize("analyst"), searchForProfiles);

router.get("/export", authorize("analyst"), exportCSV);

router.get("/:id", authorize("analyst"), getProfile);

router.delete("/:id", authorize("admin"), deleteProfile);

export default router;

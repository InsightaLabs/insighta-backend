import { Router } from "express";
import {
  createProfile,
  deleteProfile,
  getAllProfiles,
  getProfile,
  searchForProfiles,
} from "../controllers/profiles.controller";

const router = Router();

router.post("/", createProfile);

router.get("/", getAllProfiles);

router.get("/search", searchForProfiles);

router.get("/:id", getProfile);

router.delete("/:id", deleteProfile);

export default router;

import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
// import profileRoutes from "./routes/profiles.route";
import { buildCountryMap, countryMap } from "./utils";
import v1ProfileRoutes from "./routes/v1/profiles.route";
import authRoutes from "./routes/v1/auth.route";
import { authenticate } from "./middleware/authenticate";
import { appLimiter, authLimiter } from "./middleware/rate-limiting";
import { config } from "dotenv";
import { csrfProtection } from "./middleware/csrf";
import { versionCheck } from "./middleware/version-check";
import { requestLogger } from "./middleware/logger";

config();

const app = express();

buildCountryMap(countryMap);

app.use(express.json());
app.use(cookieParser());
app.use(requestLogger);
// app.use(cors());
app.use(
  cors({
    origin: process.env.WEB_PORTAL_URL,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-CSRF-Token",
      "X-API-Version",
      "X-Client-Type",
    ],
  }),
);

// app.use("/api/profiles", profileRoutes);

app.use("/auth", authLimiter, authRoutes);

app.use(
  "/api/profiles",
  appLimiter,
  authenticate,
  csrfProtection,
  versionCheck,
  v1ProfileRoutes,
);

app.listen(3001, () => {
  console.log("server is running on port 3001");
});

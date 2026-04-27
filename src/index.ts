import express from "express";
import cors from "cors";
import profileRoutes from "./routes/profiles.route";
import { buildCountryMap, countryMap } from "./utils";
import v1ProfileRoutes from "./routes/v1/profiles.route";
import authRoutes from "./routes/v1/auth.route";

const app = express();

buildCountryMap(countryMap);

app.use(express.json());
app.use(cors());

app.use("/api/profiles", profileRoutes);

app.use("/api/v1/auth", authRoutes);

app.use("/api/v1/profiles", v1ProfileRoutes);

app.listen(3001, () => {
  console.log("server is running on port 3001");
});

import Redis from "ioredis";
import { config } from "dotenv"

config();

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
    throw new Error("REDIS_URL envrionment variable not set");
}

export const redis = new Redis(redisUrl);
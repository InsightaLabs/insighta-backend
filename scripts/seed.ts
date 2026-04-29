import { Pool } from "pg";
import { config } from "dotenv";
import * as uuid from "uuid";
import seed_profiles from "../seed_profiles.json";

config();

const profiles = seed_profiles.profiles;

async function seed() {
  console.log(process.env.CLASSIFY_DB_URL);
  const pool = new Pool({
    connectionString: process.env.CLASSIFY_DB_URL,
    ssl:
      process.env.NODE_ENV === "production"
        ? { rejectUnauthorized: false }
        : false,
  });

  console.log(`Seeding ${profiles.length} profiles...`);

  let inserted = 0;
  let skipped = 0;

  for (const profile of profiles) {
    const query = `
      INSERT INTO classifications (
        id, name, gender, gender_probability, age, age_group,
        country_id, country_name, country_probability
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (name) DO NOTHING
    `;

    const result = await pool.query(query, [
      uuid.v7(),
      profile.name,
      profile.gender,
      profile.gender_probability,
      profile.age,
      profile.age_group,
      profile.country_id,
      profile.country_name,
      profile.country_probability,
    ]);

    if (result.rowCount && result.rowCount > 0) {
      inserted++;
    } else {
      skipped++;
    }
  }

  console.log(`Done. Inserted: ${inserted}, Skipped (duplicates): ${skipped}`);
  await pool.end();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});

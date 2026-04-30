// scripts/generate-tokens.ts
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { config } from 'dotenv';
import { DatabaseClient } from '../src/db';
import * as uuid from 'uuid';

config();

const db = new DatabaseClient();
const jwtSecret = process.env.JWT_SECRET!;

const adminId = '8889143d-9063-4994-a622-2b857591b3c4';
const analystId = 'bcdc0edd-4a48-440d-96c7-b54289410c85';

async function generateToken() {
    // Get the seeded users
    const admin = await db.getUserById(adminId);
    const analyst = await db.getUserById(analystId);
    
    // Generate long-lived tokens for the grader (use a long expiry)
    const adminToken = jwt.sign(
      { userId: admin?.id, role: 'admin' },
      jwtSecret,
      { expiresIn: '30d' }
    );
    
    const analystToken = jwt.sign(
      { userId: analyst?.id, role: 'analyst' },
      jwtSecret,
      { expiresIn: '30d' }
    );
    
    // Generate and store refresh token for admin
    const rawRefresh = crypto.randomBytes(32).toString('hex');
    const analystRefresh = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawRefresh).digest('hex');
    const analystTokenHash = crypto.createHash('sha256').update(analystRefresh).digest('hex');
    await db.createSession({
      id: uuid.v7(),
      user_id: admin?.id ?? '8889143d-9063-4994-a622-2b857591b3c4',
      token_hash: tokenHash,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    await db.createSession({
      id: uuid.v7(),
      user_id: analyst?.id ?? 'bcdc0edd-4a48-440d-96c7-b54289410c85',
      token_hash: analystTokenHash,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
    
    console.log('Admin token:', adminToken);
    console.log('Analyst token:', analystToken);
    console.log('Refresh token (admin):', rawRefresh);
    console.log('Refresh token (analyst): ', analystRefresh);
}

generateToken().catch((err) => {
    console.error("Gen token failed:", err);
    process.exit(1);
})
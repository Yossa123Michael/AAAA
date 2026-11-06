import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const isCloudDatabase = Boolean(
  process.env.DATABASE_URL ||
    (process.env.DB_HOST &&
      process.env.DB_HOST !== 'localhost' &&
      process.env.DB_HOST !== '127.0.0.1')
);

export const pool = new Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
      }
    : {
        host: process.env.DB_HOST || 'localhost',
        port: Number(process.env.DB_PORT) || 5432,
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME || 'barbershop_pos',
        ssl: isCloudDatabase ? { rejectUnauthorized: false } : false,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
      }
);

pool.on('connect', () => {
  console.log('[DB] Terhubung ke database PostgreSQL');
});

pool.on('error', (err) => {
  console.error('[DB Error]', err);
});

require('dotenv').config({ quiet: true });

let prisma = null;

/**
 * Lazily creates the Prisma client (Prisma 7 uses a driver adapter for PostgreSQL).
 * Lazy so a missing DATABASE_URL produces a clear startup error instead of an import-time crash.
 */
function getPrisma() {
  if (prisma) return prisma;
  const connectionString = String(process.env.DATABASE_URL || '').trim();
  if (!connectionString) {
    throw new Error('Missing required environment variable: DATABASE_URL');
  }
  const { PrismaClient } = require('@prisma/client');
  const { PrismaPg } = require('@prisma/adapter-pg');
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  return prisma;
}

async function disconnect() {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
}

module.exports = { getPrisma, disconnect };

import { PrismaClient } from '@prisma/client';

export function createDb(url: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url } } });
}

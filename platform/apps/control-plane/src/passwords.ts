import argon2 from "argon2";

export type PasswordOptions = { memoryKiB: number; iterations: number; parallelism: number };

export function hashPassword(plain: string, options: PasswordOptions): Promise<string> {
  return argon2.hash(plain, {
    type: argon2.argon2id,
    memoryCost: options.memoryKiB,
    timeCost: options.iterations,
    parallelism: options.parallelism,
  });
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

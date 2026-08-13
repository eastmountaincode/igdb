import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SESSION_DAYS = 30;
const SESSION_SECONDS = SESSION_DAYS * 24 * 60 * 60;
const USER_PATH = join(process.cwd(), ".igdb-users.json");
const SECRET_PATH = join(process.cwd(), ".igdb-auth-secret");
const LOCK_PATH = join(process.cwd(), ".igdb-users.lock");

type StoredUser = {
  id: string;
  email: string;
  salt: string;
  passwordHash: string;
  createdAt: string;
};

type SessionPayload = {
  userId: string;
  email: string;
  expiresAt: number;
};

export type AuthUser = Pick<StoredUser, "id" | "email">;

export const SESSION_COOKIE = "igdb_session";
export const SESSION_MAX_AGE = SESSION_SECONDS;

export async function createAccount(emailInput: string, password: string): Promise<AuthUser> {
  const email = normalizeEmail(emailInput);
  validateCredentials(email, password);
  const release = await acquireLock();
  try {
    const users = await readUsers();
    if (users.some((user) => user.email === email)) throw new Error("An account with that email already exists.");
    const salt = randomBytes(16).toString("base64url");
    const passwordHash = await hashPassword(password, salt);
    const user: StoredUser = {
      id: randomBytes(16).toString("base64url"),
      email,
      salt,
      passwordHash,
      createdAt: new Date().toISOString()
    };
    users.push(user);
    await writeUsers(users);
    return publicUser(user);
  } finally {
    await release();
  }
}

export async function authenticate(emailInput: string, password: string): Promise<AuthUser | null> {
  const email = normalizeEmail(emailInput);
  if (!email || !password) return null;
  const user = (await readUsers()).find((candidate) => candidate.email === email);
  if (!user) {
    await hashPassword(password, randomBytes(16).toString("base64url"));
    return null;
  }
  const candidate = Buffer.from(await hashPassword(password, user.salt), "base64url");
  const expected = Buffer.from(user.passwordHash, "base64url");
  if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) return null;
  return publicUser(user);
}

export async function createSession(user: AuthUser) {
  const payload: SessionPayload = {
    userId: user.id,
    email: user.email,
    expiresAt: Math.floor(Date.now() / 1000) + SESSION_SECONDS
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = await sign(encoded);
  return `${encoded}.${signature}`;
}

export async function verifySession(token: string | undefined): Promise<AuthUser | null> {
  if (!token) return null;
  const separator = token.lastIndexOf(".");
  if (separator < 1) return null;
  const encoded = token.slice(0, separator);
  const provided = Buffer.from(token.slice(separator + 1), "base64url");
  const expected = Buffer.from(await sign(encoded), "base64url");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SessionPayload;
    if (!payload.userId || !payload.email || payload.expiresAt < Math.floor(Date.now() / 1000)) return null;
    const user = (await readUsers()).find((candidate) => candidate.id === payload.userId && candidate.email === payload.email);
    return user ? publicUser(user) : null;
  } catch {
    return null;
  }
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function validateCredentials(email: string, password: string) {
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid email address.");
  if (password.length < 10 || password.length > 128) throw new Error("Password must be 10–128 characters.");
}

async function hashPassword(password: string, salt: string) {
  const result = await new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key as Buffer);
    });
  });
  return result.toString("base64url");
}

async function sign(value: string) {
  return createHmac("sha256", await authSecret()).update(value).digest("base64url");
}

async function authSecret() {
  if (process.env.IGDB_AUTH_SECRET) return process.env.IGDB_AUTH_SECRET;
  try {
    return (await readFile(SECRET_PATH, "utf8")).trim();
  } catch {
    const secret = randomBytes(32).toString("base64url");
    try {
      const handle = await open(SECRET_PATH, "wx", 0o600);
      await handle.writeFile(secret);
      await handle.close();
      return secret;
    } catch {
      return (await readFile(SECRET_PATH, "utf8")).trim();
    }
  }
}

async function readUsers(): Promise<StoredUser[]> {
  try {
    const value = JSON.parse(await readFile(USER_PATH, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeUsers(users: StoredUser[]) {
  await mkdir(join(process.cwd()), { recursive: true });
  const temporary = `${USER_PATH}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, JSON.stringify(users), { mode: 0o600 });
  await rename(temporary, USER_PATH);
}

async function acquireLock() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const handle = await open(LOCK_PATH, "wx", 0o600);
      await handle.close();
      return async () => rm(LOCK_PATH, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error("Account storage is busy. Try again.");
}

function publicUser(user: StoredUser): AuthUser {
  return { id: user.id, email: user.email };
}

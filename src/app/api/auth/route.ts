import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  authenticate,
  createAccount,
  createSession,
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  verifySession
} from "@/lib/auth";

export const runtime = "nodejs";

export async function GET() {
  const cookieStore = await cookies();
  const user = await verifySession(cookieStore.get(SESSION_COOKIE)?.value);
  return NextResponse.json({ user }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { action?: string; email?: string; password?: string };
    const email = body.email ?? "";
    const password = body.password ?? "";
    const user = body.action === "register"
      ? await createAccount(email, password)
      : await authenticate(email, password);
    if (!user) return NextResponse.json({ error: "Email or password is incorrect." }, { status: 401 });
    const response = NextResponse.json({ user });
    response.cookies.set(SESSION_COOKIE, await createSession(user), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: SESSION_MAX_AGE
    });
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Authentication failed.";
    const status = message.includes("already exists") ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE() {
  const response = NextResponse.json({ user: null });
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0
  });
  return response;
}

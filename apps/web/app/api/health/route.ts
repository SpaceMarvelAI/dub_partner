import { NextResponse } from "next/server";

// GET /api/health – ALB target group health check.
// Deliberately under /api/ so it bypasses the hostname-based routing
// middleware (which requires a Host header the ALB health checker doesn't
// send) and needs no auth or DB access, so it reflects "is the process up"
// rather than "is the DB reachable".
export function GET() {
  return NextResponse.json({ ok: true });
}

// Supabase Edge Function: verify-telegram
// Deploy with: supabase functions deploy verify-telegram
// Set secret first:  supabase secrets set TELEGRAM_BOT_TOKEN=123456:ABC...
//
// Purpose: Telegram Mini Apps hand the frontend a signed `initData` string.
// The signature can only be verified with your BOT TOKEN, which must never
// reach the browser. This function verifies it server-side, then creates/
// updates the player's row in `players` and returns a Supabase session so
// the frontend can write to its OWN row under RLS.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { crypto } from "https://deno.land/std@0.224.0/crypto/mod.ts";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function hmacSha256(key: Uint8Array, data: string) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

function toHex(buf: Uint8Array) {
  return Array.from(buf).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function verifyInitData(initData: string): Promise<Record<string, string> | null> {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const pairs: string[] = [];
  for (const [k, v] of [...params.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    pairs.push(`${k}=${v}`);
  }
  const dataCheckString = pairs.join("\n");

  const secretKey = await hmacSha256(new TextEncoder().encode("WebAppData"), BOT_TOKEN);
  const computedHash = toHex(await hmacSha256(secretKey, dataCheckString));

  if (computedHash !== hash) return null;

  // Optional: reject stale initData (older than 24h)
  const authDate = Number(params.get("auth_date") || 0);
  if (Date.now() / 1000 - authDate > 60 * 60 * 24) return null;

  const out: Record<string, string> = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const { initData } = await req.json();
    if (!initData) return new Response(JSON.stringify({ error: "missing initData" }), { status: 400, headers: cors });

    const verified = await verifyInitData(initData);
    if (!verified) return new Response(JSON.stringify({ error: "invalid signature" }), { status: 401, headers: cors });

    const user = JSON.parse(verified.user || "{}");
    const playerId = String(user.id);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Issue a Supabase-compatible session for this player id so the
    // frontend can then write to players/score_events under RLS as
    // `auth.uid() = id`. We do this by creating (or fetching) a Supabase
    // Auth user whose UUID we map 1:1 to the Telegram id via a
    // deterministic UUID, then generating a magic-link/OTP session.
    const fakeEmail = `${playerId}@telegram.local`;

    let { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: fakeEmail,
    });

    if (linkErr) {
      // First time seeing this player as an auth user — create it, then retry.
      await admin.auth.admin.createUser({
        email: fakeEmail,
        email_confirm: true,
        user_metadata: { telegram_id: playerId },
      });
      ({ data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
        type: "magiclink",
        email: fakeEmail,
      }));
      if (linkErr) throw linkErr;
    }

    // Make sure the players.id (text, = telegram id) matches this auth
    // user's UUID mapping so RLS `auth.uid()::text = id` checks work —
    // we store the auth UUID as the players primary key instead of the
    // raw telegram id, and keep telegram_id as a separate lookup column.
    const authUserId = linkData.user.id;
    await admin.from("players").upsert({
      id: authUserId,
      telegram_id: user.id,
      telegram_username: user.username || null,
      display_name: [user.first_name, user.last_name].filter(Boolean).join(" ") || "Player",
      updated_at: new Date().toISOString(),
    }, { onConflict: "id" });

    return new Response(JSON.stringify({
      player: { id: authUserId, telegram_id: playerId, name: user.first_name, username: user.username },
      // Frontend exchanges this for a real session via supabase.auth.verifyOtp
      token_hash: linkData.properties.hashed_token,
    }), { headers: { ...cors, "Content-Type": "application/json" } });

  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: cors });
  }
});

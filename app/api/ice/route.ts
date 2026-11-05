import { connection } from 'next/server';

// Servers that help a phone and the game screen find each other across networks.
// STUN covers most home Wi-Fi and mobile data. Strict carrier networks need a TURN relay:
// set TURN_URLS (comma separated), TURN_USERNAME and TURN_CREDENTIAL in Vercel to enable one.
export async function GET() {
  await connection();
  const servers: RTCIceServer[] = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
  if (process.env.TURN_URLS)
    servers.push({ urls: process.env.TURN_URLS.split(','), username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
  return Response.json(servers);
}

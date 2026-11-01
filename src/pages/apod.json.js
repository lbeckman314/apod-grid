// Serves apod.json (kept at the repository root, where fetch-apod.mjs and the daily
// workflow update it) at /apod.json, for the grid to load.
import { readFile } from 'node:fs/promises';

export async function GET() {
  return new Response(await readFile('apod.json'), { headers: { 'Content-Type': 'application/json' } });
}

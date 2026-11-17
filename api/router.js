// Single Vercel Function for every /api/* route (see the rewrite in vercel.json).
import { handle } from '../lib/app.js';

const run = (request) => handle(request);
export const GET = run;
export const HEAD = run;
export const POST = run;
export const PUT = run;
export const PATCH = run;
export const DELETE = run;

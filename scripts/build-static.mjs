// Vercel build step: copy only the static front-end into dist/ (so lib/, scripts/,
// package.json and the GitHub Pages mock are never served as static files).
import { cpSync, rmSync, mkdirSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/src', { recursive: true });
for (const f of ['index.html', 'login.html']) cpSync(f, `dist/${f}`);
cpSync('src/app.js', 'dist/src/app.js');
cpSync('public', 'dist/public', { recursive: true });
cpSync('assets', 'dist/assets', { recursive: true });
console.log('static files copied to dist/');

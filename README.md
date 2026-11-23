# AI Voice Receptionist (multi-business)

Answers calls for small businesses with Bland AI, books appointments, takes callbacks, and gives each business owner a dashboard.

## Run on your computer
1. `npm install`
2. Copy `.env.example` to `.env` and fill in your keys.
3. `npm start`, then open http://127.0.0.1:3000 (or the PORT in `.env`).

Without `DATABASE_URL` it saves to local files in `data/`. With it, everything is saved in Postgres (for example Neon).

## Live on Vercel
Settings (Project -> Settings -> Environment Variables):
`DATABASE_URL` (added by the Neon integration), `BLAND_API_KEY`, `TOOL_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `GLOBAL_TEST_MODE=true` until you are ready for real texts.

Never put keys in this repository.

## Tests
`npm test` and `npm run typecheck`

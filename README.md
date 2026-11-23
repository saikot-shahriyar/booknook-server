# BookNook Server

Express API for the BookNook library application.

## Prerequisites

- Node.js 18+
- npm
- MongoDB

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Configure the environment — copy the example and fill in `MONGODB_URI` (required):

   ```bash
   cp .env.example .env
   ```

   See [`.env.example`](.env.example) for the full list of variables and their purposes.

3. Start the server:

   ```bash
   npm run dev
   ```

   The API is available at `http://localhost:5000` (see `PORT` below).

## Environment variables

| Variable | Purpose |
|---|---|
| `PORT` | Port the Express server listens on. Defaults to 5000 when unset (`process.env.PORT \|\| 5000` in `src/server.js`). |
| `CLIENT_URL` | Base URL of the BookNook client app — set as the CORS origin. |
| `MONGODB_URI` | **Required.** MongoDB connection URI. The database name is `booknook`. |
| `BETTER_AUTH_JWKS_URL` | URL of the JWKS endpoint exposing the public keys used to verify Better Auth JWT signatures. Optional — defaults to `http://localhost:3000/api/auth/jwks` when unset. |
| `BETTER_AUTH_ISSUER` | Expected value of the JWT `iss` claim when verifying tokens. Optional — defaults to `http://localhost:3000` when unset. |
| `BETTER_AUTH_AUDIENCE` | Expected value of the JWT `aud` claim when verifying tokens. Optional — defaults to `http://localhost:3000` when unset. |

The BookNook client app serves the Better Auth API (`/api/auth/...`), so point the JWT verification variables at it when it runs on a different URL.

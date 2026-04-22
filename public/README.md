# Transparent Coin Flip

A small web app for shared, observable coin flips.

## Why this helps

- Every connected browser sees the same flip at the same time.
- The server creates a hash commitment before the animation starts.
- After the reveal, each browser recomputes the hash to verify the result was locked in ahead of time.

## Run it

1. Install Node.js 18 or newer if it is not already installed.
2. In this folder, run `npm start`.
3. On the host machine, open `http://localhost:3000`.
4. On other computers, open `http://YOUR-HOST-IP:3000`.

## Deploy to Render

1. Push this folder to a GitHub repository.
2. In Render, choose `New +` and then `Blueprint`.
3. Point Render at the repository and let it read `render.yaml`.
4. After deploy finishes, open the public `onrender.com` URL and share that link.

The app is already set up for Render:

- it listens on `0.0.0.0`
- it uses Render's `PORT` environment variable
- it exposes a `GET /healthz` endpoint

Important: keep this service as a single web instance. The app stores live flip state in memory, so horizontal scaling would let different viewers hit different instances.

## How the no-cheating check works

When a flip starts, the server generates:

- a result: `heads` or `tails`
- a random secret
- a commitment hash of `flipId:result:secret`

The app shows only the hash while the coin is spinning. After the reveal, it publishes the result and the secret. Every browser recomputes the SHA-256 hash and confirms it matches the original commitment.

That means the app cannot change the outcome after the animation has already started without failing verification in front of everyone.

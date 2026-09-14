# Stratego

Classic Stratego for two players, browser to browser. A static site (TypeScript + Vite) with real peer-to-peer multiplayer over WebRTC — no account, no database, no game server. Hosted free on GitHub Pages.

**Play it:** https://krafugo.github.io/stratego/

## How to play

1. One player opens a war room and sends the 8-character room code or the invite link to a friend.
2. Both players arrange their 40 pieces in their four home rows. Tap two pieces to swap them (or drag them on a desktop), or press **Shuffle** for a fresh layout, then **Ready for battle**. You can arrange your army while you wait for your opponent.
3. Red moves first. Tap one of your pieces, then a highlighted square. Colours swap every rematch.
4. Capture the enemy flag to win. A player with no legal move also loses.

The complete rules and a card for every piece are in the game itself: **How to play** in the header, or the guide on the home page.

### The rules used in this version

- 10 × 10 board with two 2 × 2 lakes that can never be entered.
- Each army: 1 Marshal (10), 1 General (9), 2 Colonels (8), 3 Majors (7), 4 Captains (6), 4 Lieutenants (5), 4 Sergeants (4), 5 Miners (3), 8 Scouts (2), 1 Spy, 6 Bombs, 1 Flag.
- A piece moves one square orthogonally onto an empty square or an enemy. Scouts move any distance in a straight line and may attack at the end of the run; running more than one square reveals the piece as a Scout. Bombs and the Flag never move.
- Attacking reveals both pieces. Higher rank wins; equal ranks are both removed; the survivor stays revealed. The Spy wins only when it attacks the Marshal. A Miner defuses a Bomb; anything else that attacks a Bomb is lost and the Bomb stays. Attacking the Flag ends the game.
- Two-square rule: a piece may not move back and forth between the same two squares for a fourth consecutive move.
- A player whose turn it is with no legal move loses. Resigning is allowed at any time. Rematches are unlimited within a room (up to 100 rounds).

## Run it locally

Use Node 22.18 or newer (the tests rely on built-in TypeScript type stripping):

```sh
make start      # installs dependencies on first run, then serves http://127.0.0.1:5190
make check      # everything CI runs: typecheck, lint, tests, build
```

`make help` lists the rest (`test`, `lint`, `typecheck`, `build`, `serve`, `clean`). The same tasks exist as npm scripts:

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:5190. Create a room, then join it from another browser or device with the invite link. Remote play needs a publicly reachable **HTTPS** deployment on both ends; `localhost` only reaches the device it runs on.

```sh
npm test          # engine tests (node --test)
npm run lint      # ESLint (typescript-eslint)
npm run build     # type-check + production build into dist/
npm run preview   # serve dist/ on http://127.0.0.1:5191
```

To try both seats in two tabs of the same browser without WebRTC (useful on VPNs and networks where direct ICE stalls), open the dev server with `#transport=local` before creating the room; the invite link keeps the flag. This transport exists only in development builds.

## How online play works (and what "free" means)

GitHub Pages serves only the HTML, CSS and JavaScript. PeerJS's public PeerServer performs discovery and WebRTC signalling; the two browsers then exchange the game transcript over a reliable, encrypted WebRTC data channel.

The default uses Google's public STUN server and the public PeerJS signalling service. **There is no TURN relay included.** Some carrier-grade NATs, corporate networks and VPNs cannot establish a direct connection; trying another Wi-Fi or mobile network may help, and dependable operation across such networks requires a TURN relay you operate. Public signalling and STUN are shared external services with no uptime guarantee from this project.

### Optional TURN relay

Edit `public/connection-config.js` and point `turnCredentialEndpoint` at a URL you operate that returns short-lived ICE credentials:

```js
window.STRATEGO_CONNECTION = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  turnCredentialEndpoint: 'https://your-service.example/ice',
};
```

The endpoint must allow CORS from the game's origin and return `{ "iceServers": [{ "urls": [...], "username": "...", "credential": "..." }] }`. Never embed a private API key or a permanent credential in this file: all client code is public. A custom PeerServer can be configured with `peerServer: { host, port: 443, path: '/', secure: true }`.

## Fair play without a server

Neither browser is trusted with the other's army:

- At setup each player publishes only piece ids, positions and a **salted SHA-256 commitment** per piece. Ranks never cross the wire until they must be revealed.
- Attacks, defences, scout runs and the no-moves declaration carry the piece's rank and salt; the opponent checks them against the commitment before accepting the move.
- Both peers replay the same event log through the same deterministic engine. Any illegal move, impossible reveal, extra piece or rewritten history freezes the game with an explanation instead of counting.
- Each browser keeps its own seat (token, ranks and salts) in `localStorage`, so a refresh, a killed tab or a phone coming back from the background rejoins the same game: open the room link again and the board, the last move and whose turn it is sync from the peer that stayed connected. Only **Leave room** forgets it. A seat cannot move to another device, because that device would not hold the army's salts.

This is a friendly peer-to-peer game, not an anti-cheat service: it cannot stop a modified client from abandoning a lost position, and WebRTC reveals network addresses to the other peer.

## Publish on GitHub Pages

1. Push to the `main` branch of a public repository, including `package-lock.json` and `.github/workflows/pages.yml`.
2. In the repository open **Settings → Pages → Build and deployment → Source → GitHub Actions**.
3. Push a change or run the “Publish game to GitHub Pages” workflow. It runs the tests, builds the site and deploys `dist/`.
4. Relative asset URLs and hash-based invitations work at both `https://name.github.io/` and `https://name.github.io/repository/`.

## Project layout

- `src/game.ts` — the engine: rules, movement, combat, commitments, deterministic replay and transcript merging.
- `src/pieces.ts` — the piece catalogue: ranks, counts, descriptions and SVG insignia.
- `src/network.ts` — PeerJS signalling, two-seat room admission, heartbeat, reconnection and sync.
- `src/main.ts`, `src/tokens.ts`, `src/guide.ts`, `src/style.css` — lobby, board, tokens, setup flow, battle reports, tracker and the how-to-play guide.
- `src/local.ts` — development-only same-browser transport.
- `tests/game.test.ts` — engine and protocol tests.

## Branching

The repository follows git-flow: features branch from `develop`, releases merge into `main` and are tagged (`v1.0.0`). GitHub Pages deploys from `main`.

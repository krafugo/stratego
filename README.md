# Stratego

Classic Stratego for two players, browser to browser, or solo against the computer. A static site (TypeScript + Vite) with real peer-to-peer multiplayer over WebRTC — no account, no database, no game server. Hosted free on GitHub Pages.

**Play it:** https://krafugo.github.io/stratego/

## How to play

1. One player opens a war room and sends the 8-character room code or the invite link to a friend — or choose **Play the computer** for a single-player game on this device.
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
- A player whose turn it is with no legal move loses. When both flags are sealed behind bombs and neither side has a Miner left, no flag can ever be captured and the round is a draw (each side proves it by revealing its flag and the bombs around it; the claim costs no turn). Resigning is allowed at any time. Rematches are unlimited within a room (up to 100 rounds).

## The computer opponent

**Play the computer** runs a second copy of the engine in the same tab, in the guest seat. The two engines exchange transcripts exactly as two browsers would, so the computer commits its army with the same salted hashes, answers attacks the same way, and sees only what a remote opponent would see: its own ranks, the enemy ranks revealed in combat, which pieces have moved, and the move history. It cannot peek. Refreshing the page resumes the game, and rematches swap colours as usual.

How it plays (`src/bot.ts`):

- **Setup** — a fresh layout every game, built on the usual principles: flag on the back row walled in by bombs, decoy bombs elsewhere, Spy beside the General, Scouts and senior officers up front, Miners kept back.
- **Beliefs** — every unknown enemy piece gets a probability for each rank, fitted to the piece counts still unaccounted for. Pieces that moved cannot be bombs or the flag, back-row pieces that never move are probably bombs or the flag, and a piece that walks up to a revealed officer is probably stronger than it (and one that runs away, weaker).
- **Search** — it samples complete enemy armies from those beliefs, searches each with alpha-beta a few plies deep in a worker, and picks the move that does best on average; attacks on unknown pieces are averaged exactly over every rank they could be. The evaluation values ranks by what is left on the board (a Spy is worth much more while the enemy Marshal lives, Miners more as they run out), chases pieces it can beat, keeps away from pieces that beat it, and closes in on the flag. The Marshal and General never gamble on suspected bombs while a cheaper piece could probe.

`npm run arena [games] [red] [blue]` plays headless games between `bot`, `weak` and `random` players (or custom settings via `RED_OPTS` / `BLUE_OPTS` JSON) for tuning; `BOT_DEBUG=1` prints search depth and risky strikes.

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

GitHub Pages serves only the HTML, CSS and JavaScript; there is no game server. Rooms come from **[peer-room](https://github.com/krafugo/peer-room)**, a small library extracted from this project: a room runs two transports at once and the game does not care which one delivers a move.

- **Direct (WebRTC)** — PeerJS's public PeerServer performs discovery and signalling; the two browsers then exchange the transcript over a reliable, end-to-end encrypted data channel. A pool of free public STUN servers is always offered; TURN relays configured in `public/connection-config.js` are probed when a room opens and only the ones that answer are used.
- **Relay (MQTT)** — when a direct path cannot form (symmetric NATs, VPNs, mobile carriers, offices) the transcript rides on public MQTT brokers over WebSocket instead. Each seat's latest transcript is retained on the brokers, so a move made while the opponent is offline is delivered the moment they return, even hours later. Everything is sealed with AES-GCM under a key derived from the room code; the brokers see only ciphertext.

The banner shows which path is in use (**P2P** or **Relay**) and says when the opponent is away and moves are being stored. The public PeerServer, STUN servers and brokers are shared services with no uptime guarantee from this project; `public/connection-config.js` documents how to point at your own TURN relay, credential endpoint, brokers or PeerServer, and the peer-room README explains every option.

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
- `src/bot.ts`, `src/bot.worker.ts` — the computer opponent: setup, beliefs about hidden pieces, and the search, run off the main thread.
- `src/pieces.ts` — the piece catalogue: ranks, counts, descriptions and SVG insignia.
- Rooms, transports, seats and storage come from the `peer-room` dependency; `src/main.ts` wires them to the game.
- `src/main.ts`, `src/tokens.ts`, `src/guide.ts`, `src/style.css` — lobby, board, tokens, setup flow, battle reports, tracker and the how-to-play guide.
- `tests/game.test.ts` — engine and protocol tests (the transport has its own suite in peer-room); `tests/bot.test.ts` — the computer opponent; `scripts/arena.ts` — headless self-play.

## Branching

The repository follows git-flow: features branch from `develop`, releases merge into `main` and are tagged (`v1.0.0`). GitHub Pages deploys from `main`.

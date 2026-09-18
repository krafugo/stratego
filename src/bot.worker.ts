// Runs the computer opponent's search off the main thread so the board stays responsive while it thinks.
import { chooseMove, type BotInput, type Move } from './bot.ts';

self.onmessage = (event: MessageEvent<BotInput>) => {
  const move: Move | null = chooseMove(event.data);
  self.postMessage(move);
};

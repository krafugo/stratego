// The field manual: rules of play plus every piece explained. Rendered on
// the home page and inside the in-game dialog.
import { PIECES } from './pieces.ts';
import { e, token } from './tokens.ts';

export function guide() {
  const cards = PIECES.map((p, i) => `<article class="piece-card"><div class="card-token">${token(p.rank, i % 2 ? 'blue' : 'red', { size: 'lg' })}</div><div><h3>${e(p.name)} <span class="rank-tag">${p.movable ? `rank ${e(p.rank)}` : 'immobile'}</span></h3><p class="count">× ${p.count} per army</p><p>${e(p.detail)}</p></div></article>`).join('');
  return `<div class="guide">
    <div class="guide-grid">
      <section><span class="eyebrow">01 · THE GOAL</span><h3>Capture the enemy flag.</h3><p>Each player commands 40 pieces. The ranks are hidden from the opponent. Move your army across the field, attack the pieces you suspect are weak, and find the flag before yours is found.</p></section>
      <section><span class="eyebrow">02 · SETUP</span><h3>Arrange your four rows.</h3><p>Place all 40 pieces in your four home rows however you like. Tap two pieces to swap them, or press <strong>Shuffle</strong> for a fresh layout. The two lakes in the middle can never be entered. Red moves first; colours swap every rematch.</p></section>
      <section><span class="eyebrow">03 · MOVING</span><h3>One piece, one square.</h3><p>On your turn move a single piece forward, back, left or right — never diagonally, never into a lake or onto your own piece. The <strong>Scout</strong> may run any number of empty squares in a straight line, like a rook, and strike at the end of the run — but it can never pass over a piece or a lake. <strong>Bombs</strong> and the <strong>Flag</strong> never move. You may not shuttle a piece between the same two squares more than three times in a row.</p></section>
      <section><span class="eyebrow">04 · ATTACKING</span><h3>Move onto an enemy.</h3><p>Both pieces are revealed. The higher rank wins and the loser leaves the board; equal ranks destroy each other. The survivor stays revealed so your opponent remembers it. A piece that has moved shows a small mark — it cannot be a bomb or the flag.</p></section>
    </div>
    <section class="combat-rules"><span class="eyebrow">WHO WINS A FIGHT?</span><ul>
      <li><strong>Higher rank wins.</strong> Marshal 10 beats General 9, and so on down to the Spy.</li>
      <li><strong>Equal ranks:</strong> both pieces are removed.</li>
      <li><strong>Spy attacks Marshal:</strong> the Spy wins — only when the Spy strikes first.</li>
      <li><strong>Miner attacks Bomb:</strong> the bomb is defused and removed.</li>
      <li><strong>Anything else attacks a Bomb:</strong> the attacker is destroyed; the bomb stays.</li>
      <li><strong>Anything attacks the Flag:</strong> the game is over.</li>
      <li><strong>No legal move</strong> on your turn also loses the game, so keep some movers alive.</li>
    </ul></section>
    <section class="piece-guide"><span class="eyebrow">THE ARMY · 12 KINDS OF PIECE</span><div class="piece-cards">${cards}</div></section>
  </div>`;
}


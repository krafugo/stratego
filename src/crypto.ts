// Commitments let each player prove a piece's identity when it is revealed
// in combat, without exposing the rest of the army. The opponent stores
// sha256(id:rank:salt) for all 40 pieces at setup and checks every reveal.
const encoder = new TextEncoder();

export const randomHex = (bytes = 16) => [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, '0')).join('');

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export const commitment = (id: string, rank: string, salt: string) => sha256(`stratego:${id}:${rank}:${salt}`);

export const isHex = (value: unknown, length: number) => typeof value === 'string' && value.length === length && /^[a-f0-9]+$/.test(value);

/** Unbiased Fisher–Yates shuffle using the platform CSPRNG. */
export function shuffle<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0]! % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

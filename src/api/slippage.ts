import { STABLECOIN_ASSETS } from './stablecoins.js';

/** The price buffer for most swaps: 1%. */
export const DEFAULT_SLIPPAGE_BPS = 100;

/**
 * The price buffer when both sides are dollar stablecoins: 0.3%.
 *
 * On a fixed-amount payment the payer sends this much extra, so a smaller
 * buffer is less for them to over-send. Measured on 17 Nov 2026 over a minute
 * of quotes: USDC to USDC moved by almost nothing, USDT to USDC by about 0.06%.
 * 0.3% is about five times that.
 */
export const STABLECOIN_SLIPPAGE_BPS = 30;

export function isStablecoinPair(originAsset: string, destinationAsset: string): boolean {
    return STABLECOIN_ASSETS.has(originAsset) && STABLECOIN_ASSETS.has(destinationAsset);
}

/**
 * The slippage tolerance to ask 1Click for. A caller may ask for less than
 * the buffer for the pair, never more than it for a stablecoin pair.
 */
export function slippageFor(
    originAsset: string,
    destinationAsset: string,
    requested: number | undefined,
): number {
    if (isStablecoinPair(originAsset, destinationAsset)) {
        return Math.min(requested ?? STABLECOIN_SLIPPAGE_BPS, STABLECOIN_SLIPPAGE_BPS);
    }
    return requested ?? DEFAULT_SLIPPAGE_BPS;
}

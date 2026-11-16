// Says whether 1Click's signature on a Polygon quote verifies. While it does
// not, Polygon is exempt from the signature check (src/api/quote-verification.ts).
// Run: NEAR_API_KEY=... npm run check:polygon
import { signatureVerifies } from '../src/api/quote-verification.js';

const key = process.env.NEAR_API_KEY;
if (!key) throw new Error('Set NEAR_API_KEY.');

const address = '0x71C95911E9a5D330f4D621842EC243EE1343292e';
const response = await fetch('https://1click.chaindefuser.com/v0/quote', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-API-Key': key },
    body: JSON.stringify({
        dry: true,
        swapType: 'EXACT_INPUT',
        slippageTolerance: 100,
        originAsset: 'nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L',
        depositType: 'ORIGIN_CHAIN',
        destinationAsset: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
        amount: '5000000',
        refundTo: address,
        refundType: 'ORIGIN_CHAIN',
        recipient: address,
        recipientType: 'DESTINATION_CHAIN',
        deadline: new Date(Date.now() + 3600_000).toISOString(),
        referral: 'uniport',
        quoteWaitingTimeMs: 3000,
    }),
});
if (!response.ok) throw new Error(`1Click answered ${response.status}`);
const verifies = await signatureVerifies(await response.json());
console.log(
    verifies
        ? 'Polygon quotes verify again: the exemption in quote-verification.ts can be removed.'
        : 'Polygon quotes still fail the signature check: keep the exemption.'
);

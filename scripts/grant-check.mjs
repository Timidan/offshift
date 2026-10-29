// Read-only: is the bot key linked to trade BTC perps for the owner?
// Creates the bot key in .env on first run and prints the exact grant to sign.
// Usage: OWNER=0x... node scripts/grant-check.mjs
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { SomniaMarkets, SOMNIA_HIDEKI_TESTNET_ADDRESSES, PLACE_ORDER_FOR_SELECTOR, CANCEL_ORDER_FOR_SELECTOR } from '@somnia-chain/markets-sdk';
import { hidekiTestnet } from '@somnia-chain/markets-sdk/chains';
import { createPublicClient, http, parseAbi, formatEther, getAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const owner = getAddress(process.env.OWNER ?? '');
const env = existsSync('.env') ? readFileSync('.env', 'utf8') : '';
let botKey = env.match(/^BOT_PRIVATE_KEY=(0x[0-9a-fA-F]{64})$/m)?.[1];
if (!botKey) {
  botKey = generatePrivateKey();
  writeFileSync('.env', env + `BOT_PRIVATE_KEY=${botKey}\n`, { mode: 0o600 });
}
const bot = privateKeyToAccount(botKey).address;

const rpc = createPublicClient({ chain: hidekiTestnet, transport: http(hidekiTestnet.rpcUrls.default.http[0]) });
const exchange = new SomniaMarkets({ chain: hidekiTestnet, indexerUrl: 'https://hideki-dev.smk.somnia.host/v1/graphql', addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES });
try {
  if ((await rpc.getChainId()) !== 50383) throw new Error('not Hideki');
  const btc = (await exchange.client.listPerpMarkets()).find((m) => m.baseSymbol === 'BTC');
  const registry = await rpc.readContract({ address: btc.poolAddress, abi: parseAbi(['function getOperatorPermissionsRegistry() view returns (address)']), functionName: 'getOperatorPermissionsRegistry' });
  const authorized = async (selector) => exchange.client.isOperatorAuthorized({ pool: btc.poolAddress, owner, operator: bot, selector });
  const margin = await exchange.client.getMarginAccount(btc.marginBank, owner);
  const report = {
    owner, bot, btcPool: btc.poolAddress, marginBank: btc.marginBank, registry,
    placeOrderFor: await authorized(PLACE_ORDER_FOR_SELECTOR),
    cancelOrderFor: await authorized(CANCEL_ORDER_FOR_SELECTOR),
    ownerMargin: margin,
    botGasSTT: formatEther(await rpc.getBalance({ address: bot })),
  };
  console.log(JSON.stringify(report, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  if (!report.placeOrderFor || !report.cancelOrderFor) {
    console.log(`\nGrant (signed by the owner):\ncast send ${registry} "setOperatorApprovalForPool(address,address,bytes4[],bool)" ${btc.poolAddress} ${bot} "[${PLACE_ORDER_FOR_SELECTOR},${CANCEL_ORDER_FOR_SELECTOR}]" true --rpc-url ${hidekiTestnet.rpcUrls.default.http[0]} --interactive`);
  }
} finally {
  await exchange.close();
}

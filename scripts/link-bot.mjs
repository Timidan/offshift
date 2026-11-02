// Link a bot for the project test owner, as a user does in dreamDEX's Link a bot page: grant it
// place+cancel on BTC perps and send it 0.5 STT for gas. Signed by OWNER_PRIVATE_KEY.
// Usage: node --env-file=.env scripts/link-bot.mjs <bot address>
import assert from 'node:assert/strict';
import { PLACE_ORDER_FOR_SELECTOR, CANCEL_ORDER_FOR_SELECTOR } from '@somnia-chain/markets-sdk';
import { hidekiTestnet } from '@somnia-chain/markets-sdk/chains';
import { createPublicClient, createWalletClient, http, parseAbi, parseEther, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const bot = getAddress(process.argv[2]);
const REGISTRY = '0x6B2FbfeD328FF5F20C0BE7D3C3437613aFFE8D3a';
const BTC_POOL = '0x4181dd08e73bbcdd1ba3e615a18f6abd941b94c0';

const transport = http(hidekiTestnet.rpcUrls.default.http[0], { timeout: 30_000 });
const rpc = createPublicClient({ chain: hidekiTestnet, transport });
const wallet = createWalletClient({ chain: hidekiTestnet, transport, account: privateKeyToAccount(process.env.OWNER_PRIVATE_KEY) });
assert.equal(await rpc.getChainId(), 50383, 'Tokyo testnet only');

const grant = await wallet.writeContract({
  address: REGISTRY, abi: parseAbi(['function setOperatorApprovalForPool(address pool, address operator, bytes4[] selectors, bool approved)']),
  functionName: 'setOperatorApprovalForPool', args: [BTC_POOL, bot, [PLACE_ORDER_FOR_SELECTOR, CANCEL_ORDER_FOR_SELECTOR], true], gas: 3_000_000n,
});
assert.equal((await rpc.waitForTransactionReceipt({ hash: grant })).status, 'success', `grant reverted: ${grant}`);
console.log(`grant ${bot} place+cancel on BTC perps: ${grant}`);
const gas = await wallet.sendTransaction({ to: bot, value: parseEther('0.5') });
assert.equal((await rpc.waitForTransactionReceipt({ hash: gas })).status, 'success');
console.log(`send the bot 0.5 STT for gas: ${gas}`);

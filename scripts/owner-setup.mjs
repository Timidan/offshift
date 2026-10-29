// One-time owner setup on Tokyo testnet, signed by OWNER_PRIVATE_KEY from .env:
// grant the bot place/cancel on BTC perps, deposit 10 USDso margin, send the bot 1 STT for gas.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PLACE_ORDER_FOR_SELECTOR, CANCEL_ORDER_FOR_SELECTOR } from '@somnia-chain/markets-sdk';
import { hidekiTestnet } from '@somnia-chain/markets-sdk/chains';
import { createPublicClient, createWalletClient, http, parseAbi, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const env = readFileSync('.env', 'utf8');
const key = (name) => env.match(new RegExp(`^${name}=(0x[0-9a-fA-F]{64})$`, 'm'))[1];
const owner = privateKeyToAccount(key('OWNER_PRIVATE_KEY'));
const bot = privateKeyToAccount(key('BOT_PRIVATE_KEY')).address;

const REGISTRY = '0x6B2FbfeD328FF5F20C0BE7D3C3437613aFFE8D3a';
const BTC_POOL = '0x4181dd08e73bbcdd1ba3e615a18f6abd941b94c0';
const MARGIN_BANK = '0x478769e1177c0773c43a593dccc4ad15f15f1394';
const USDSO = '0xed7993A74dAe1e6656B704A424DcD8711aAf4F72';
const TEN = parseEther('10');

const transport = http(hidekiTestnet.rpcUrls.default.http[0]);
const rpc = createPublicClient({ chain: hidekiTestnet, transport });
const wallet = createWalletClient({ chain: hidekiTestnet, transport, account: owner });
assert.equal(await rpc.getChainId(), 50383, 'Tokyo testnet only');

const steps = [
  ['grant bot place+cancel on BTC perps', { address: REGISTRY, abi: parseAbi(['function setOperatorApprovalForPool(address pool, address operator, bytes4[] selectors, bool approved)']), functionName: 'setOperatorApprovalForPool', args: [BTC_POOL, bot, [PLACE_ORDER_FOR_SELECTOR, CANCEL_ORDER_FOR_SELECTOR], true] }],
  ['approve 10 USDso to the margin bank', { address: USDSO, abi: parseAbi(['function approve(address spender, uint256 amount) returns (bool)']), functionName: 'approve', args: [MARGIN_BANK, TEN] }],
  ['deposit 10 USDso as perps margin', { address: MARGIN_BANK, abi: parseAbi(['function deposit(uint256 amount)']), functionName: 'deposit', args: [TEN] }],
];
for (const [label, call] of steps) {
  const hash = await wallet.writeContract({ ...call, gas: 3_000_000n });
  const { status } = await rpc.waitForTransactionReceipt({ hash });
  assert.equal(status, 'success', `${label} reverted: ${hash}`);
  console.log(`${label}: ${hash}`);
}
const gasHash = await wallet.sendTransaction({ to: bot, value: parseEther('1') });
assert.equal((await rpc.waitForTransactionReceipt({ hash: gasHash })).status, 'success');
console.log(`send the bot 1 STT for gas: ${gasHash}`);

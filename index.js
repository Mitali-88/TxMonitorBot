import dotenv from "dotenv";
dotenv.config();

import Web3 from "web3";
import TelegramBot from "node-telegram-bot-api";

const botToken = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const rpcUrl = process.env.RPC_URL;
const blockExplorerUrl =
  process.env.BLOCK_EXPLORER_URL || "https://xdcscan.com";
const spamThreshold = parseInt(process.env.SPAM_THRESHOLD) || 50;
const checkHistoryBlocks = parseInt(process.env.CHECK_HISTORY_BLOCKS) || 200;

if (!botToken || !chatId || !rpcUrl) {
  console.error(
    "❌ Missing TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, or RPC_URL in .env"
  );
  process.exit(1);
}

const bot = new TelegramBot(botToken, { polling: true });
const web3 = new Web3(
  new Web3.providers.HttpProvider(rpcUrl, { timeout: 60000 })
);

let lastBlockNumber = 0;
let initialized = false;

function analyzeSpamPatterns(transactions) {
  const addressTxCount = new Map();
  const addressToRecipients = new Map();
  const recipientCount = new Map();
  const lowValueTxCount = new Map();

  transactions.forEach((tx) => {
    const from = tx.from?.toLowerCase() || "unknown";
    const to = tx.to?.toLowerCase() || "unknown";
    const value = BigInt(tx.value || "0");
    const valueInEth = Number(web3.utils.fromWei(value.toString(), "ether"));

    addressTxCount.set(from, (addressTxCount.get(from) || 0) + 1);

    if (!addressToRecipients.has(from)) {
      addressToRecipients.set(from, new Set());
    }
    addressToRecipients.get(from).add(to);

    recipientCount.set(to, (recipientCount.get(to) || 0) + 1);

    if (valueInEth < 0.001) {
      lowValueTxCount.set(from, (lowValueTxCount.get(from) || 0) + 1);
    }
  });

  return {
    addressTxCount,
    addressToRecipients,
    recipientCount,
    lowValueTxCount,
  };
}

async function safeSendMessage(msg) {
  try {
    await bot.sendMessage(chatId, msg);
  } catch (err) {
    console.error("⚠️ Telegram sendMessage failed:", err.message);
  }
}

async function fetchBlock(blockNumber) {
  try {
    return await web3.eth.getBlock(blockNumber, true);
  } catch (err) {
    console.error(`⚠️ Failed to fetch block ${blockNumber}:`, err.message);
    return null;
  }
}

async function checkBlock() {
  try {
    const latestBlockNumber = await web3.eth.getBlockNumber();
    const latestBlockNum = Number(latestBlockNumber);

    if (!initialized) {
      lastBlockNumber = latestBlockNum;
      initialized = true;
      console.log(`Bot initialized. Starting from block ${lastBlockNumber}`);

      if (checkHistoryBlocks > 0) {
        const startBlock = Math.max(1, latestBlockNum - checkHistoryBlocks);
        console.log(
          `🔍 Checking last ${checkHistoryBlocks} blocks for spam patterns (${startBlock} to ${latestBlockNum})...`
        );
        await checkBlockRange(startBlock, latestBlockNum);
      }
      return;
    }

    console.log("Latest Block:", latestBlockNum);

    if (latestBlockNum <= lastBlockNumber) {
      return;
    }

    const blocksToCheck = latestBlockNum - lastBlockNumber;
    console.log(
      `Checking ${blocksToCheck} new blocks (from ${
        lastBlockNumber + 1
      } to ${latestBlockNum})`
    );

    await checkBlockRange(lastBlockNumber + 1, latestBlockNum);
    lastBlockNumber = latestBlockNum;
  } catch (err) {
    console.error("❌ Error checking blocks:", err.message);
  }
}

async function checkBlockRange(startBlock, endBlock) {
  const highVolumeBlocks = [];
  const allAddressTxCount = new Map();
  let checkedBlocks = 0;

  for (let i = startBlock; i <= endBlock; i++) {
    const block = await fetchBlock(i);
    if (!block || !block.transactions) {
      continue;
    }

    checkedBlocks++;
    const txCount = block.transactions.length;

    if (txCount >= spamThreshold) {
      console.log(
        `🚨 High volume detected! Block ${i}: ${txCount} transactions`
      );

      const patterns = analyzeSpamPatterns(block.transactions);

      highVolumeBlocks.push({
        number: block.number,
        txCount: txCount,
        transactions: block.transactions,
        patterns: patterns,
      });

      patterns.addressTxCount.forEach((count, address) => {
        allAddressTxCount.set(
          address,
          (allAddressTxCount.get(address) || 0) + count
        );
      });
    }
  }

  console.log(
    `Checked ${checkedBlocks} blocks, found ${highVolumeBlocks.length} high-volume blocks`
  );

  if (highVolumeBlocks.length > 0) {
    await sendSpamAlert(highVolumeBlocks, allAddressTxCount);
  }
}

async function sendSpamAlert(highVolumeBlocks, allAddressTxCount) {
  const totalTransactions = highVolumeBlocks.reduce(
    (sum, block) => sum + block.txCount,
    0
  );

  let message = `${highVolumeBlocks.length}: ${totalTransactions} transactions\n`;

  highVolumeBlocks.forEach((block) => {
    message += `- Block ${block.number}: ${block.txCount} transactions\n`;
  });

  const txCountToAddresses = new Map();
  allAddressTxCount.forEach((count, address) => {
    if (!txCountToAddresses.has(count)) {
      txCountToAddresses.set(count, []);
    }
    txCountToAddresses.get(count).push(address);
  });

  let maxCount = 0;
  let topSpamAddresses = [];
  txCountToAddresses.forEach((addresses, count) => {
    if (count > maxCount) {
      maxCount = count;
      topSpamAddresses = addresses;
    }
  });

  if (topSpamAddresses.length > 0) {
    message += `\nTop Spam Sender Addresses (each with ${maxCount} transactions):\n`;
    const addressesToShow = topSpamAddresses.slice(0, 5);
    addressesToShow.forEach((address) => {
      message += `- ${address}\n`;
    });

    const remainingCount = topSpamAddresses.length - 5;
    if (remainingCount > 0) {
      message += `... and ${remainingCount} additional address${
        remainingCount > 1 ? "es" : ""
      } exhibiting the same pattern.\n`;
    }
  }

  const latestHighVolumeBlock = highVolumeBlocks[highVolumeBlocks.length - 1];
  message += `\nInvestigation Link:\nBlock Explorer: ${blockExplorerUrl}/block/${latestHighVolumeBlock.number}`;

  await safeSendMessage(message);
}

async function checkPendingTxs() {
  try {
    if (!web3.eth.txPool?.status) return;

    const poolStatus = await web3.eth.txPool.status();
    const pendingCount = poolStatus.pending || 0;

    if (pendingCount > 50) {
      let message = `⚠️ Pending TX alert!\nPending Transactions: ${pendingCount}\n`;

      if (web3.eth.txPool?.content) {
        try {
          const content = await web3.eth.txPool.content();
          for (const from in content.pending) {
            for (const nonce in content.pending[from]) {
              const tx = content.pending[from][nonce];
              message += `From: ${tx.from}\nTo: ${
                tx.to
              }\nValue: ${web3.utils.fromWei(tx.value, "ether")} ETH\nNonce: ${
                tx.nonce
              }\nTx Hash: ${tx.hash || "N/A"}\n\n`;
            }
          }
        } catch (err) {
          console.error("⚠️ Failed to fetch pending TX content:", err.message);
        }
      }

      await safeSendMessage(message);
    }
  } catch (err) {
    console.error("❌ Error checking pending transactions:", err.message);
  }
}

setInterval(() => {
  checkBlock();
  checkPendingTxs();
}, 15000);

checkBlock();

safeSendMessage(
  "✅ TxMonitorBot is now monitoring blocks and pending transactions 🚀"
).catch((err) => console.error("Failed to send online message:", err.message));

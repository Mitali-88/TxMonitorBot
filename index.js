import dotenv from 'dotenv';
dotenv.config();

import Web3 from 'web3';
import TelegramBot from 'node-telegram-bot-api';

// Load environment variables
const botToken = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const rpcUrl = process.env.RPC_URL;

if (!botToken || !chatId || !rpcUrl) {
    console.error('❌ Missing TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, or RPC_URL in .env');
    process.exit(1);
}

// Telegram bot setup
const bot = new TelegramBot(botToken, { polling: true });

// Web3 setup with 60s timeout
const web3 = new Web3(new Web3.providers.HttpProvider(rpcUrl, { timeout: 60000 }));

let lastBlockNumber = 0;

// Safe Telegram message sender
async function safeSendMessage(msg) {
    try {
        await bot.sendMessage(chatId, msg);
    } catch (err) {
        console.error('⚠️ Telegram sendMessage failed:', err.message);
    }
}

// Fetch block with error handling
async function fetchBlock(blockNumber) {
    try {
        return await web3.eth.getBlock(blockNumber, true); // include txs
    } catch (err) {
        console.error(`⚠️ Failed to fetch block ${blockNumber}:`, err.message);
        return null;
    }
}

// Check blocks for spam/high TX volume
async function checkBlock() {
    try {
        const latestBlockNumber = await web3.eth.getBlockNumber();
        console.log('Latest Block:', latestBlockNumber);

        if (latestBlockNumber <= lastBlockNumber) return;

        for (let i = lastBlockNumber + 1; i <= latestBlockNumber; i++) {
            const block = await fetchBlock(i);
            if (!block || !block.transactions) continue;

            const txCount = block.transactions.length;

            if (txCount > 100) { // spam threshold
                let message = `🚨 High TX volume detected!\nBlock: ${block.number}\nTX Count: ${txCount}\nTransactions:\n`;

                block.transactions.forEach(tx => {
                    message += `From: ${tx.from}\nTo: ${tx.to}\nValue: ${web3.utils.fromWei(tx.value, 'ether')} ETH\nStatus: ${
                        tx.blockNumber ? 'Confirmed' : 'Pending'
                    }\nTx Hash: ${tx.hash}\n\n`;
                });

                await safeSendMessage(message);
            }
        }

        lastBlockNumber = latestBlockNumber;

    } catch (err) {
        console.error('❌ Error checking blocks:', err.message);
    }
}

// Check pending transactions safely
async function checkPendingTxs() {
    try {
        if (!web3.eth.txPool?.status) return;

        const poolStatus = await web3.eth.txPool.status();
        const pendingCount = poolStatus.pending || 0;

        if (pendingCount > 50) { // pending TX threshold
            let message = `⚠️ Pending TX alert!\nPending Transactions: ${pendingCount}\n`;

            if (web3.eth.txPool?.content) {
                try {
                    const content = await web3.eth.txPool.content();
                    for (const from in content.pending) {
                        for (const nonce in content.pending[from]) {
                            const tx = content.pending[from][nonce];
                            message += `From: ${tx.from}\nTo: ${tx.to}\nValue: ${web3.utils.fromWei(tx.value, 'ether')} ETH\nNonce: ${tx.nonce}\nTx Hash: ${tx.hash || 'N/A'}\n\n`;
                        }
                    }
                } catch (err) {
                    console.error('⚠️ Failed to fetch pending TX content:', err.message);
                }
            }

            await safeSendMessage(message);
        }

    } catch (err) {
        console.error('❌ Error checking pending transactions:', err.message);
    }
}

// Main loop: poll every 15 seconds
setInterval(() => {
    checkBlock();
    checkPendingTxs();
}, 15000);

// Notify bot is online
safeSendMessage('✅ TxMonitorBot is now monitoring blocks and pending transactions 🚀')
    .catch(err => console.error('Failed to send online message:', err.message));

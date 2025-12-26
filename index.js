import Web3 from 'web3';
// const Web3 = require('web3');
import dotenv from 'dotenv';
dotenv.config(); // must come first

import TelegramBot from 'node-telegram-bot-api';

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const chatId = process.env.TELEGRAM_CHAT_ID;

// Connect to mainnet RPC
const web3 = new Web3(process.env.RPC_URL);

// Track the last processed block
let lastBlockNumber = 0;

// Function to check for spam/pending transactions
async function checkBlock() {
    try {
        const latestBlockNumber = await web3.eth.getBlockNumber();

        if (latestBlockNumber <= lastBlockNumber) return; // no new block

        for (let i = lastBlockNumber + 1; i <= latestBlockNumber; i++) {
            const block = await web3.eth.getBlock(i, true); // true = include txs

            if (!block || !block.transactions) continue;

            // Detect spam: high number of transactions
            const txCount = block.transactions.length;
            if (txCount > 100) { // threshold, adjust as needed
                let message = `🚨 High TX volume detected!\nBlock: ${block.number}\nTX Count: ${txCount}\nTransactions:\n`;

                block.transactions.forEach(tx => {
                    message += `From: ${tx.from}\nTo: ${tx.to}\nValue: ${web3.utils.fromWei(tx.value, 'ether')} ETH\nStatus: ${
                        tx.blockNumber ? 'Confirmed' : 'Pending'
                    }\nTx Hash: ${tx.hash}\n\n`;
                });

                // Send message to Telegram
                await bot.sendMessage(chatId, message);
            }

            // Optional: check for pending transactions specifically
            // You can use tx.pool.status or mempool API if supported by the chain
            // Example pseudo-code:
            // const pendingTxs = await web3.txPool.content(); 
            // if (pendingTxs.length > 50) { ... }

        }

        lastBlockNumber = latestBlockNumber;

    } catch (err) {
        console.error('Error checking block:', err);
    }
}

// Poll every 15 seconds
setInterval(checkBlock, 15000);

// Optional: send bot online message
bot.sendMessage(chatId, 'TxMonitorBot is now monitoring the blockchain 🚀');

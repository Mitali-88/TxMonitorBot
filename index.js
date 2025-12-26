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
const SPAM_THRESHOLD = 16; // Minimum transactions to be considered spam
const TOP_SENDERS_DISPLAY = 5; // Number of top spammers to show

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
        return await web3.eth.getBlock(blockNumber, true);
    } catch (err) {
        console.error(`⚠️ Failed to fetch block ${blockNumber}:`, err.message);
        return null;
    }
}

// Analyze transaction patterns for spam detection
function analyzeSpamPatterns(transactions) {
    const patterns = {
        senderCounts: {},
        receiverCounts: {},
        gasPatterns: {},
        valuePatterns: {}
    };

    transactions.forEach(tx => {
        // Count by sender
        patterns.senderCounts[tx.from] = (patterns.senderCounts[tx.from] || 0) + 1;
        
        // Count by receiver
        if (tx.to) {
            patterns.receiverCounts[tx.to] = (patterns.receiverCounts[tx.to] || 0) + 1;
        }
        
        // Track gas prices (potential spam uses similar gas)
        const gasPrice = tx.gasPrice?.toString() || '0';
        patterns.gasPatterns[gasPrice] = (patterns.gasPatterns[gasPrice] || 0) + 1;
        
        // Track value patterns
        const value = tx.value?.toString() || '0';
        patterns.valuePatterns[value] = (patterns.valuePatterns[value] || 0) + 1;
    });

    return patterns;
}

// Check blocks and format message for Telegram
async function checkBlocksSummary() {
    try {
        const latestBlockNumber = await web3.eth.getBlockNumber();
        if (latestBlockNumber <= lastBlockNumber) return;

        let totalTxCount = 0;
        const blockDetails = [];
        const allTransactions = [];
        const blockNumbers = [];

        // Iterate through new blocks
        for (let i = lastBlockNumber + 1; i <= latestBlockNumber; i++) {
            const block = await fetchBlock(i);
            if (!block || !block.transactions) continue;

            const txCount = block.transactions.length;
            totalTxCount += txCount;
            blockDetails.push(`- Block ${block.number}: ${txCount} transactions`);
            blockNumbers.push(block.number);
            
            // Collect all transactions for analysis
            allTransactions.push(...block.transactions);
        }

        lastBlockNumber = latestBlockNumber;

        if (totalTxCount === 0) return;

        // Analyze spam patterns
        const patterns = analyzeSpamPatterns(allTransactions);

        // Identify top spam senders (≥SPAM_THRESHOLD TXs)
        const topSenders = Object.entries(patterns.senderCounts)
            .filter(([_, count]) => count >= SPAM_THRESHOLD)
            .sort((a, b) => b[1] - a[1]);

        // Format message exactly as requested
        let message = `${totalTxCount} transactions\n`;
        message += blockDetails.join('\n') + '\n';

        // Spam detection results
        if (topSenders.length > 0) {
            message += `Top Spam Sender Addresses (each with ≥${SPAM_THRESHOLD} transactions):\n`;
            
            const displaySenders = topSenders.slice(0, TOP_SENDERS_DISPLAY);
            displaySenders.forEach(([addr, count]) => {
                message += `- ${addr}\n`;
            });
            
            const extraCount = topSenders.length - TOP_SENDERS_DISPLAY;
            if (extraCount > 0) {
                message += `... and ${extraCount} additional addresses exhibiting the same pattern.\n`;
            }
        }

        // Investigation link
        message += `Investigation Link:\nBlock Explorer: https://xdcscan.com/block/${latestBlockNumber}`;

        await safeSendMessage(message);

    } catch (err) {
        console.error('❌ Error checking block summary:', err.message);
    }
}

// Helper function to make RPC calls with proper callback handling
function makeRpcCall(method, params = []) {
    return new Promise((resolve, reject) => {
        web3.currentProvider.send(
            {
                jsonrpc: '2.0',
                method: method,
                params: params,
                id: Date.now()
            },
            (error, result) => {
                if (error) {
                    reject(error);
                } else {
                    resolve(result);
                }
            }
        );
    });
}

// Enhanced pending transaction monitoring with spam detection
async function checkPendingTxs() {
    try {
        // Try to call txpool status directly
        let poolStatus;
        try {
            // Try direct RPC call using callback-based method
            const result = await makeRpcCall('txpool_status');
            poolStatus = result.result;
        } catch (err) {
            console.log('ℹ️ Transaction pool API not available, skipping pending check');
            return;
        }

        const pendingCount = parseInt(poolStatus.pending || '0x0', 16);
        const queuedCount = parseInt(poolStatus.queued || '0x0', 16);

        console.log(`📊 Pool Status - Pending: ${pendingCount}, Queued: ${queuedCount}`);

        // Alert on high pending count
        if (pendingCount > 50) {
            let message = `⚠️ High Pending Transaction Alert!\n\n`;
            message += `Pending Transactions: ${pendingCount}\n`;
            message += `Queued Transactions: ${queuedCount}\n\n`;

            // Try to get detailed content
            try {
                const result = await makeRpcCall('txpool_content');
                const content = result.result;

                const pendingSenders = {};
                
                // Analyze pending transactions
                if (content && content.pending) {
                    for (const from in content.pending) {
                        const txCount = Object.keys(content.pending[from]).length;
                        pendingSenders[from] = txCount;
                    }

                    // Find spam patterns in pending pool
                    const spamSenders = Object.entries(pendingSenders)
                        .filter(([_, count]) => count >= 10)
                        .sort((a, b) => b[1] - a[1]);

                    if (spamSenders.length > 0) {
                        message += `🚨 Potential Spam Detected in Pool:\n`;
                        spamSenders.slice(0, 5).forEach(([addr, count]) => {
                            message += `• ${addr}: ${count} pending txs\n`;
                        });
                    }
                }

            } catch (err) {
                console.error('⚠️ Failed to fetch pending TX content:', err.message);
                message += `⚠️ Unable to fetch detailed transaction data\n`;
            }

            await safeSendMessage(message);
        }

    } catch (err) {
        console.error('❌ Error checking pending transactions:', err.message);
    }
}

// Main loop: poll every 15 seconds
console.log('🚀 Starting TxMonitorBot...');
setInterval(() => {
    checkBlocksSummary();
    checkPendingTxs();
}, 15000);

// Initial check
checkBlocksSummary();

// Notify bot is online
safeSendMessage('✅ TxMonitorBot is now monitoring blocks and pending transactions 🚀')
    .catch(err => console.error('Failed to send online message:', err.message));
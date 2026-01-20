require('dotenv').config({ path: '.env.local' });
const { ethers } = require("ethers");

async function main() {
    console.log("--- EscrowV4 Deployment Arguments ---");

    const usdc = process.env.NEXT_PUBLIC_FUSDC_CONTRACT_ADDRESS || process.env.NEXT_PUBLIC_USDC_CONTRACT_ADDRESS;
    console.log(`_usdc (fUSDC): ${usdc}`);

    let botAddress = "Unknown (Check PAYOUT_PRIVATE_KEY)";
    if (process.env.PAYOUT_PRIVATE_KEY) {
        try {
            const wallet = new ethers.Wallet(process.env.PAYOUT_PRIVATE_KEY);
            botAddress = wallet.address;
        } catch (e) {
            console.error("Invalid Private Key");
        }
    }
    console.log(`_bot (Bot Wallet): ${botAddress}`);

    const treasury = process.env.NEXT_PUBLIC_TREASURY_ADDRESS || "USE_YOUR_WALLET_ADDRESS";
    console.log(`_treasury:      ${treasury}`);
}

main();

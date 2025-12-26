const ethers = require('ethers');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// Load environment variables
const envPath = path.resolve(__dirname, '../.env.local');
dotenv.config({ path: envPath });

async function main() {
    let output = '\n🔍 --- CONFIGURATION CHECK ---\n\n';

    // 1. USDC Address
    const usdc = process.env.NEXT_PUBLIC_USDC_ADDRESS;
    if (usdc) {
        output += `✅ USDC Address (Base Sepolia):\n   ${usdc}\n\n`;
    } else {
        output += `❌ USDC Address not found in .env.local\n\n`;
    }

    // 2. Bot Address (Derived from Private Key)
    const botKey = process.env.PAYOUT_PRIVATE_KEY;
    if (botKey) {
        try {
            const wallet = new ethers.Wallet(botKey);
            output += `✅ Bot Address (Derived from Private Key):\n   ${wallet.address}\n   (This is the wallet on your VPS/Script)\n\n`;
        } catch (e) {
            output += `❌ Invalid Private Key: ${e.message}\n\n`;
        }
    } else {
        output += `❌ Bot Private Key not found in .env.local\n\n`;
    }

    // 3. Treasury Address
    output += `❓ Treasury Address:\n`;
    output += `   You didn't specify one in the config.\n`;
    output += `   RECOMMENDATION: Use your main MetaMask address (the one you are deploying with).\n`;
    output += `   PRO TIP: You can change this later using setTreasury()\n`;

    output += '\n-----------------------------------\n';

    // Write to file
    fs.writeFileSync('addresses_output.txt', output);
    console.log("Addresses written to addresses_output.txt");
}

main();

import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

async function main() {
    console.log('\n🔍 --- CONFIGURATION CHECK ---\n');

    // 1. USDC Address
    const usdc = process.env.NEXT_PUBLIC_USDC_ADDRESS;
    if (usdc) {
        console.log(`✅ USDC Address (from .env.local):`);
        console.log(`   ${usdc}`);
    } else {
        console.log(`❌ USDC Address not found in .env.local (Look for NEXT_PUBLIC_USDC_ADDRESS)`);
    }

    console.log('\n-----------------------------------\n');

    // 2. Bot Address (Derived from Private Key)
    const botKey = process.env.PAYOUT_PRIVATE_KEY;
    if (botKey) {
        try {
            const wallet = new ethers.Wallet(botKey);
            console.log(`✅ Bot Address (Derived from PAYOUT_PRIVATE_KEY):`);
            console.log(`   ${wallet.address}`);
            console.log(`   (This is the wallet on your VPS/Script)`);
        } catch (e) {
            console.log(`❌ Invalid Private Key in PAYOUT_PRIVATE_KEY`);
        }
    } else {
        console.log(`❌ Bot Private Key not found (Look for PAYOUT_PRIVATE_KEY)`);
    }

    console.log('\n-----------------------------------\n');

    // 3. Treasury Address
    console.log(`❓ Treasury Address:`);
    console.log(`   You didn't specify one in the config.`);
    console.log(`   > RECOMMENDATION: Use your main MetaMask address (the one you are deploying with)`);
    console.log(`   > PRO TIP: You can change this later using setTreasury()`);

    console.log('\n-----------------------------------\n');
}

main();

const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });
console.log("USDC:", process.env.NEXT_PUBLIC_USDC_ADDRESS);

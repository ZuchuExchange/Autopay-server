const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const SECRET_KEY = process.env.AUTOPAY_SECRET_KEY;

// 1. STK Push Endpoint (Called by your payment form)
app.post('/pay', async (req, res) => {
    try {
        const { phone, amount } = req.body;

        if (!phone || !amount) {
            return res.status(400).json({ success: false, message: "Phone and amount are required." });
        }

        if (!SECRET_KEY) {
            return res.status(500).json({ success: false, message: "Server configuration error: AUTOPAY_SECRET_KEY missing." });
        }

        const response = await fetch('https://autopay.co.ke/api/stk-push', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${SECRET_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                phone: phone.toString().trim(),
                amount: Number(amount),
                balanceType: "wallet"
            })
        });

        const data = await response.json();
        console.log("AutoPay STK Push Response:", data);

        // Forwards AutoPay's raw response (contains success, status, checkout_request_id, etc.)
        return res.status(response.status).json(data);

    } catch (error) {
        console.error("STK Push Request Error:", error);
        return res.status(500).json({ success: false, message: "Internal server error.", error: error.message });
    }
});

// 2. Status Polling Endpoint (Called by processing.html)
app.post('/callback', async (req, res) => {
    try {
        // Accepts either checkoutRequestId or checkout_request_id from frontend
        const checkout_request_id = req.body.checkout_request_id || req.body.checkoutRequestId;

        if (!checkout_request_id) {
            return res.status(400).json({ 
                success: false, 
                message: "Missing checkout request ID parameter." 
            });
        }

        if (!SECRET_KEY) {
            return res.status(500).json({ 
                success: false, 
                message: "Server configuration error: AUTOPAY_SECRET_KEY missing." 
            });
        }

        const response = await fetch('https://autopay.co.ke/api/check-status', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${SECRET_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ checkout_request_id })
        });

        const data = await response.json();
        console.log(`AutoPay Status Check for ${checkout_request_id}:`, data);

        return res.status(response.status).json(data);

    } catch (error) {
        console.error("Status Check Error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch live status from AutoPay.",
            error: error.message
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server executing safely on port ${PORT}`));

import express from "express";
import { createServer } from "http";
import { Server as SocketServer } from "socket.io";
import { createServer as createViteServer } from "vite";
import path from "path";
import twilio from "twilio";
import dotenv from "dotenv";
import webpush from "web-push";
import Razorpay from "razorpay";

dotenv.config();

const isProd = process.env.NODE_ENV === "production";

// Configure web-push
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:example@yourdomain.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

// Razorpay Initialization
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'rzp_live_RvMKn3g0J7TcI4',
  key_secret: process.env.RAZORPAY_KEY_SECRET || '',
});

// In-memory subscription storage (for demo purposes)
let pushSubscriptions: any[] = [];

async function startServer() {
  const app = express();
  const server = createServer(app);
  const io = new SocketServer(server, {
    cors: { origin: "*" }
  });

  io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);
    socket.on("disconnect", () => console.log("Client disconnected"));
  });

  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

  // Razorpay Order Creation
  app.post('/api/payment/create-order', async (req, res) => {
    try {
      const { amount, currency = 'INR', receipt } = req.body;
      const options = {
        amount: Math.round(amount * 100), // amount in the smallest currency unit
        currency,
        receipt,
      };
      const order = await razorpay.orders.create(options);
      res.json(order);
    } catch (error) {
      console.error('Razorpay Order Error:', error);
      res.status(500).json({ error: 'Failed to create Razorpay order' });
    }
  });

  // Push Subscription Endpoint
  app.post("/api/push/subscribe", (req, res) => {
    const subscription = req.body;
    // Check if already exists
    const exists = pushSubscriptions.find(s => s.endpoint === subscription.endpoint);
    if (!exists) {
      pushSubscriptions.push(subscription);
    }
    res.status(201).json({ success: true });
  });

  // Notification Service
  const twilioClient = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN 
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

  app.post("/api/notify", async (req, res) => {
    const { type, data } = req.body;
    const { message, phone } = data;

    try {
      // 1. Send WhatsApp (via Twilio)
      if (twilioClient && process.env.TWILIO_WHATSAPP_NUMBER) {
        // Send to Admin
        if (process.env.ADMIN_WHATSAPP_NUMBER) {
          await twilioClient.messages.create({
            from: process.env.TWILIO_WHATSAPP_NUMBER,
            to: process.env.ADMIN_WHATSAPP_NUMBER,
            body: `[SkyRide] ${message}`,
          });
        }
        // Send to User/Driver if phone provided
        if (phone) {
          const formattedPhone = phone.startsWith("whatsapp:") ? phone : `whatsapp:${phone.startsWith("+") ? phone : "+91" + phone}`;
          await twilioClient.messages.create({
            from: process.env.TWILIO_WHATSAPP_NUMBER,
            to: formattedPhone,
            body: `[SkyRide] ${message}`,
          });
        }
      }

      // 2. Send Push Notifications
      if (type === 'NEW_RIDE' || type === 'RIDE_REQUESTED') {
        const payload = JSON.stringify({
          title: 'New Ride Alert! 🚖',
          body: message || 'A new ride is available in your area.',
          url: '/'
        });

        const pushPromises = pushSubscriptions.map(sub => 
          webpush.sendNotification(sub, payload).catch(err => {
            console.error("Push failed for subscription:", sub.endpoint, err);
            if (err.statusCode === 410 || err.statusCode === 404) {
              // Remove expired subscription
              pushSubscriptions = pushSubscriptions.filter(s => s.endpoint !== sub.endpoint);
            }
          })
        );
        await Promise.all(pushPromises);
      }

      // 3. Broadcast to all connected clients (Admin, Driver, User)
      io.emit("notification", { type, data });

      res.json({ success: true });
    } catch (error) {
      console.error("Notification Error:", error);
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  // Vite middleware for development
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve("dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.resolve("dist/index.html"));
    });
  }

  const PORT = 3000;
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();

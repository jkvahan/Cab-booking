import express from "express";
import { createServer } from "http";
import { Server as SocketServer } from "socket.io";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import twilio from "twilio";
import dotenv from "dotenv";
import webpush from "web-push";
import Razorpay from "razorpay";
import admin from "firebase-admin";

// Load firebase config manually to avoid import attribute issues in ESM
const firebaseConfig = JSON.parse(
  fs.readFileSync(path.resolve("firebase-applet-config.json"), "utf-8")
);

dotenv.config();

// Initialize Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp({
    projectId: firebaseConfig.projectId,
  });
}
const db = admin.firestore();
if (firebaseConfig.firestoreDatabaseId) {
  // If a specific database ID is provided in the config
  // Note: Standard firebase-admin doesn't easily support named databases in initializeApp
  // but we can try to use it if needed. However, usually it's the default one.
}

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
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_live_SY9A2V3V1yyLaS';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'b9VQ4dNIPs2gXwcYRJzYAqQ0';

const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET,
});

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

  // Config Status Endpoint
  app.get("/api/config/status", (req, res) => {
    res.json({
      razorpay_key_id: !!RAZORPAY_KEY_ID,
      razorpay_key_secret: !!RAZORPAY_KEY_SECRET,
      twilio_sid: !!process.env.TWILIO_ACCOUNT_SID,
      twilio_token: !!process.env.TWILIO_AUTH_TOKEN,
      vapid_keys: !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY)
    });
  });

  // Razorpay Order Creation
  app.post('/api/payment/create-order', async (req, res) => {
    const { amount, currency = 'INR', receipt } = req.body;

    if (!RAZORPAY_KEY_SECRET) {
      console.error('CRITICAL: RAZORPAY_KEY_SECRET is missing.');
      return res.status(500).json({ 
        error: 'Configuration Error',
        details: 'Razorpay Secret Key is missing. Real payments require this key. Please set RAZORPAY_KEY_SECRET in Settings > Secrets.'
      });
    }

    try {
      
      if (typeof amount !== 'number' || isNaN(amount) || amount <= 0) {
        return res.status(400).json({ 
          error: 'Invalid Amount',
          details: 'The payment amount must be a positive number.'
        });
      }
      
      // Ensure amount is at least 1 INR (100 paise)
      const finalAmount = Math.max(Math.round(amount * 100), 100);
      
      const options = {
        amount: finalAmount,
        currency,
        receipt: receipt || `rcpt_${Date.now()}`,
      };
      
      console.log('Creating Razorpay Order:', options);
      const order = await razorpay.orders.create(options);
      res.json(order);
    } catch (error: any) {
      console.error('Razorpay Order Error Details:', {
        message: error.message,
        description: error.description,
        code: error.code,
        metadata: error.metadata,
        source: error.source,
        step: error.step,
        reason: error.reason
      });
      res.status(500).json({ 
        error: 'Failed to create Razorpay order',
        details: error.description || error.message || 'Unknown error'
      });
    }
  });

  // Push Subscription Endpoint
  app.post("/api/push/subscribe", async (req, res) => {
    const subscription = req.body;
    try {
      // Use endpoint as a unique ID to avoid duplicates
      const subId = Buffer.from(subscription.endpoint).toString('base64').replace(/\//g, '_');
      await db.collection('push_subscriptions').doc(subId).set(subscription);
      res.status(201).json({ success: true });
    } catch (error) {
      console.error("Error saving push subscription:", error);
      res.status(500).json({ success: false });
    }
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

        const subsSnapshot = await db.collection('push_subscriptions').get();
        const pushPromises = subsSnapshot.docs.map(doc => {
          const sub = doc.data();
          return webpush.sendNotification(sub as any, payload).catch(async err => {
            console.error("Push failed for subscription:", sub.endpoint, err);
            if (err.statusCode === 410 || err.statusCode === 404) {
              // Remove expired subscription
              await db.collection('push_subscriptions').doc(doc.id).delete();
            }
          });
        });
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

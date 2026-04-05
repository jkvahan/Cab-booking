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
import cors from "cors";
import { initializeApp, getApps, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// Load firebase config manually to avoid import attribute issues in ESM
let firebaseConfig: any = {};
try {
  firebaseConfig = JSON.parse(
    fs.readFileSync(path.resolve("firebase-applet-config.json"), "utf-8")
  );
} catch (error) {
  console.error("Failed to load firebase-applet-config.json:", error);
}

dotenv.config();

// Initialize Firebase Admin
let firebaseApp;
try {
  if (!getApps().length) {
    // Try to initialize with applicationDefault first
    try {
      firebaseApp = initializeApp({
        credential: applicationDefault(),
        projectId: firebaseConfig.projectId,
      });
      console.log("Firebase Admin initialized with applicationDefault");
    } catch (e) {
      console.warn("Failed to initialize with applicationDefault, falling back to basic initializeApp:", e);
      firebaseApp = initializeApp({
        projectId: firebaseConfig.projectId,
      });
    }
  } else {
    firebaseApp = getApps()[0];
  }
} catch (error) {
  console.error("Critical: Failed to initialize Firebase Admin:", error);
}

const databaseId = firebaseConfig.firestoreDatabaseId;
console.log("Using Firestore Database ID:", databaseId || "(default)");

let db: any;
try {
  if (firebaseApp) {
    db = databaseId ? getFirestore(firebaseApp, databaseId) : getFirestore(firebaseApp);
  } else {
    db = databaseId ? getFirestore(databaseId) : getFirestore();
  }
} catch (error) {
  console.error("Failed to get Firestore instance:", error);
}

// Test Firestore connection at startup
if (db) {
  (async () => {
    try {
      console.log("Testing Firestore connection...");
      await db.collection('push_subscriptions').limit(1).get();
      console.log("Firestore connection successful.");
    } catch (error) {
      console.error("Firestore startup connection test failed:", error);
    }
  })();
}

const isProd = process.env.NODE_ENV === "production";

// Configure web-push
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'BC2F3-qn7u8AYKdqDSxY9ZMWRVqBYsd9e3lGQFX9jqpAid1SrmFISUM4BHAeBL6HP7QIKRId70iOu7stL5XeTf8';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'OHBS3fnZkhZpxivIspusKK79gq6f8D8OTeNvGZYkYdI';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:digitalserviceindia84@gmail.com';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    VAPID_SUBJECT,
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
}

// Razorpay Initialization
const RAZORPAY_KEY_ID = (process.env.RAZORPAY_KEY_ID || 'rzp_live_SZ19ACg52mDGSZ').trim();
const RAZORPAY_KEY_SECRET = (process.env.RAZORPAY_KEY_SECRET || 'bN762yHQnXrFEYmooY3TxEs9').trim();

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
  app.use(cors());

  // Health check
  app.get("/health", (req, res) => res.send("OK"));

  // Config Status Endpoint
  app.get("/api/config/status", (req, res) => {
    res.json({
      razorpay_key_id: RAZORPAY_KEY_ID,
      razorpay_key_secret: !!RAZORPAY_KEY_SECRET,
      twilio_sid: !!process.env.TWILIO_ACCOUNT_SID,
      twilio_token: !!process.env.TWILIO_AUTH_TOKEN,
      vapid_keys: !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY)
    });
  });

  // System Memory Endpoint
  app.get("/api/system/memory", (req, res) => {
    const memoryUsage = process.memoryUsage();
    res.json({
      rss: Math.round(memoryUsage.rss / 1024 / 1024),
      heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024),
      heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
      external: Math.round(memoryUsage.external / 1024 / 1024),
      limit: 16384 // We set this in package.json
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
      const pushTypes = ['NEW_RIDE', 'RIDE_REQUESTED', 'NEW_BOOKING', 'RIDE_ACCEPTED', 'RIDE_STARTED', 'RIDE_COMPLETED', 'RIDE_CANCELLED', 'RIDE_DRIVER_CANCELLED'];
      if (pushTypes.includes(type)) {
        const payload = JSON.stringify({
          title: type.replace(/_/g, ' ').replace('NEW ', 'New '),
          body: message || 'A ride update is available.',
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
    try {
      console.log("Initializing Vite middleware...");
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: "spa",
      });
      app.use(vite.middlewares);
      console.log("Vite middleware initialized.");
    } catch (err) {
      console.error("Failed to initialize Vite middleware:", err);
      // Fallback to serving static files if build exists
      if (fs.existsSync(path.resolve("dist"))) {
        console.log("Falling back to serving static files from dist...");
        app.use(express.static(path.resolve("dist")));
        app.get("*", (req, res) => {
          res.sendFile(path.resolve("dist/index.html"));
        });
      }
    }
  } else {
    app.use(express.static(path.resolve("dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.resolve("dist/index.html"));
    });
  }

  // Global Error Handler - MUST BE LAST
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error("Express Error:", err);
    res.status(500).json({ error: "Internal Server Error", details: err.message });
  });

  process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  });

  const PORT = 3000;
  console.log(`Attempting to start server on port ${PORT}...`);
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

console.log("Starting server script...");
startServer().catch(err => {
  console.error("Failed to start server:", err);
});

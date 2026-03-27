import express from "express";
import { createServer } from "http";
import { Server as SocketServer } from "socket.io";
import { createServer as createViteServer } from "vite";
import path from "path";
import nodemailer from "nodemailer";
import twilio from "twilio";
import dotenv from "dotenv";

dotenv.config();

const isProd = process.env.NODE_ENV === "production";

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

  app.use(express.json());

  // Notification Service
  const transporter = nodemailer.createTransport({
    service: process.env.EMAIL_SERVICE || "gmail",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  const twilioClient = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN 
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

  app.post("/api/notify", async (req, res) => {
    const { type, data } = req.body;
    const { userEmail, driverEmail, adminEmail, message, phone } = data;

    try {
      // 1. Send Emails
      const recipients = [userEmail, driverEmail, adminEmail].filter(Boolean);
      if (recipients.length > 0 && process.env.EMAIL_USER) {
        await transporter.sendMail({
          from: process.env.EMAIL_USER,
          to: recipients.join(", "),
          subject: `JK Vahan Ride Update: ${type}`,
          text: message,
        });
      }

      // 2. Send WhatsApp (via Twilio)
      if (twilioClient && process.env.TWILIO_WHATSAPP_NUMBER) {
        // Send to Admin
        if (process.env.ADMIN_WHATSAPP_NUMBER) {
          await twilioClient.messages.create({
            from: process.env.TWILIO_WHATSAPP_NUMBER,
            to: process.env.ADMIN_WHATSAPP_NUMBER,
            body: `[JK Vahan] ${message}`,
          });
        }
        // Send to User/Driver if phone provided
        if (phone) {
          const formattedPhone = phone.startsWith("whatsapp:") ? phone : `whatsapp:${phone.startsWith("+") ? phone : "+91" + phone}`;
          await twilioClient.messages.create({
            from: process.env.TWILIO_WHATSAPP_NUMBER,
            to: formattedPhone,
            body: `[JK Vahan] ${message}`,
          });
        }
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

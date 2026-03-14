import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs";

const isProd = process.env.NODE_ENV === "production";
const db = new Database("cab_booking.db");
db.pragma('foreign_keys = ON');

// Initialize Database
db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE,
    password TEXT,
    pin TEXT DEFAULT '1234',
    role TEXT DEFAULT 'admin' -- owner, admin
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT,
    phone TEXT UNIQUE,
    password TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS drivers (
    id TEXT PRIMARY KEY,
    name TEXT,
    phone TEXT UNIQUE,
    password TEXT,
    status TEXT DEFAULT 'inactive', -- active, inactive
    wallet_balance REAL DEFAULT 0,
    is_online INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS vehicles (
    id TEXT PRIMARY KEY,
    driver_id TEXT,
    model TEXT,
    plate_number TEXT UNIQUE,
    type TEXT, -- Mini, Sedan, SUV
    FOREIGN KEY(driver_id) REFERENCES drivers(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS rides (
    id TEXT PRIMARY KEY,
    tracking_id TEXT UNIQUE,
    pickup_location TEXT,
    dropoff_location TEXT,
    pickup_lat REAL,
    pickup_lng REAL,
    dropoff_lat REAL,
    dropoff_lng REAL,
    status TEXT DEFAULT 'pending', -- pending, accepted, ongoing, completed, cancelled
    fare REAL,
    vehicle_type TEXT,
    driver_id TEXT,
    user_id TEXT,
    trip_type TEXT DEFAULT 'single', -- single, round
    distance REAL,
    start_otp TEXT,
    end_otp TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME,
    FOREIGN KEY(driver_id) REFERENCES drivers(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    user_name TEXT,
    user_phone TEXT
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    driver_id TEXT,
    amount REAL,
    type TEXT, -- credit, debit
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(driver_id) REFERENCES drivers(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS withdrawal_requests (
    id TEXT PRIMARY KEY,
    driver_id TEXT,
    amount REAL,
    bank_details TEXT,
    status TEXT DEFAULT 'pending', -- pending, approved, rejected
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(driver_id) REFERENCES drivers(id) ON DELETE CASCADE
  );
`);

// Migrations
try { db.prepare("ALTER TABLE drivers ADD COLUMN wallet_balance REAL DEFAULT 0").run(); } catch (e) {}
try { db.prepare("ALTER TABLE withdrawal_requests ADD COLUMN bank_details TEXT").run(); } catch (e) {}
try { db.prepare("ALTER TABLE admins ADD COLUMN pin TEXT DEFAULT '1234'").run(); } catch (e) {}
try { db.prepare("ALTER TABLE rides ADD COLUMN vehicle_type TEXT").run(); } catch (e) {}
try { db.prepare("ALTER TABLE rides ADD COLUMN user_name TEXT").run(); } catch (e) {}
try { db.prepare("ALTER TABLE rides ADD COLUMN user_phone TEXT").run(); } catch (e) {}
try { db.prepare("ALTER TABLE rides ADD COLUMN pickup_lat REAL").run(); } catch (e) {}
try { db.prepare("ALTER TABLE rides ADD COLUMN distance REAL").run(); } catch (e) {}
try { db.prepare("ALTER TABLE rides ADD COLUMN pickup_lng REAL").run(); } catch (e) {}
try { db.prepare("ALTER TABLE rides ADD COLUMN dropoff_lat REAL").run(); } catch (e) {}
try { db.prepare("ALTER TABLE rides ADD COLUMN dropoff_lng REAL").run(); } catch (e) {}
try { db.prepare("ALTER TABLE rides ADD COLUMN trip_type TEXT DEFAULT 'single'").run(); } catch (e) {}
try { db.prepare("ALTER TABLE rides ADD COLUMN start_otp TEXT").run(); } catch (e) {}
try { db.prepare("ALTER TABLE rides ADD COLUMN end_otp TEXT").run(); } catch (e) {}
try { db.prepare("ALTER TABLE rides ADD COLUMN tracking_id TEXT").run(); } catch (e) {}
try { db.prepare("ALTER TABLE rides ADD COLUMN user_id TEXT").run(); } catch (e) {}
try { db.prepare("ALTER TABLE rides ADD COLUMN eta INTEGER").run(); } catch (e) {}
try { db.prepare("ALTER TABLE rides ADD COLUMN fare REAL").run(); } catch (e) {}
try { db.prepare("ALTER TABLE rides ADD COLUMN pickup_location TEXT").run(); } catch (e) {}
try { db.prepare("ALTER TABLE rides ADD COLUMN dropoff_location TEXT").run(); } catch (e) {}
try { db.prepare("ALTER TABLE rides ADD COLUMN status TEXT").run(); } catch (e) {}
try { db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_rides_tracking_id ON rides(tracking_id)").run(); } catch (e) {}

// Seed Owner if not exists
const ownerExists = db.prepare("SELECT * FROM admins WHERE username = 'Shafiq'").get();
if (!ownerExists) {
  db.prepare("INSERT INTO admins (id, username, password, role) VALUES (?, ?, ?, ?)").run(
    uuidv4(),
    "Shafiq",
    process.env.ADMIN_PASSWORD || "2003",
    "owner"
  );
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({ server });

  app.use(express.json());

  // WebSocket handling
  const clients = new Map<string, WebSocket>(); // userId -> socket

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const userId = url.searchParams.get("userId");
    if (userId) {
      clients.set(userId, ws);
      ws.on("close", () => clients.delete(userId));
    }
  });

  const broadcastToAll = (data: any) => {
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(data));
      }
    });
  };

  const broadcastToAdmins = broadcastToAll;
  const broadcastToDrivers = broadcastToAll;

  // --- API Routes ---

  // Admin Login (Step 1: Password)
  app.post("/api/admin/login", (req, res) => {
    const { username, password } = req.body;
    const admin = db.prepare("SELECT * FROM admins WHERE username = ? AND password = ?").get(username, password) as any;
    if (admin) {
      res.json({ success: true, requiresPin: true, adminId: admin.id });
    } else {
      res.status(401).json({ error: "Invalid credentials" });
    }
  });

  // Admin Login (Step 2: PIN)
  app.post("/api/admin/verify-pin", (req, res) => {
    const { adminId, pin } = req.body;
    const admin = db.prepare("SELECT * FROM admins WHERE id = ? AND pin = ?").get(adminId, pin);
    if (admin) {
      res.json({ success: true, admin });
    } else {
      res.status(401).json({ error: "Invalid PIN" });
    }
  });

  app.post("/api/admin/forgot-password", (req, res) => {
    const { username, newPassword } = req.body;
    const admin = db.prepare("SELECT * FROM admins WHERE username = ?").get(username);
    if (admin) {
      db.prepare("UPDATE admins SET password = ? WHERE username = ?").run(newPassword, username);
      res.json({ success: true, message: "Password updated successfully" });
    } else {
      res.status(404).json({ success: false, error: "Admin not found" });
    }
  });

  // Owner/Admin: Manage Admins
  app.get("/api/admin/admins", (req, res) => {
    const admins = db.prepare("SELECT id, username, role FROM admins").all();
    res.json(admins);
  });

  app.post("/api/admin/admins", (req, res) => {
    const { username, password, pin, role } = req.body;
    try {
      db.prepare("INSERT INTO admins (id, username, password, pin, role) VALUES (?, ?, ?, ?, ?)")
        .run(uuidv4(), username, password, pin || '1234', role || 'admin');
      res.json({ success: true });
    } catch (e) {
      res.status(400).json({ error: "Username already exists" });
    }
  });

  app.delete("/api/admin/admins/:id", (req, res) => {
    const adminIdToDelete = req.params.id;
    const admin = db.prepare("SELECT * FROM admins WHERE id = ?").get(adminIdToDelete) as any;
    if (admin && admin.role === 'owner') {
      return res.status(403).json({ error: "Cannot delete owner" });
    }
    db.prepare("DELETE FROM admins WHERE id = ?").run(adminIdToDelete);
    res.json({ success: true });
  });

  // Admin: User Management
  app.get("/api/admin/users", (req, res) => {
    const users = db.prepare("SELECT * FROM users ORDER BY created_at DESC").all();
    res.json(users);
  });

  app.delete("/api/admin/users/:id", (req, res) => {
    const userId = req.params.id;
    db.prepare("DELETE FROM rides WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    res.json({ success: true });
  });

  // Admin: Driver Management
  app.delete("/api/admin/drivers/:id", (req, res) => {
    const driverId = req.params.id;
    db.prepare("DELETE FROM vehicles WHERE driver_id = ?").run(driverId);
    db.prepare("DELETE FROM rides WHERE driver_id = ?").run(driverId);
    db.prepare("DELETE FROM transactions WHERE driver_id = ?").run(driverId);
    db.prepare("DELETE FROM withdrawal_requests WHERE driver_id = ?").run(driverId);
    db.prepare("DELETE FROM drivers WHERE id = ?").run(driverId);
    res.json({ success: true });
  });

  // Admin: Get All Rides (Expanded)
  app.get("/api/admin/rides", (req, res) => {
    const rides = db.prepare(`
      SELECT r.*, d.name as driver_name, u.name as user_name
      FROM rides r
      LEFT JOIN drivers d ON r.driver_id = d.id
      LEFT JOIN users u ON r.user_id = u.id
      ORDER BY r.created_at DESC
    `).all();
    res.json(rides);
  });

  // User Auth
  app.post("/api/user/register", (req, res) => {
    const { name, phone, password } = req.body;
    try {
      const id = uuidv4();
      db.prepare("INSERT INTO users (id, name, phone, password) VALUES (?, ?, ?, ?)").run(id, name, phone, password);
      res.json({ success: true, userId: id });
    } catch (e) {
      res.status(400).json({ error: "Phone already registered" });
    }
  });

  app.post("/api/user/forgot-password", (req, res) => {
    const { phone, newPassword } = req.body;
    const user = db.prepare("SELECT * FROM users WHERE phone = ?").get(phone);
    if (user) {
      db.prepare("UPDATE users SET password = ? WHERE phone = ?").run(newPassword, phone);
      res.json({ success: true, message: "Password updated successfully" });
    } else {
      res.status(404).json({ success: false, error: "User not found" });
    }
  });

  app.post("/api/user/login", (req, res) => {
    const { phone, password } = req.body;
    const user = db.prepare("SELECT * FROM users WHERE phone = ? AND password = ?").get(phone, password);
    if (user) {
      res.json({ success: true, user });
    } else {
      res.status(401).json({ error: "Invalid credentials" });
    }
  });

  // Driver Auth
  app.post("/api/driver/register", (req, res) => {
    const { name, phone, password } = req.body;
    try {
      const id = uuidv4();
      db.prepare("INSERT INTO drivers (id, name, phone, password) VALUES (?, ?, ?, ?)").run(id, name, phone, password);
      res.json({ success: true, driverId: id });
    } catch (e) {
      res.status(400).json({ error: "Phone already registered" });
    }
  });

  app.post("/api/driver/forgot-password", (req, res) => {
    const { phone, newPassword } = req.body;
    const driver = db.prepare("SELECT * FROM drivers WHERE phone = ?").get(phone);
    if (driver) {
      db.prepare("UPDATE drivers SET password = ? WHERE phone = ?").run(newPassword, phone);
      res.json({ success: true, message: "Password updated successfully" });
    } else {
      res.status(404).json({ success: false, error: "Driver not found" });
    }
  });

  app.post("/api/driver/login", (req, res) => {
    const { phone, password } = req.body;
    const driver = db.prepare("SELECT * FROM drivers WHERE phone = ? AND password = ?").get(phone, password) as any;
    if (driver) {
      if (driver.status !== 'active') {
        return res.status(403).json({ 
          success: false, 
          error: "Your account is pending activation. Please contact admin for verification.",
          status: driver.status 
        });
      }
      res.json({ success: true, driver });
    } else {
      res.status(401).json({ error: "Invalid credentials" });
    }
  });

  // User: Book Ride
  app.post("/api/rides/book", (req, res) => {
    const { pickup, dropoff, fare, userId, userName, userPhone, vehicleType, tripType, distance, pickupLat, pickupLng, dropoffLat, dropoffLng } = req.body;
    console.log("Booking ride request:", { pickup, dropoff, fare, userId, userName, userPhone, vehicleType, tripType, distance, pickupLat, pickupLng, dropoffLat, dropoffLng });
    
    if (!pickup || !dropoff) {
      return res.status(400).json({ success: false, error: "Pickup and dropoff locations are required" });
    }

    try {
      if (userId) {
        const userExists = db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
        if (!userExists) {
          return res.status(400).json({ success: false, error: "Invalid user account" });
        }
      }
      const id = uuidv4();
      const trackingId = Math.random().toString(36).substring(2, 10).toUpperCase();
      const startOtp = Math.floor(1000 + Math.random() * 9000).toString();
      const endOtp = Math.floor(1000 + Math.random() * 9000).toString();
      
      const stmt = db.prepare("INSERT INTO rides (id, tracking_id, pickup_location, dropoff_location, fare, vehicle_type, trip_type, distance, start_otp, end_otp, user_id, user_name, user_phone, status, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)");
      stmt.run(id, trackingId, pickup, dropoff, fare || 0, vehicleType || 'Mini', tripType || 'single', distance || null, startOtp, endOtp, userId || null, userName || null, userPhone || null, pickupLat || null, pickupLng || null, dropoffLat || null, dropoffLng || null);
      
      const ride = db.prepare("SELECT * FROM rides WHERE id = ?").get(id);
      broadcastToAll({ type: "NEW_RIDE", ride });
      console.log("Ride booked successfully:", trackingId);
      res.json({ success: true, trackingId, ride });
    } catch (error: any) {
      console.error("Booking error details:", error);
      res.status(500).json({ success: false, error: `Booking failed: ${error.message || 'Unknown error'}` });
    }
  });

  app.get("/api/user/:id/bookings", (req, res) => {
    const userId = req.params.id;
    const bookings = db.prepare(`
      SELECT r.*, d.name as driver_name, d.phone as driver_phone, v.model as vehicle_model, v.plate_number
      FROM rides r 
      LEFT JOIN drivers d ON r.driver_id = d.id 
      LEFT JOIN vehicles v ON d.id = v.driver_id
      WHERE r.user_id = ? 
      ORDER BY r.created_at DESC
    `).all(userId);
    res.json(bookings);
  });

  // User: Cancel Ride
  app.post("/api/user/cancel-ride", (req, res) => {
    const { rideId } = req.body;
    const ride = db.prepare("SELECT * FROM rides WHERE id = ?").get(rideId) as any;
    if (ride && (ride.status === 'pending' || ride.status === 'accepted')) {
      db.prepare("UPDATE rides SET status = 'cancelled' WHERE id = ?").run(rideId);
      const updatedRide = db.prepare("SELECT * FROM rides WHERE id = ?").get(rideId);
      broadcastToAdmins({ type: "RIDE_UPDATED", ride: updatedRide });
      res.json({ success: true });
    } else {
      res.status(400).json({ error: "Cannot cancel ride in current status" });
    }
  });

  // User: Get My Rides
  app.get("/api/user/:id/rides", (req, res) => {
    const rides = db.prepare(`
      SELECT r.*, d.name as driver_name, d.phone as driver_phone, v.model as vehicle_model, v.plate_number,
             COALESCE(r.user_phone, u.phone) as user_phone, 
             COALESCE(r.user_name, u.name) as user_name
      FROM rides r
      LEFT JOIN drivers d ON r.driver_id = d.id
      LEFT JOIN vehicles v ON d.id = v.driver_id
      LEFT JOIN users u ON r.user_id = u.id
      WHERE r.user_id = ? 
      ORDER BY created_at DESC
    `).all(req.params.id);
    res.json(rides);
  });

  // User: Track Ride
  app.get("/api/rides/track/:trackingId", (req, res) => {
    const ride = db.prepare(`
      SELECT r.*, d.name as driver_name, d.phone as driver_phone, v.model as vehicle_model, v.plate_number,
             COALESCE(r.user_phone, u.phone) as user_phone, 
             COALESCE(r.user_name, u.name) as user_name
      FROM rides r
      LEFT JOIN drivers d ON r.driver_id = d.id
      LEFT JOIN vehicles v ON d.id = v.driver_id
      LEFT JOIN users u ON r.user_id = u.id
      WHERE r.tracking_id = ?
    `).get(req.params.trackingId);
    if (ride) res.json(ride);
    else res.status(404).json({ error: "Ride not found" });
  });

  // Admin: Get All Rides (Expanded) - handled above

  // Admin: Manage Drivers
  app.get("/api/admin/drivers", (req, res) => {
    const drivers = db.prepare("SELECT * FROM drivers").all();
    res.json(drivers);
  });

  app.post("/api/admin/drivers/:id/status", (req, res) => {
    const { status } = req.body;
    db.prepare("UPDATE drivers SET status = ? WHERE id = ?").run(status, req.params.id);
    res.json({ success: true });
  });

  // Admin: Manage Vehicles
  app.get("/api/admin/vehicles", (req, res) => {
    const vehicles = db.prepare(`
      SELECT v.*, d.name as driver_name 
      FROM vehicles v 
      LEFT JOIN drivers d ON v.driver_id = d.id
    `).all();
    res.json(vehicles);
  });

  app.post("/api/admin/vehicles", (req, res) => {
    const { model, plate_number, type, driver_id } = req.body;
    db.prepare("INSERT INTO vehicles (id, model, plate_number, type, driver_id) VALUES (?, ?, ?, ?, ?)")
      .run(uuidv4(), model, plate_number, type, driver_id);
    res.json({ success: true });
  });

  // Driver: Get Available Rides
  app.get("/api/driver/available-rides", (req, res) => {
    const rides = db.prepare(`
      SELECT r.*, d.name as driver_name, 
             COALESCE(r.user_phone, u.phone) as user_phone, 
             COALESCE(r.user_name, u.name) as user_name
      FROM rides r
      LEFT JOIN drivers d ON r.driver_id = d.id
      LEFT JOIN users u ON r.user_id = u.id
      ORDER BY r.created_at DESC
      LIMIT 50
    `).all();
    res.json(rides);
  });

  // Driver: Accept Ride
  app.post("/api/driver/accept-ride", (req, res) => {
    const { rideId, driverId, eta } = req.body;
    
    // Check if ride is still pending
    const ride = db.prepare("SELECT * FROM rides WHERE id = ?").get(rideId) as any;
    if (!ride) return res.status(404).json({ error: "Ride not found" });
    if (ride.status !== 'pending') {
      return res.status(400).json({ error: "Ride already accepted by another driver" });
    }

    // Check if driver exists
    const driver = db.prepare("SELECT * FROM drivers WHERE id = ?").get(driverId);
    if (!driver) return res.status(404).json({ error: "Driver not found" });

    db.prepare("UPDATE rides SET status = 'accepted', driver_id = ?, eta = ? WHERE id = ?").run(driverId, eta || 0, rideId);
    const updatedRide = db.prepare("SELECT * FROM rides WHERE id = ?").get(rideId);
    broadcastToAll({ type: "RIDE_UPDATED", ride: updatedRide });
    res.json({ success: true, ride: updatedRide });
  });

  // Driver: Start Ride (OTP required)
  app.post("/api/driver/start-ride", (req, res) => {
    const { rideId, otp } = req.body;
    const trimmedOtp = String(otp || "").trim();
    console.log(`Attempting to start ride ${rideId} with OTP ${trimmedOtp}`);
    const ride = db.prepare("SELECT * FROM rides WHERE id = ?").get(rideId) as any;
    if (ride) {
      const expectedOtp = String(ride.start_otp || "").trim();
      console.log(`Found ride. Expected Start OTP: ${expectedOtp}, Received: ${trimmedOtp}`);
      if (expectedOtp === trimmedOtp) {
        db.prepare("UPDATE rides SET status = 'ongoing', started_at = CURRENT_TIMESTAMP WHERE id = ?").run(rideId);
        const updatedRide = db.prepare("SELECT * FROM rides WHERE id = ?").get(rideId);
        broadcastToAll({ type: "RIDE_UPDATED", ride: updatedRide });
        res.json({ success: true });
      } else {
        res.status(400).json({ error: "Invalid Start OTP" });
      }
    } else {
      res.status(404).json({ error: "Ride not found" });
    }
  });

  // Driver: Complete Ride (OTP required) & Update Wallet
  app.post("/api/driver/complete-ride", (req, res) => {
    const { rideId, otp } = req.body;
    const trimmedOtp = String(otp || "").trim();
    
    console.log(`Attempting to complete ride ${rideId} with OTP ${trimmedOtp}`);
    const ride = db.prepare("SELECT * FROM rides WHERE id = ?").get(rideId) as any;
    if (ride) {
      const expectedOtp = String(ride.end_otp || "").trim();
      console.log(`Found ride. Expected End OTP: ${expectedOtp}, Received: ${trimmedOtp}, Status: ${ride.status}`);
      if (expectedOtp === trimmedOtp && ride.status === 'ongoing') {
        const amount = ride.fare || 0;
        db.prepare("UPDATE rides SET status = 'completed' WHERE id = ?").run(rideId);
        
        // Update Driver Wallet (Deduct 10% commission)
        const driverId = ride.driver_id;
        const commission = amount * 0.10;
        db.prepare("UPDATE drivers SET wallet_balance = COALESCE(wallet_balance, 0) - ? WHERE id = ?").run(commission, driverId);
        
        // Record Transaction
        db.prepare("INSERT INTO transactions (id, driver_id, amount, type, description) VALUES (?, ?, ?, ?, ?)")
          .run(uuidv4(), driverId, commission, 'debit', `Commission for ride ${ride.tracking_id || rideId} (Fare: ₹${amount})`);

        const updatedRide = db.prepare("SELECT * FROM rides WHERE id = ?").get(rideId);
        broadcastToAll({ type: "RIDE_UPDATED", ride: updatedRide });
        res.json({ success: true });
      } else if (ride.status !== 'ongoing') {
        res.status(400).json({ error: "Ride is not in ongoing status" });
      } else {
        res.status(400).json({ error: "Invalid End OTP" });
      }
    } else {
      res.status(404).json({ error: "Ride not found" });
    }
  });

  // Driver: Cancel Ride (Fine logic)
  app.post("/api/driver/cancel-ride", (req, res) => {
    const { rideId, driverId } = req.body;
    const fineAmount = 50; // Fixed fine for cancellation after acceptance
    
    const ride = db.prepare("SELECT * FROM rides WHERE id = ?").get(rideId) as any;
    if (!ride) return res.status(404).json({ error: "Ride not found" });
    
    // Only fine if it was accepted or ongoing
    if (ride.status === 'accepted' || ride.status === 'ongoing') {
      db.prepare("UPDATE drivers SET wallet_balance = wallet_balance - ? WHERE id = ?").run(fineAmount, driverId);
      db.prepare("INSERT INTO transactions (id, driver_id, amount, type, description) VALUES (?, ?, ?, ?, ?)")
        .run(uuidv4(), driverId, fineAmount, 'debit', `Fine for cancelling ride ${ride.tracking_id || rideId}`);
    }

    // Set back to pending so other drivers can accept
    db.prepare("UPDATE rides SET status = 'pending', driver_id = NULL, eta = NULL WHERE id = ?").run(rideId);
    
    const updatedRide = db.prepare("SELECT * FROM rides WHERE id = ?").get(rideId);
    broadcastToAll({ type: "NEW_RIDE", ride: updatedRide }); // Broadcast as new ride for others
    res.json({ success: true, fine: fineAmount });
  });

  // Admin: Adjust Driver Wallet
  app.post("/api/admin/driver/adjust-wallet", (req, res) => {
    const { driverId, amount: rawAmount, type, reason } = req.body;
    console.log("Wallet adjustment request:", { driverId, rawAmount, type, reason });
    const amount = parseFloat(rawAmount);
    if (isNaN(amount)) return res.status(400).json({ error: "Invalid amount" });

    const driver = db.prepare("SELECT * FROM drivers WHERE id = ?").get(driverId) as any;
    if (!driver) return res.status(404).json({ error: "Driver not found" });

    const adjustment = type === 'credit' ? amount : -amount;
    
    try {
      const transaction = db.transaction(() => {
        const result = db.prepare("UPDATE drivers SET wallet_balance = COALESCE(wallet_balance, 0) + ? WHERE id = ?").run(adjustment, driverId);
        if (result.changes === 0) throw new Error("Driver not found or update failed");

        db.prepare("INSERT INTO transactions (id, driver_id, amount, type, description) VALUES (?, ?, ?, ?, ?)")
          .run(uuidv4(), driverId, amount, type, reason || `Admin adjustment: ${type}`);
      });
      
      transaction();
      res.json({ success: true });
    } catch (error: any) {
      console.error("Wallet adjustment error:", error);
      res.status(500).json({ error: error.message || "Failed to adjust wallet" });
    }
  });

  // Admin: Get all withdrawal requests
  app.get("/api/admin/withdrawals", (req, res) => {
    const requests = db.prepare(`
      SELECT w.*, d.name as driver_name, d.phone as driver_phone 
      FROM withdrawal_requests w 
      JOIN drivers d ON w.driver_id = d.id 
      ORDER BY w.created_at DESC
    `).all();
    res.json(requests);
  });

  // Admin: Action on withdrawal request
  app.post("/api/admin/withdrawals/:id/action", (req, res) => {
    const { id } = req.params;
    const { action } = req.body; // approved, rejected
    
    const request = db.prepare("SELECT * FROM withdrawal_requests WHERE id = ?").get(id) as any;
    if (!request) return res.status(404).json({ error: "Request not found" });
    if (request.status !== 'pending') return res.status(400).json({ error: "Request already processed" });

    db.prepare("UPDATE withdrawal_requests SET status = ? WHERE id = ?").run(action, id);

    if (action === 'rejected') {
      // Refund the driver
      db.prepare("UPDATE drivers SET wallet_balance = wallet_balance + ? WHERE id = ?").run(request.amount, request.driver_id);
      db.prepare("INSERT INTO transactions (id, driver_id, amount, type, description) VALUES (?, ?, ?, ?, ?)")
        .run(uuidv4(), request.driver_id, request.amount, 'credit', `Withdrawal request rejected: Refunded`);
    }

    res.json({ success: true });
  });

  // Driver: Request Withdrawal
  app.post("/api/driver/withdraw", (req, res) => {
    const { driverId, amount, bankDetails } = req.body;
    const driver = db.prepare("SELECT * FROM drivers WHERE id = ?").get(driverId) as any;
    
    if (!driver) return res.status(404).json({ error: "Driver not found" });
    if (driver.wallet_balance < amount) return res.status(400).json({ error: "Insufficient balance" });

    db.prepare("UPDATE drivers SET wallet_balance = wallet_balance - ? WHERE id = ?").run(amount, driverId);
    db.prepare("INSERT INTO withdrawal_requests (id, driver_id, amount, bank_details) VALUES (?, ?, ?, ?)")
      .run(uuidv4(), driverId, amount, bankDetails);
    
    db.prepare("INSERT INTO transactions (id, driver_id, amount, type, description) VALUES (?, ?, ?, ?, ?)")
      .run(uuidv4(), driverId, amount, 'debit', `Withdrawal request submitted${bankDetails ? ' (Bank: ' + bankDetails + ')' : ''}`);

    res.json({ success: true });
  });

  // Driver: Get withdrawal history
  app.get("/api/driver/:id/withdrawals", (req, res) => {
    const requests = db.prepare("SELECT * FROM withdrawal_requests WHERE driver_id = ? ORDER BY created_at DESC").all(req.params.id);
    res.json(requests);
  });

  // Driver: Get Completed Rides
  app.get("/api/driver/:id/completed-rides", (req, res) => {
    const rides = db.prepare("SELECT * FROM rides WHERE driver_id = ? AND status = 'completed' ORDER BY created_at DESC LIMIT 10").all(req.params.id);
    res.json(rides);
  });

  // Driver: Wallet & Transactions
  app.get("/api/driver/:id/wallet", (req, res) => {
    const driver = db.prepare("SELECT wallet_balance FROM drivers WHERE id = ?").get(req.params.id);
    const transactions = db.prepare("SELECT * FROM transactions WHERE driver_id = ? ORDER BY created_at DESC").all(req.params.id);
    res.json({ balance: (driver as any)?.wallet_balance || 0, transactions });
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

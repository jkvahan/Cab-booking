import { useState, useEffect, useRef } from 'react';
import { 
  Car, 
  MapPin, 
  Search, 
  User, 
  ShieldCheck, 
  Wallet, 
  Clock, 
  CheckCircle2, 
  Navigation,
  ArrowRight,
  LogOut,
  Plus,
  Settings,
  Users,
  CreditCard,
  X,
  KeyRound,
  History as HistoryIcon,
  BellRing,
  Bell,
  Send,
  Phone
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  collection, 
  doc, 
  setDoc, 
  getDoc, 
  getDocs, 
  updateDoc, 
  deleteDoc, 
  query, 
  where, 
  orderBy, 
  onSnapshot, 
  addDoc, 
  serverTimestamp,
  getDocFromServer,
  limit,
  arrayUnion
} from 'firebase/firestore';
import { 
  signInWithPopup, 
  GoogleAuthProvider, 
  onAuthStateChanged, 
  signOut,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword
} from 'firebase/auth';
import { db, auth } from './firebase';
import { estimateFare } from './services/geminiService';
import { calculateRealFare, VEHICLE_RATES } from './services/mapsService';
import MapComponent from './components/Map';

// --- Types ---
enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}
type View = 'user' | 'admin' | 'driver';
type RideStatus = 'pending' | 'accepted' | 'ongoing' | 'completed' | 'cancelled';

interface Ride {
  id: string;
  tracking_id: string;
  pickup_location: string;
  dropoff_location: string;
  status: RideStatus;
  fare: number;
  vehicle_type: string;
  driver_id?: string;
  user_id?: string;
  driver_name?: string;
  driver_phone?: string;
  vehicle_model?: string;
  plate_number?: string;
  created_at: string;
  start_otp?: string;
  end_otp?: string;
  eta?: number;
  user_phone?: string;
  user_name?: string;
  trip_type?: 'single' | 'round';
  distance?: number;
  pickup_date?: string;
  pickup_time?: string;
}

interface Notification {
  id: string;
  message: string;
  target: 'all_drivers' | 'all_users' | 'specific_driver';
  driver_id?: string;
  created_at: string;
  read_by: string[]; // List of user IDs who dismissed it
}

// --- Components ---

const Navbar = ({ activeView, setView, onLogout }: { activeView: View, setView: (v: View) => void, onLogout?: () => void }) => (
  <nav className="fixed top-0 left-0 right-0 bg-white/90 backdrop-blur-md border-b border-zinc-200 z-50">
    <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
      <div className="flex items-center gap-2 cursor-pointer" onClick={() => setView('user')}>
        <div className="bg-zinc-900 p-1.5 rounded-lg">
          <Car className="text-white w-4 h-4 sm:w-5 sm:h-5" />
        </div>
        <span className="font-bold text-lg sm:text-xl tracking-tight">CabGo</span>
      </div>
      <div className="flex items-center gap-2 sm:gap-4">
        {activeView === 'user' && (
          <>
            <button onClick={() => setView('driver')} className="text-xs sm:text-sm font-medium text-zinc-600 hover:text-zinc-900 bg-zinc-100 px-2 py-1 rounded-lg">Driver</button>
            <button onClick={() => setView('admin')} className="text-xs sm:text-sm font-medium text-zinc-600 hover:text-zinc-900 bg-zinc-100 px-2 py-1 rounded-lg">Admin</button>
          </>
        )}
        {onLogout && (
          <button onClick={onLogout} className="p-1.5 hover:bg-zinc-100 rounded-full transition-colors">
            <LogOut className="w-4 h-4 sm:w-5 sm:h-5 text-zinc-600" />
          </button>
        )}
      </div>
    </div>
  </nav>
);

export default function App() {
  // Handle Mobile Back Button
  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      if (event.state && event.state.view) {
        setView(event.state.view);
      } else {
        setView('user');
      }
    };

    window.addEventListener('popstate', handlePopState);
    
    // Initial state
    window.history.replaceState({ view: 'user' }, '', '');

    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const changeView = (newView: View) => {
    if (newView !== view) {
      window.history.pushState({ view: newView }, '', '');
      setView(newView);
      setTrackedRide(null);
      setTrackingId('');
    }
  };

  const handleLogout = () => {
    setUser(null);
    setTrackedRide(null);
    setTrackingId('');
    signOut(auth);
  };
  const getStatusLabel = (status: RideStatus) => {
    switch (status) {
      case 'pending': return 'Searching...';
      case 'accepted': return 'Accepted';
      case 'ongoing': return 'On the way';
      case 'completed': return 'Completed';
      case 'cancelled': return 'Cancelled';
      default: return status;
    }
  };

  const getStatusColor = (status: RideStatus) => {
    switch (status) {
      case 'pending': return 'bg-amber-100 text-amber-700';
      case 'accepted': return 'bg-blue-100 text-blue-700';
      case 'ongoing': return 'bg-emerald-600 text-white';
      case 'completed': return 'bg-emerald-100 text-emerald-700';
      case 'cancelled': return 'bg-rose-100 text-rose-700';
      default: return 'bg-zinc-100 text-zinc-700';
    }
  };
  const [user, setUser] = useState<any>(() => {
    const saved = localStorage.getItem('cabgo_user');
    return saved ? JSON.parse(saved) : null;
  });
  const [isAuthReady, setIsAuthReady] = useState(false);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        // If logged in via Firebase Auth, fetch profile from Firestore
        try {
          // Check users, drivers, admins collections
          const userDoc = await getDoc(doc(db, 'users', firebaseUser.uid));
          if (userDoc.exists()) {
            setUser({ ...userDoc.data(), id: firebaseUser.uid, role: 'user' });
          } else {
            const driverDoc = await getDoc(doc(db, 'drivers', firebaseUser.uid));
            if (driverDoc.exists()) {
              setUser({ ...driverDoc.data(), id: firebaseUser.uid, role: 'driver' });
            } else {
              const adminDoc = await getDoc(doc(db, 'admins', firebaseUser.uid));
              if (adminDoc.exists()) {
                setUser({ ...adminDoc.data(), id: firebaseUser.uid, role: 'admin' });
              }
            }
          }
        } catch (err) {
          console.error("Error fetching user profile:", err);
        }
      } else {
        // If not logged in via Firebase Auth, check localStorage for legacy/manual sessions
        // (Optional: migrate legacy users to Firebase Auth on first login)
      }
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const testConnection = async () => {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
      } catch (error) {
        if (error instanceof Error && error.message.includes('the client is offline')) {
          console.error("Please check your Firebase configuration. ");
        }
      }
    };
    testConnection();
  }, []);
  const [view, setView] = useState<View>(() => {
    const saved = localStorage.getItem('cabgo_view');
    return (saved as View) || 'user';
  });

  useEffect(() => {
    if (user) localStorage.setItem('cabgo_user', JSON.stringify(user));
    else localStorage.removeItem('cabgo_user');
  }, [user]);

  useEffect(() => {
    localStorage.setItem('cabgo_view', view);
  }, [view]);

  const [trackingId, setTrackingId] = useState('');
  const [trackedRide, setTrackedRide] = useState<Ride | null>(null);
  const [bookingData, setBookingData] = useState({ 
    pickup: '', 
    dropoff: '', 
    tripType: 'single' as 'single' | 'round',
    manualDistance: '',
    pickupDate: new Date().toISOString().split('T')[0],
    pickupTime: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  });
  const [isLiveLocationLoading, setIsLiveLocationLoading] = useState(false);
  const pickupRef = useRef<HTMLInputElement>(null);
  const dropoffRef = useRef<HTMLInputElement>(null);
  const [fareOptions, setFareOptions] = useState<any[]>([]);
  const [selectedOption, setSelectedOption] = useState<any>(null);
  const [isEstimating, setIsEstimating] = useState(false);
  const [estimatedDistance, setEstimatedDistance] = useState<number | null>(null);
  const [isBooking, setIsBooking] = useState(false);
  const [error, setError] = useState('');

  // User Auth States
  const [userAuthMode, setUserAuthMode] = useState<'login' | 'register'>('login');
  const [userLoginData, setUserLoginData] = useState({ phone: '', password: '', name: '' });
  const [myRides, setMyRides] = useState<Ride[]>([]);

  // Driver Auth States
  const [driverAuthMode, setDriverAuthMode] = useState<'login' | 'register'>('login');
  const [loginData, setLoginData] = useState({ username: '', phone: '', password: '', name: '' });

  // Forgot Password States
  const [forgotPasswordMode, setForgotPasswordMode] = useState(false);
  const [forgotPasswordData, setForgotPasswordData] = useState({ identifier: '', newPassword: '' });

  // Admin Data
  const [adminLoginStep, setAdminLoginStep] = useState<'credentials' | 'pin'>('credentials');
  const [tempAdminId, setTempAdminId] = useState<string | null>(null);
  const [adminPin, setAdminPin] = useState('');
  const [finalAmountInput, setFinalAmountInput] = useState('');
  const [adminRides, setAdminRides] = useState<Ride[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [activeNotification, setActiveNotification] = useState<Notification | null>(null);
  const [newNotification, setNewNotification] = useState({
    message: '',
    target: 'all_drivers' as Notification['target'],
    driver_id: ''
  });
  const [isSendingNotification, setIsSendingNotification] = useState(false);
  const [adminDrivers, setAdminDrivers] = useState<any[]>([]);
  const [adminUsers, setAdminUsers] = useState<any[]>([]);
  const [adminVehicles, setAdminVehicles] = useState<any[]>([]);
  const [otherAdmins, setOtherAdmins] = useState<any[]>([]);
  const [adminWithdrawals, setAdminWithdrawals] = useState<any[]>([]);
  const [selectedDriverTransactions, setSelectedDriverTransactions] = useState<{name: string, transactions: any[]} | null>(null);
  const [newAdmin, setNewAdmin] = useState({ username: '', password: '', pin: '', role: 'admin' as 'admin' | 'owner' });

  // Driver Data
  const [availableRides, setAvailableRides] = useState<Ride[]>([]);
  const [completedRides, setCompletedRides] = useState<Ride[]>([]);
  const [driverWallet, setDriverWallet] = useState({ balance: 0, transactions: [] });
  const [driverWithdrawals, setDriverWithdrawals] = useState<any[]>([]);
  const [otpInput, setOtpInput] = useState('');
  const [etaInput, setEtaInput] = useState('');
  const [acceptingRideId, setAcceptingRideId] = useState<string | null>(null);
  const [isActionLoading, setIsActionLoading] = useState(false);
  const [toast, setToast] = useState<{ message: string, type: 'success' | 'error' } | null>(null);
  const [isAudioUnlocked, setIsAudioUnlocked] = useState(false);
  const [pickupCoords, setPickupCoords] = useState<{ lat: number, lng: number } | null>(null);
  const [dropoffCoords, setDropoffCoords] = useState<{ lat: number, lng: number } | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    // Preload notification sound
    audioRef.current = new Audio('https://assets.mixkit.co/active_storage/sfx/1359/1359-preview.mp3');
    audioRef.current.loop = true;
  }, []);

  const stopRing = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
  };

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  useEffect(() => {
    // Load Google Maps Script
    const apiKey = (import.meta as any).env.VITE_GOOGLE_MAPS_API_KEY;
    
    // Global error handler for Google Maps authentication failures
    (window as any).gm_authFailure = () => {
      console.error("Google Maps authentication failed. Check your API key.");
      setToast({ message: "Google Maps authentication failed. Check your API key.", type: 'error' });
    };

    if (!apiKey || apiKey === 'undefined' || apiKey === '') {
      console.warn("Google Maps API Key is missing. Using Gemini AI fallback for distance calculations.");
      return;
    }

    const existingScript = document.querySelector('script[src*="maps.googleapis.com/maps/api/js"]');
    if (!window.google && !existingScript) {
      const script = document.createElement('script');
      script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places`;
      script.async = true;
      script.defer = true;
      script.onload = () => {
        initAutocomplete();
      };
      script.onerror = () => {
        console.error("Failed to load Google Maps script. Check your API key and internet connection.");
        setToast({ message: "Failed to load Google Maps. Please check your API key.", type: 'error' });
      };
      document.head.appendChild(script);
    } else if (window.google) {
      initAutocomplete();
    }
  }, []);

  // WebSocket Connection
  const unlockAudio = () => {
    if (audioRef.current) {
      audioRef.current.play().then(() => {
        audioRef.current?.pause();
        audioRef.current!.currentTime = 0;
        setIsAudioUnlocked(true);
        setError('');
        setToast({ message: "Sound Alerts Enabled!", type: 'success' });
      }).catch(e => {
        console.log('Audio unlock failed:', e);
        setError('Please click the button again to enable sound alerts.');
      });
    }
  };

  // Real-time listeners
  useEffect(() => {
    if (!user || !isAuthReady) return;

    let unsubscribeRides: () => void;
    let unsubscribeAvailable: () => void;
    let unsubscribeWithdrawals: () => void;
    let unsubscribeDrivers: () => void;
    let unsubscribeVehicles: () => void;
    let unsubscribeAllRides: () => void;
    let unsubscribeNotifications: () => void;

    // Notification Listener for all views
    let notifQuery;
    if (view === 'admin') {
      notifQuery = query(
        collection(db, 'notifications'),
        orderBy('created_at', 'desc'),
        limit(20)
      );
    } else if (view === 'driver') {
      notifQuery = query(
        collection(db, 'notifications'),
        where('target', 'in', ['all_drivers', 'specific_driver']),
        orderBy('created_at', 'desc'),
        limit(10)
      );
    } else {
      notifQuery = query(
        collection(db, 'notifications'),
        where('target', '==', 'all_users'),
        orderBy('created_at', 'desc'),
        limit(10)
      );
    }

    unsubscribeNotifications = onSnapshot(notifQuery, (snapshot) => {
      const notifs = snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id } as Notification));
      setNotifications(notifs);
      
      // Find latest unread notification for current user
      const latest = notifs.find(n => {
        const isRead = n.read_by?.includes(user.id);
        if (isRead) return false;

        // Extra client-side check for specific driver
        if (n.target === 'specific_driver' && n.driver_id !== user.id) return false;
        
        return true;
      });

      if (latest) {
        setActiveNotification(latest);
      }
    }, (err) => {
      // If query fails (e.g. specific_driver query needs index or permission issue)
      console.error("Notification query error:", err);
    });

    if (view === 'user') {
      const q = query(
        collection(db, 'rides'), 
        where('user_id', '==', user.id),
        orderBy('created_at', 'desc')
      );
      unsubscribeRides = onSnapshot(q, (snapshot) => {
        const rides = snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id } as Ride));
        setMyRides(rides);
        
        // Update tracked ride if it's in the snapshot
        if (trackedRide) {
          const updated = rides.find(r => r.id === trackedRide.id);
          if (updated) setTrackedRide(updated);
        }
      }, (err) => handleFirestoreError(err, OperationType.LIST, 'rides'));
    }

    if (view === 'driver') {
      const q = query(
        collection(db, 'rides'),
        where('status', 'in', ['pending', 'accepted', 'ongoing']),
        orderBy('created_at', 'desc')
      );
      unsubscribeAvailable = onSnapshot(q, (snapshot) => {
        const rides = snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id } as Ride));
        
        // Check for new pending rides to play sound
        snapshot.docChanges().forEach((change) => {
          if (change.type === "added") {
            const newRide = change.doc.data() as Ride;
            if (newRide.status === 'pending') {
              if (isAudioUnlocked && audioRef.current) {
                audioRef.current.play().catch(e => console.log('Audio play failed:', e));
                setTimeout(stopRing, 60000);
              }
              setToast({ message: "New Ride Request Available!", type: 'success' });
            }
          }
        });

        setAvailableRides(rides);
      }, (err) => handleFirestoreError(err, OperationType.LIST, 'rides'));
    }

    if (view === 'admin') {
      unsubscribeWithdrawals = onSnapshot(collection(db, 'withdrawal_requests'), (snapshot) => {
        const requests = snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id } as any));
        setAdminWithdrawals(requests);
      }, (err) => handleFirestoreError(err, OperationType.LIST, 'withdrawal_requests'));

      unsubscribeDrivers = onSnapshot(collection(db, 'drivers'), (snapshot) => {
        const drivers = snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id } as any));
        setAdminDrivers(drivers);
      }, (err) => handleFirestoreError(err, OperationType.LIST, 'drivers'));

      unsubscribeVehicles = onSnapshot(collection(db, 'vehicles'), (snapshot) => {
        const vehicles = snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id } as any));
        setAdminVehicles(vehicles);
      }, (err) => handleFirestoreError(err, OperationType.LIST, 'vehicles'));

      unsubscribeAllRides = onSnapshot(query(collection(db, 'rides'), orderBy('created_at', 'desc'), limit(100)), (snapshot) => {
        const rides = snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id } as Ride));
        setAdminRides(rides);
      }, (err) => handleFirestoreError(err, OperationType.LIST, 'rides'));
    }

    return () => {
      unsubscribeRides?.();
      unsubscribeAvailable?.();
      unsubscribeWithdrawals?.();
      unsubscribeDrivers?.();
      unsubscribeVehicles?.();
      unsubscribeAllRides?.();
      unsubscribeNotifications?.();
    };
  }, [view, user, isAuthReady]);

  const fetchUserRides = () => {};

  const handleUserLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const q = query(collection(db, 'users'), where('phone', '==', userLoginData.phone), where('password', '==', userLoginData.password));
      const snapshot = await getDocs(q);
      if (!snapshot.empty) {
        const userData = { ...snapshot.docs[0].data(), id: snapshot.docs[0].id, role: 'user' };
        setUser(userData);
        setError('');
      } else {
        setError('Invalid user credentials');
      }
    } catch (err: any) {
      setError(err.message || 'Login failed');
    }
  };

  const handleUserRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      // Check if user exists
      const q = query(collection(db, 'users'), where('phone', '==', userLoginData.phone));
      const snapshot = await getDocs(q);
      if (!snapshot.empty) {
        setError('User with this phone already exists');
        return;
      }

      const userData = {
        name: userLoginData.name,
        phone: userLoginData.phone,
        password: userLoginData.password,
        created_at: new Date().toISOString()
      };
      const docRef = await addDoc(collection(db, 'users'), userData);
      setUserAuthMode('login');
      setError('Registration successful! Please login.');
    } catch (err: any) {
      setError(err.message || 'Registration failed');
    }
  };

  const handleUserCancelRide = async (rideId: string) => {
    if (!confirm("Are you sure you want to cancel this ride?")) return;
    try {
      await updateDoc(doc(db, 'rides', rideId), { status: 'cancelled' });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `rides/${rideId}`);
    }
  };

  const fetchAdminData = () => {};
  const fetchOtherAdmins = () => {};

  const handleAddAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newAdmin.role === 'owner') {
      alert("Cannot create another owner!");
      return;
    }
    try {
      await addDoc(collection(db, 'admins'), {
        username: newAdmin.username,
        password: newAdmin.password,
        pin: newAdmin.pin,
        role: 'admin', // Force admin role
        created_at: new Date().toISOString()
      });
      setNewAdmin({ username: '', password: '', pin: '', role: 'admin' });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'admins');
    }
  };

  const handleRemoveAdmin = async (id: string) => {
    if (id === user.id) {
      alert("You cannot remove yourself!");
      return;
    }
    
    // Check if the admin to be removed is an owner
    try {
      const adminDoc = await getDoc(doc(db, 'admins', id));
      if (adminDoc.exists() && adminDoc.data().role === 'owner') {
        alert("Cannot remove the owner!");
        return;
      }
    } catch (e) {
      console.error("Error checking admin role:", e);
    }

    if (!confirm("Are you sure you want to remove this admin?")) return;
    try {
      await deleteDoc(doc(db, 'admins', id));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `admins/${id}`);
    }
  };

  const handleSendNotification = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newNotification.message) return;
    setIsSendingNotification(true);
    try {
      await addDoc(collection(db, 'notifications'), {
        ...newNotification,
        created_at: new Date().toISOString(),
        read_by: []
      });
      setNewNotification({ message: '', target: 'all_drivers', driver_id: '' });
      setToast({ message: 'Notification sent successfully!', type: 'success' });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'notifications');
    } finally {
      setIsSendingNotification(false);
    }
  };

  const dismissNotification = async (notificationId: string) => {
    if (!user) return;
    try {
      const notifRef = doc(db, 'notifications', notificationId);
      await updateDoc(notifRef, {
        read_by: arrayUnion(user.id)
      });
      setActiveNotification(null);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `notifications/${notificationId}`);
    }
  };

  const handleDeleteUser = async (id: string) => {
    if (!confirm("Are you sure you want to delete this user? This action cannot be undone.")) return;
    try {
      await deleteDoc(doc(db, 'users', id));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `users/${id}`);
    }
  };

  const handleDeleteDriver = async (id: string) => {
    if (!confirm("Are you sure you want to delete this driver? All associated vehicle data will also be removed.")) return;
    try {
      await deleteDoc(doc(db, 'drivers', id));
      // Also delete vehicle
      const q = query(collection(db, 'vehicles'), where('driver_id', '==', id));
      const snapshot = await getDocs(q);
      snapshot.forEach(async (vDoc) => {
        await deleteDoc(doc(db, 'vehicles', vDoc.id));
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `drivers/${id}`);
    }
  };

  const handleWalletAdjust = async (driverId: string, amount: number, type: 'credit' | 'debit') => {
    const reason = prompt(`Enter reason for ${type}:`);
    if (reason === null) return;

    try {
      const driverRef = doc(db, 'drivers', driverId);
      const driverSnap = await getDoc(driverRef);
      if (driverSnap.exists()) {
        const currentBalance = driverSnap.data().wallet_balance || 0;
        const newBalance = type === 'credit' ? currentBalance + amount : currentBalance - amount;
        await updateDoc(driverRef, { wallet_balance: newBalance });
        
        await addDoc(collection(db, 'transactions'), {
          driver_id: driverId,
          amount,
          type,
          reason,
          created_at: new Date().toISOString()
        });
        setToast({ message: `Wallet ${type === 'credit' ? 'credited' : 'debited'} successfully`, type: 'success' });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `drivers/${driverId}`);
    }
  };

  const fetchDriverTransactions = async (driverId: string, driverName: string) => {
    try {
      const q = query(collection(db, 'transactions'), where('driver_id', '==', driverId), orderBy('created_at', 'desc'));
      const snapshot = await getDocs(q);
      const transactions = snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id }));
      setSelectedDriverTransactions({ name: driverName, transactions });
    } catch (err) {
      handleFirestoreError(err, OperationType.LIST, 'transactions');
    }
  };

  const handleWithdrawalAction = async (id: string, action: 'approved' | 'rejected') => {
    try {
      const withdrawalRef = doc(db, 'withdrawal_requests', id);
      const withdrawalSnap = await getDoc(withdrawalRef);
      if (withdrawalSnap.exists()) {
        const withdrawalData = withdrawalSnap.data();
        if (action === 'approved') {
          const driverRef = doc(db, 'drivers', withdrawalData.driver_id);
          const driverSnap = await getDoc(driverRef);
          if (driverSnap.exists()) {
            const currentBalance = driverSnap.data().wallet_balance || 0;
            if (currentBalance < withdrawalData.amount) {
              return alert('Insufficient driver balance');
            }
            await updateDoc(driverRef, { wallet_balance: currentBalance - withdrawalData.amount });
            await addDoc(collection(db, 'transactions'), {
              driver_id: withdrawalData.driver_id,
              amount: withdrawalData.amount,
              type: 'debit',
              reason: `Withdrawal approved: ${id}`,
              created_at: new Date().toISOString()
            });
          }
        }
        await updateDoc(withdrawalRef, { status: action, processed_at: new Date().toISOString() });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `withdrawal_requests/${id}`);
    }
  };

  const handleRequestWithdrawal = async () => {
    const amountStr = prompt('Enter amount to withdraw:');
    if (!amountStr) return;
    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount <= 0) return alert('Invalid amount');

    const bankDetails = prompt('Enter Bank Details (Account No, IFSC, etc.):');
    if (!bankDetails) return alert('Bank details are required');

    try {
      await addDoc(collection(db, 'withdrawal_requests'), {
        driver_id: user.id,
        driver_name: user.name,
        amount,
        bank_details: bankDetails,
        status: 'pending',
        created_at: new Date().toISOString()
      });
      alert('Withdrawal request submitted!');
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'withdrawal_requests');
    }
  };

  const fetchDriverData = () => {};

  const handleAdminLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    
    try {
      if (adminLoginStep === 'credentials') {
        const q = query(collection(db, 'admins'), where('username', '==', loginData.username), where('password', '==', loginData.password));
        const snapshot = await getDocs(q);
        if (!snapshot.empty) {
          setTempAdminId(snapshot.docs[0].id);
          setAdminLoginStep('pin');
        } else {
          setError('Invalid admin credentials');
        }
      } else {
        if (!tempAdminId) return;
        const adminDoc = await getDoc(doc(db, 'admins', tempAdminId));
        if (adminDoc.exists() && adminDoc.data().pin === adminPin) {
          const adminData = { ...adminDoc.data(), id: adminDoc.id };
          setUser(adminData);
          setAdminLoginStep('credentials');
          setTempAdminId(null);
          setAdminPin('');
          setError('');
        } else {
          setError('Invalid PIN');
        }
      }
    } catch (err: any) {
      setError(err.message || 'Login failed');
    }
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      let collectionName = '';
      let identifierField = '';
      
      if (view === 'user') {
        collectionName = 'users';
        identifierField = 'phone';
      } else if (view === 'driver') {
        collectionName = 'drivers';
        identifierField = 'phone';
      } else if (view === 'admin') {
        collectionName = 'admins';
        identifierField = 'username';
      }

      const q = query(collection(db, collectionName), where(identifierField, '==', forgotPasswordData.identifier));
      const snapshot = await getDocs(q);
      
      if (!snapshot.empty) {
        const userDoc = snapshot.docs[0];
        await updateDoc(doc(db, collectionName, userDoc.id), { password: forgotPasswordData.newPassword });
        alert('Password updated successfully! Please login with your new password.');
        setForgotPasswordMode(false);
        setError('');
      } else {
        setError('Account not found');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to update password');
    }
  };

  const handleDriverLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const q = query(collection(db, 'drivers'), where('phone', '==', loginData.phone), where('password', '==', loginData.password));
      const snapshot = await getDocs(q);
      if (!snapshot.empty) {
        const driverData = { ...snapshot.docs[0].data(), id: snapshot.docs[0].id, role: 'driver' };
        setUser(driverData);
        setError('');
      } else {
        setError('Invalid driver credentials');
      }
    } catch (err: any) {
      setError(err.message || 'Login failed');
    }
  };

  const handleDriverRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const q = query(collection(db, 'drivers'), where('phone', '==', loginData.phone));
      const snapshot = await getDocs(q);
      if (!snapshot.empty) {
        setError('Driver with this phone already exists');
        return;
      }

      const driverData = {
        name: loginData.name,
        phone: loginData.phone,
        password: loginData.password,
        wallet_balance: 0,
        status: 'pending',
        created_at: new Date().toISOString()
      };
      const docRef = await addDoc(collection(db, 'drivers'), driverData);
      
      setDriverAuthMode('login');
      setError('Registration successful! Your account is pending verification by admin.');
    } catch (err: any) {
      setError(err.message || 'Registration failed');
    }
  };

  const initAutocomplete = () => {
    if (!window.google || !pickupRef.current || !dropoffRef.current) return;

    const pickupAutocomplete = new google.maps.places.Autocomplete(pickupRef.current);
    pickupAutocomplete.addListener('place_changed', () => {
      const place = pickupAutocomplete.getPlace();
      if (place.formatted_address) {
        setBookingData(prev => ({ ...prev, pickup: place.formatted_address! }));
      }
    });

    const dropoffAutocomplete = new google.maps.places.Autocomplete(dropoffRef.current);
    dropoffAutocomplete.addListener('place_changed', () => {
      const place = dropoffAutocomplete.getPlace();
      if (place.formatted_address) {
        setBookingData(prev => ({ ...prev, dropoff: place.formatted_address! }));
      }
    });
  };

  useEffect(() => {
    if (view === 'user' && user && !bookingData.pickup) {
      const checkGoogle = setInterval(() => {
        if (window.google) {
          clearInterval(checkGoogle);
          getCurrentLocation();
        }
      }, 500);
      return () => clearInterval(checkGoogle);
    }
  }, [view, user]);

  const getCurrentLocation = () => {
    if (navigator.geolocation) {
      setIsLiveLocationLoading(true);
      navigator.geolocation.getCurrentPosition((position) => {
        if (!window.google) {
          setIsLiveLocationLoading(false);
          return;
        }
        const geocoder = new google.maps.Geocoder();
        const latlng = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        };
        geocoder.geocode({ location: latlng }, (results, status) => {
          setIsLiveLocationLoading(false);
          if (status === "OK" && results?.[0]) {
            setBookingData(prev => ({ ...prev, pickup: results[0].formatted_address }));
            setPickupCoords(latlng);
          }
        });
      }, (error) => {
        console.error("Geolocation error:", error);
        setIsLiveLocationLoading(false);
      });
    }
  };

  const geocodeLocation = async (address: string, type: 'pickup' | 'dropoff') => {
    if (!address) return;
    
    // Try Google first if available
    if (window.google) {
      const geocoder = new google.maps.Geocoder();
      geocoder.geocode({ address }, (results, status) => {
        if (status === 'OK' && results?.[0]) {
          const loc = results[0].geometry.location;
          const coords = { lat: loc.lat(), lng: loc.lng() };
          if (type === 'pickup') setPickupCoords(coords);
          else setDropoffCoords(coords);
        }
      });
      return;
    }

    // Fallback to Nominatim
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}&limit=1`);
      const data = await res.json();
      if (data && data[0]) {
        const coords = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
        if (type === 'pickup') setPickupCoords(coords);
        else setDropoffCoords(coords);
      }
    } catch (e) {
      console.error("Geocoding error:", e);
    }
  };

  const handleFindRides = async () => {
    if (!bookingData.pickup || !bookingData.dropoff || !bookingData.manualDistance) {
      setError('Please fill all fields including Total KM');
      return;
    }
    setIsEstimating(true);
    setError('');
    
    // Geocode both locations for the map
    geocodeLocation(bookingData.pickup, 'pickup');
    geocodeLocation(bookingData.dropoff, 'dropoff');

    try {
      const manualDist = bookingData.manualDistance ? parseFloat(bookingData.manualDistance) : undefined;
      const data = await calculateRealFare(bookingData.pickup, bookingData.dropoff, bookingData.tripType, manualDist);
      setFareOptions(data.options || []);
      setEstimatedDistance(data.distance || null);
      setSelectedOption(data.options?.[0] || null);
    } catch (err: any) {
      console.error("Estimation error:", err);
      setError(err.message || 'Failed to estimate fare. Please try again.');
    } finally {
      setIsEstimating(false);
    }
  };

  const handleBookRide = async () => {
    if (!selectedOption || !user) return;
    setIsBooking(true);
    try {
      const rideData = {
        user_id: user.id,
        user_name: user.name,
        user_phone: user.phone,
        pickup_location: bookingData.pickup,
        dropoff_location: bookingData.dropoff,
        distance: estimatedDistance,
        fare: selectedOption.fare,
        vehicle_type: selectedOption.type,
        trip_type: bookingData.tripType,
        pickup_date: bookingData.pickupDate,
        pickup_time: bookingData.pickupTime,
        status: 'pending' as RideStatus,
        tracking_id: `CB${Math.floor(10000 + Math.random() * 90000)}`,
        created_at: new Date().toISOString()
      };
      const docRef = await addDoc(collection(db, 'rides'), rideData);
      setFareOptions([]);
      setBookingData({ 
        pickup: '', 
        dropoff: '', 
        tripType: 'single', 
        manualDistance: '',
        pickupDate: new Date().toISOString().split('T')[0],
        pickupTime: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
      });
      setTrackedRide(null);
      setTrackingId('');
      setError('');
      setToast({ message: `Ride booked successfully! Tracking ID: ${rideData.tracking_id}`, type: 'success' });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'rides');
      setError('Booking failed. Please try again.');
    } finally {
      setIsBooking(false);
    }
  };

  const handleTrackRide = async () => {
    if (!trackingId) return;
    try {
      const q = query(collection(db, 'rides'), where('tracking_id', '==', trackingId));
      const snapshot = await getDocs(q);
      if (!snapshot.empty) {
        setTrackedRide({ ...snapshot.docs[0].data(), id: snapshot.docs[0].id } as Ride);
      } else {
        setError('Ride not found');
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, `rides?tracking_id=${trackingId}`);
    }
  };

  const handleAcceptRide = async (rideId: string) => {
    if (!etaInput) {
      setAcceptingRideId(rideId);
      return;
    }
    setIsActionLoading(true);
    stopRing();
    try {
      const rideRef = doc(db, 'rides', rideId);
      const rideSnap = await getDoc(rideRef);
      if (rideSnap.exists() && rideSnap.data().status === 'pending') {
        const startOtp = Math.floor(1000 + Math.random() * 9000).toString();
        const endOtp = Math.floor(1000 + Math.random() * 9000).toString();
        await updateDoc(rideRef, {
          driver_id: user.id,
          status: 'accepted',
          eta: parseInt(etaInput),
          start_otp: startOtp,
          end_otp: endOtp,
          accepted_at: new Date().toISOString()
        });
        setAcceptingRideId(null);
        setEtaInput('');
        setToast({ message: "Ride Accepted!", type: 'success' });
      } else {
        setError('Ride is no longer available');
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `rides/${rideId}`);
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleStartRide = async (rideId: string) => {
    if (!otpInput) return;
    setIsActionLoading(true);
    const trimmedOtp = otpInput.trim();
    try {
      const rideRef = doc(db, 'rides', rideId);
      const rideSnap = await getDoc(rideRef);
      if (rideSnap.exists() && rideSnap.data().start_otp === trimmedOtp) {
        await updateDoc(rideRef, {
          status: 'ongoing',
          started_at: new Date().toISOString()
        });
        setOtpInput('');
        setToast({ message: 'Ride started successfully!', type: 'success' });
      } else {
        setToast({ message: 'Invalid OTP', type: 'error' });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `rides/${rideId}`);
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleCompleteRide = async (rideId: string) => {
    if (!otpInput) {
      setToast({ message: 'Enter End OTP', type: 'error' });
      return;
    }
    setIsActionLoading(true);
    const trimmedOtp = otpInput.trim();
    try {
      const rideRef = doc(db, 'rides', rideId);
      const rideSnap = await getDoc(rideRef);
      if (rideSnap.exists() && rideSnap.data().end_otp === trimmedOtp) {
        const rideData = rideSnap.data();
        await updateDoc(rideRef, {
          status: 'completed',
          completed_at: new Date().toISOString()
        });

        // Update driver wallet
        const driverRef = doc(db, 'drivers', user.id);
        const driverSnap = await getDoc(driverRef);
        if (driverSnap.exists()) {
          const newBalance = (driverSnap.data().wallet_balance || 0) + (rideData.fare || 0);
          await updateDoc(driverRef, { wallet_balance: newBalance });
          
          // Add transaction
          await addDoc(collection(db, 'transactions'), {
            driver_id: user.id,
            amount: rideData.fare,
            type: 'credit',
            reason: `Ride completed: ${rideId}`,
            created_at: new Date().toISOString()
          });
        }

        setOtpInput('');
        setToast({ message: 'Ride completed successfully!', type: 'success' });
      } else {
        setToast({ message: 'Invalid OTP', type: 'error' });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `rides/${rideId}`);
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleCancelRide = async (rideId: string) => {
    if (!confirm("Cancelling after acceptance will result in a ₹50 fine. Continue?")) return;
    try {
      const rideRef = doc(db, 'rides', rideId);
      await updateDoc(rideRef, {
        status: 'pending',
        driver_id: null,
        accepted_at: null,
        eta: null
      });

      // Fine driver
      const driverRef = doc(db, 'drivers', user.id);
      const driverSnap = await getDoc(driverRef);
      if (driverSnap.exists()) {
        const newBalance = (driverSnap.data().wallet_balance || 0) - 50;
        await updateDoc(driverRef, { wallet_balance: newBalance });
        
        // Add transaction
        await addDoc(collection(db, 'transactions'), {
          driver_id: user.id,
          amount: 50,
          type: 'debit',
          reason: `Fine for cancelling accepted ride: ${rideId}`,
          created_at: new Date().toISOString()
        });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `rides/${rideId}`);
    }
  };

  const toggleDriverStatus = async (driverId: string, currentStatus: string) => {
    const newStatus = currentStatus === 'active' ? 'inactive' : 'active';
    try {
      await updateDoc(doc(db, 'drivers', driverId), { status: newStatus });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `drivers/${driverId}`);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50 font-sans text-zinc-900">
      {/* Toast Notification */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 50 }}
            className={`fixed bottom-8 left-1/2 -translate-x-1/2 px-6 py-3 rounded-full shadow-2xl z-[100] font-bold text-white flex items-center gap-2 ${
              toast.type === 'success' ? 'bg-emerald-600' : 'bg-rose-600'
            }`}
          >
            {toast.type === 'success' ? <CheckCircle2 className="w-5 h-5" /> : <X className="w-5 h-5" />}
            {toast.message}
            <button onClick={() => setToast(null)} className="ml-2 opacity-50 hover:opacity-100">
              <X className="w-4 h-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <Navbar activeView={view} setView={changeView} onLogout={user ? handleLogout : undefined} />

      <main className="pt-20 pb-12 px-3 sm:px-4 max-w-4xl mx-auto">
        <AnimatePresence mode="wait">
          {/* USER VIEW */}
          {view === 'user' && (
            <motion.div
              key="user"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-8"
            >
              {user && error && (
                <div className="p-3 bg-rose-50 text-rose-600 text-sm rounded-xl border border-rose-100">
                  {error}
                  <button onClick={() => setError('')} className="float-right"><X className="w-4 h-4" /></button>
                </div>
              )}

              {!user ? (
                <div className="max-w-md mx-auto bg-white p-8 rounded-2xl shadow-sm border border-zinc-200">
                  <h2 className="text-2xl font-bold mb-6 flex items-center gap-2">
                    {forgotPasswordMode ? <KeyRound className="w-6 h-6" /> : <User className="w-6 h-6" />} 
                    {forgotPasswordMode ? 'Reset Password' : (userAuthMode === 'login' ? 'User Login' : 'User Registration')}
                  </h2>
                  {error && (
                    <div className="mb-4 p-3 bg-rose-50 text-rose-600 text-sm rounded-xl border border-rose-100">
                      {error}
                      <button onClick={() => setError('')} className="float-right"><X className="w-4 h-4" /></button>
                    </div>
                  )}
                  
                  {forgotPasswordMode ? (
                    <form onSubmit={handleForgotPassword} className="space-y-4">
                      <input
                        type="tel"
                        placeholder="Registered Phone Number"
                        required
                        className="w-full px-4 py-3 bg-zinc-50 border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900"
                        value={forgotPasswordData.identifier}
                        onChange={e => setForgotPasswordData({ ...forgotPasswordData, identifier: e.target.value })}
                      />
                      <input
                        type="password"
                        placeholder="New Password"
                        required
                        className="w-full px-4 py-3 bg-zinc-50 border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900"
                        value={forgotPasswordData.newPassword}
                        onChange={e => setForgotPasswordData({ ...forgotPasswordData, newPassword: e.target.value })}
                      />
                      <button className="w-full bg-zinc-900 text-white py-3 rounded-xl font-bold hover:bg-zinc-800 transition-all">
                        Update Password
                      </button>
                      <button 
                        type="button"
                        onClick={() => setForgotPasswordMode(false)}
                        className="w-full text-sm font-medium text-zinc-500 hover:text-zinc-900"
                      >
                        Back to Login
                      </button>
                    </form>
                  ) : (
                    <>
                      <form onSubmit={userAuthMode === 'login' ? handleUserLogin : handleUserRegister} className="space-y-4">
                        {userAuthMode === 'register' && (
                          <input
                            type="text"
                            placeholder="Full Name"
                            required
                            className="w-full px-4 py-3 bg-zinc-50 border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900"
                            value={userLoginData.name}
                            onChange={e => setUserLoginData({ ...userLoginData, name: e.target.value })}
                          />
                        )}
                        <input
                          type="tel"
                          placeholder="Phone Number"
                          required
                          className="w-full px-4 py-3 bg-zinc-50 border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900"
                          value={userLoginData.phone}
                          onChange={e => setUserLoginData({ ...userLoginData, phone: e.target.value })}
                        />
                        <input
                          type="password"
                          placeholder="Password"
                          required
                          className="w-full px-4 py-3 bg-zinc-50 border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900"
                          value={userLoginData.password}
                          onChange={e => setUserLoginData({ ...userLoginData, password: e.target.value })}
                        />
                        {userAuthMode === 'login' && (
                          <div className="text-right">
                            <button 
                              type="button"
                              onClick={() => setForgotPasswordMode(true)}
                              className="text-xs font-medium text-zinc-500 hover:text-zinc-900"
                            >
                              Forgot Password?
                            </button>
                          </div>
                        )}
                        <button className="w-full bg-zinc-900 text-white py-3 rounded-xl font-bold hover:bg-zinc-800 transition-all">
                          {userAuthMode === 'login' ? 'Login' : 'Register'}
                        </button>
                      </form>
                      <div className="mt-6 text-center">
                        <button 
                          onClick={() => {
                            setUserAuthMode(userAuthMode === 'login' ? 'register' : 'login');
                            setError('');
                          }}
                          className="text-sm font-medium text-zinc-500 hover:text-zinc-900"
                        >
                          {userAuthMode === 'login' ? "Don't have an account? Register" : "Already have an account? Login"}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <>
                  <div className="text-center space-y-2">
                    <h1 className="text-4xl font-bold tracking-tight">Welcome, {user.name}!</h1>
                    <p className="text-zinc-500">Where would you like to go today?</p>
                  </div>

                  <div className="bg-white p-6 rounded-2xl shadow-sm border border-zinc-200 space-y-6">
                    {/* Trip Type Toggle */}
                    <div className="flex p-1 bg-zinc-100 rounded-xl">
                      <button
                        onClick={() => setBookingData({ ...bookingData, tripType: 'single' })}
                        className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all ${
                          bookingData.tripType === 'single' ? 'bg-white shadow-sm text-zinc-900' : 'text-zinc-500'
                        }`}
                      >
                        Single Trip
                      </button>
                      <button
                        onClick={() => setBookingData({ ...bookingData, tripType: 'round' })}
                        className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all ${
                          bookingData.tripType === 'round' ? 'bg-white shadow-sm text-zinc-900' : 'text-zinc-500'
                        }`}
                      >
                        Round Trip
                      </button>
                    </div>

                    <div className="space-y-4">
                      <div className="hidden">
                        <MapComponent pickup={pickupCoords} dropoff={dropoffCoords} />
                      </div>
                      
                      <div className="relative">
                        <MapPin className="absolute left-3 top-3 w-5 h-5 text-emerald-500" />
                        <input
                          ref={pickupRef}
                          type="text"
                          placeholder="Pickup Location"
                          className="w-full pl-10 pr-12 py-3 bg-zinc-50 border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900 transition-all"
                          value={bookingData.pickup}
                          onChange={e => {
                            setBookingData({ ...bookingData, pickup: e.target.value });
                            setFareOptions([]);
                          }}
                          onBlur={() => geocodeLocation(bookingData.pickup, 'pickup')}
                        />
                        <button 
                          onClick={getCurrentLocation}
                          disabled={isLiveLocationLoading}
                          className={`absolute right-3 top-3 transition-colors ${isLiveLocationLoading ? 'text-zinc-400 animate-pulse' : 'text-emerald-500 hover:text-emerald-600'}`}
                          title="Use Current Location"
                        >
                          <Navigation className="w-5 h-5" />
                        </button>
                      </div>
                      <div className="relative">
                        <Navigation className="absolute left-3 top-3 w-5 h-5 text-zinc-400" />
                        <input
                          ref={dropoffRef}
                          type="text"
                          placeholder="Dropoff Location"
                          className="w-full pl-10 pr-4 py-3 bg-zinc-50 border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900 transition-all"
                          value={bookingData.dropoff}
                          onChange={e => {
                            setBookingData({ ...bookingData, dropoff: e.target.value });
                            setFareOptions([]);
                          }}
                          onBlur={() => geocodeLocation(bookingData.dropoff, 'dropoff')}
                        />
                      </div>

                      <div className="relative">
                        <div className="absolute left-3 top-3 w-5 h-5 flex items-center justify-center text-zinc-400 font-bold text-xs">KM</div>
                        <input
                          type="number"
                          placeholder="Total KM (Required)"
                          className="w-full pl-10 pr-4 py-3 bg-zinc-50 border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900 transition-all"
                          value={bookingData.manualDistance}
                          required
                          onChange={e => {
                            setBookingData({ ...bookingData, manualDistance: e.target.value });
                            setFareOptions([]);
                          }}
                        />
                        <p className="text-[10px] text-zinc-400 mt-1 ml-1">Enter KM manually or leave blank for auto-calculation</p>
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div className="relative">
                          <Clock className="absolute left-3 top-3 w-4 h-4 text-zinc-400" />
                          <input
                            type="date"
                            className="w-full pl-9 pr-3 py-3 bg-zinc-50 border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900 transition-all text-sm"
                            value={bookingData.pickupDate}
                            onChange={e => setBookingData({ ...bookingData, pickupDate: e.target.value })}
                          />
                        </div>
                        <div className="relative">
                          <Clock className="absolute left-3 top-3 w-4 h-4 text-zinc-400" />
                          <input
                            type="time"
                            className="w-full pl-9 pr-3 py-3 bg-zinc-50 border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900 transition-all text-sm"
                            value={bookingData.pickupTime}
                            onChange={e => setBookingData({ ...bookingData, pickupTime: e.target.value })}
                          />
                        </div>
                      </div>
                    </div>

                    {fareOptions.length === 0 ? (
                      <button
                        onClick={handleFindRides}
                        disabled={isEstimating || !bookingData.pickup || !bookingData.dropoff}
                        className="w-full bg-zinc-900 text-white py-4 rounded-xl font-bold hover:bg-zinc-800 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                      >
                        {isEstimating ? 'Calculating Distance...' : 'Find Rides'}
                        <Search className="w-5 h-5" />
                      </button>
                    ) : (
                      <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
                        {estimatedDistance && (
                          <div className="flex items-center justify-between px-3 py-2 text-sm bg-zinc-50 rounded-lg border border-zinc-100">
                            <div className="flex items-center gap-2 text-zinc-500">
                              <Navigation className="w-4 h-4" />
                              <span>Distance: <span className="text-zinc-900 font-bold">{estimatedDistance} km</span></span>
                            </div>
                            <div className="text-zinc-500">
                              Trip: <span className="text-zinc-900 font-bold capitalize">{bookingData.tripType}</span>
                            </div>
                          </div>
                        )}
                        <div className="grid grid-cols-1 gap-3">
                          {fareOptions.map(option => (
                            <button
                              key={option.type}
                              onClick={() => setSelectedOption(option)}
                              className={`flex items-center justify-between p-4 rounded-xl border-2 transition-all ${
                                selectedOption?.type === option.type 
                                ? 'border-zinc-900 bg-zinc-50' 
                                : 'border-zinc-100 hover:border-zinc-200'
                              }`}
                            >
                              <div className="flex items-center gap-3">
                                <div className="p-2 bg-zinc-100 rounded-lg">
                                  <Car className="w-6 h-6" />
                                </div>
                                <div className="text-left">
                                  <div className="flex items-center gap-2">
                                    <p className="font-bold">{option.type}</p>
                                    <span className="text-[10px] px-1.5 py-0.5 bg-zinc-200 rounded text-zinc-600 font-medium">
                                      {VEHICLE_RATES[option.type as keyof typeof VEHICLE_RATES]?.description}
                                    </span>
                                  </div>
                                  <p className="text-xs text-zinc-500">Available • 2-5 min away</p>
                                </div>
                              </div>
                              <div className="text-right">
                                <p className="text-lg font-black">₹{option.fare}</p>
                                <p className="text-[10px] text-zinc-400">Incl. taxes</p>
                              </div>
                            </button>
                          ))}
                        </div>
                        <button
                          onClick={handleBookRide}
                          disabled={isBooking}
                          className="w-full bg-emerald-600 text-white py-4 rounded-xl font-bold hover:bg-emerald-700 transition-all flex items-center justify-center gap-2"
                        >
                          {isBooking ? 'Booking...' : `Confirm ${selectedOption?.type}`}
                          <CheckCircle2 className="w-5 h-5" />
                        </button>
                      </div>
                    )}
                  </div>

                  {myRides.length > 0 && (
                    <div className="space-y-4">
                      <h2 className="text-xl font-bold flex items-center gap-2">
                        <Clock className="w-5 h-5" /> Your Booking History
                      </h2>
                      <div className="grid grid-cols-1 gap-4">
                        {myRides.map(ride => (
                          <div key={ride.id} className="bg-white p-6 rounded-2xl border border-zinc-200 shadow-sm space-y-4">
                            <div className="flex justify-between items-start">
                              <div className="space-y-1">
                                <p className="text-xs font-bold text-zinc-400 uppercase">Tracking ID: {ride.tracking_id}</p>
                                <p className="font-bold">{ride.pickup_location} → {ride.dropoff_location}</p>
                                {ride.driver_name && (
                                  <div className="mt-2 p-2 bg-zinc-50 rounded-lg border border-zinc-100 flex items-center gap-2">
                                    <div className="w-8 h-8 bg-zinc-200 rounded-full flex items-center justify-center">
                                      <User className="w-4 h-4 text-zinc-500" />
                                    </div>
                                    <div>
                                      <p className="text-sm font-bold">{ride.driver_name}</p>
                                      <p className="text-xs text-zinc-500">{ride.driver_phone} • {ride.vehicle_model}</p>
                                    </div>
                                  </div>
                                )}
                              </div>
                              <div className={`px-3 py-1 rounded-full text-xs font-bold uppercase ${getStatusColor(ride.status)}`}>
                                {getStatusLabel(ride.status)}
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              {ride.trip_type === 'round' ? (
                                <span className="px-2 py-1 rounded text-[10px] font-bold uppercase bg-indigo-100 text-indigo-700">Round Trip</span>
                              ) : (
                                <span className="px-2 py-1 rounded text-[10px] font-bold uppercase bg-zinc-100 text-zinc-700">Single Trip</span>
                              )}
                              {ride.distance && (
                                <span className="text-[10px] font-bold text-zinc-400 uppercase">{ride.distance} KM</span>
                              )}
                              {ride.pickup_date && (
                                <span className="text-[10px] font-bold text-emerald-600 uppercase flex items-center gap-1">
                                  <Clock className="w-3 h-3" /> {ride.pickup_date} {ride.pickup_time}
                                </span>
                              )}
                            </div>
                            {ride.status === 'accepted' && (
                              <div className="bg-emerald-50 border border-emerald-100 p-3 rounded-xl">
                                <p className="text-xs font-bold text-emerald-600 uppercase">Driver is arriving</p>
                                <p className="text-sm font-bold text-emerald-700">ETA: {ride.eta || 'Calculating...'} mins</p>
                              </div>
                            )}
                            {(ride.status === 'pending' || ride.status === 'accepted') && (
                              <button
                                onClick={() => handleUserCancelRide(ride.id)}
                                className="text-rose-600 text-sm font-bold hover:underline"
                              >
                                Cancel Ride
                              </button>
                            )}
                            {ride.status !== 'cancelled' && ride.status !== 'completed' && (
                              <div className="grid grid-cols-2 gap-4 pt-2">
                                <div className="bg-zinc-50 p-3 rounded-lg border border-zinc-100">
                                  <p className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Start OTP</p>
                                  <p className="text-lg font-mono font-bold text-zinc-900">{ride.start_otp || '----'}</p>
                                </div>
                                <div className="bg-zinc-50 p-3 rounded-lg border border-zinc-100">
                                  <p className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">End OTP</p>
                                  <p className="text-lg font-mono font-bold text-zinc-900">{ride.end_otp || '----'}</p>
                                </div>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}

              <div className="bg-zinc-900 text-white p-6 rounded-2xl shadow-lg space-y-4 mt-8">
                <h2 className="text-lg font-bold flex items-center gap-2">
                  <Search className="w-5 h-5" /> Track Any Ride
                </h2>
                <div className="flex flex-col gap-3">
                  <input
                    type="text"
                    placeholder="Enter Tracking ID (e.g. ABC123XY)"
                    className="w-full bg-white/10 border border-white/20 rounded-xl px-4 py-4 focus:outline-none focus:ring-2 focus:ring-white/50 text-lg placeholder:text-white/30"
                    value={trackingId}
                    onChange={e => setTrackingId(e.target.value)}
                  />
                  <button
                    onClick={handleTrackRide}
                    className="w-full bg-white text-zinc-900 py-4 rounded-xl font-bold hover:bg-zinc-100 transition-all flex items-center justify-center gap-2"
                  >
                    <Search className="w-5 h-5" />
                    Track Ride
                  </button>
                </div>
              </div>

              {trackedRide && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="bg-white p-6 rounded-2xl border border-zinc-200 shadow-sm space-y-6"
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <span className="text-xs font-bold uppercase tracking-widest text-zinc-400">Tracking ID</span>
                      <p className="text-2xl font-mono font-bold">{trackedRide.tracking_id}</p>
                      {trackedRide.pickup_date && (
                        <p className="text-xs font-bold text-emerald-600 uppercase mt-1 flex items-center gap-1">
                          <Clock className="w-3 h-3" /> Pickup: {trackedRide.pickup_date} {trackedRide.pickup_time}
                        </p>
                      )}
                    </div>
                    <div className={`px-3 py-1 rounded-full text-xs font-bold uppercase ${getStatusColor(trackedRide.status)}`}>
                      {getStatusLabel(trackedRide.status)}
                    </div>
                  </div>

                  {trackedRide.status === 'accepted' && trackedRide.eta && (
                    <div className="bg-blue-50 border border-blue-100 p-4 rounded-xl flex items-center gap-3">
                      <Clock className="w-5 h-5 text-blue-600" />
                      <div>
                        <p className="text-xs font-bold text-blue-700 uppercase">Driver arriving in</p>
                        <p className="text-xl font-bold text-blue-900">{trackedRide.eta} Minutes</p>
                      </div>
                    </div>
                  )}

                  <div className="space-y-4">
                    <div className="flex gap-4">
                      <div className="flex flex-col items-center gap-1">
                        <div className="w-3 h-3 rounded-full bg-emerald-500" />
                        <div className="w-0.5 h-full bg-zinc-200" />
                        <div className="w-3 h-3 rounded-full bg-zinc-900" />
                      </div>
                      <div className="flex-1 space-y-4">
                        <div>
                          <p className="text-xs text-zinc-400 font-bold uppercase">Pickup</p>
                          <p className="font-medium">{trackedRide.pickup_location}</p>
                        </div>
                        <div>
                          <p className="text-xs text-zinc-400 font-bold uppercase">Dropoff</p>
                          <p className="font-medium">{trackedRide.dropoff_location}</p>
                        </div>
                      </div>
                    </div>
                  </div>

                  {trackedRide.status !== 'cancelled' && trackedRide.status !== 'completed' && (
                    <div className="grid grid-cols-2 gap-4 pt-2">
                      <div className="bg-zinc-50 p-3 rounded-lg border border-zinc-100">
                        <p className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Start OTP</p>
                        <p className="text-lg font-mono font-bold text-zinc-900">{trackedRide.start_otp || '----'}</p>
                      </div>
                      <div className="bg-zinc-50 p-3 rounded-lg border border-zinc-100">
                        <p className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">End OTP</p>
                        <p className="text-lg font-mono font-bold text-zinc-900">{trackedRide.end_otp || '----'}</p>
                      </div>
                    </div>
                  )}

                  {trackedRide.driver_name && (
                    <div className="pt-6 border-t border-zinc-100 space-y-6">
                      <div className="flex items-center gap-4">
                        <div className="w-12 h-12 bg-zinc-100 rounded-full flex items-center justify-center">
                          <User className="w-6 h-6 text-zinc-400" />
                        </div>
                        <div className="flex-1">
                          <p className="font-bold">{trackedRide.driver_name}</p>
                          <p className="text-sm text-zinc-500">{trackedRide.vehicle_model} • {trackedRide.plate_number}</p>
                          {trackedRide.driver_phone && (
                            <a href={`tel:${trackedRide.driver_phone}`} className="text-xs font-bold text-emerald-600 flex items-center gap-1 mt-1">
                              <Phone className="w-3 h-3" /> {trackedRide.driver_phone}
                            </a>
                          )}
                        </div>
                        <div className="text-right">
                          <p className="text-xs text-zinc-400 font-bold uppercase">Fare</p>
                          <p className="text-lg font-bold">₹{trackedRide.fare}</p>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div className="bg-zinc-50 p-4 rounded-xl border border-zinc-100">
                          <p className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider mb-1">Start OTP</p>
                          <p className="text-2xl font-mono font-bold text-zinc-900">{trackedRide.start_otp || '----'}</p>
                          <p className="text-[10px] text-zinc-400 mt-1">Share to start ride</p>
                        </div>
                        <div className="bg-zinc-50 p-4 rounded-xl border border-zinc-100">
                          <p className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider mb-1">End OTP</p>
                          <p className="text-2xl font-mono font-bold text-zinc-900">{trackedRide.end_otp || '----'}</p>
                          <p className="text-[10px] text-zinc-400 mt-1">Share to end ride</p>
                        </div>
                      </div>
                    </div>
                  )}
                </motion.div>
              )}
            </motion.div>
          )}

          {/* ADMIN VIEW */}
          {view === 'admin' && (
            <motion.div
              key="admin"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="space-y-8"
            >
                  {!user ? (
                    <div className="max-w-md mx-auto bg-white p-8 rounded-2xl shadow-sm border border-zinc-200">
                      <h2 className="text-2xl font-bold mb-6 flex items-center gap-2">
                        {forgotPasswordMode ? <KeyRound className="w-6 h-6" /> : <ShieldCheck className="w-6 h-6" />} 
                        {forgotPasswordMode ? 'Reset Admin Password' : 'Admin Login'}
                      </h2>
                      {error && (
                        <div className="mb-4 p-3 bg-rose-50 text-rose-600 text-sm rounded-xl border border-rose-100">
                          {error}
                          <button onClick={() => setError('')} className="float-right"><X className="w-4 h-4" /></button>
                        </div>
                      )}
                      
                      {forgotPasswordMode ? (
                        <form onSubmit={handleForgotPassword} className="space-y-4">
                          <input
                            type="text"
                            placeholder="Registered Username"
                            required
                            className="w-full px-4 py-3 bg-zinc-50 border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900"
                            value={forgotPasswordData.identifier}
                            onChange={e => setForgotPasswordData({ ...forgotPasswordData, identifier: e.target.value })}
                          />
                          <input
                            type="password"
                            placeholder="New Password"
                            required
                            className="w-full px-4 py-3 bg-zinc-50 border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900"
                            value={forgotPasswordData.newPassword}
                            onChange={e => setForgotPasswordData({ ...forgotPasswordData, newPassword: e.target.value })}
                          />
                          <button className="w-full bg-zinc-900 text-white py-3 rounded-xl font-bold hover:bg-zinc-800 transition-all">
                            Update Password
                          </button>
                          <button 
                            type="button"
                            onClick={() => setForgotPasswordMode(false)}
                            className="w-full text-sm font-medium text-zinc-500 hover:text-zinc-900"
                          >
                            Back to Login
                          </button>
                        </form>
                      ) : (
                        <form onSubmit={handleAdminLogin} className="space-y-4">
                          {adminLoginStep === 'credentials' ? (
                            <>
                              <input
                                type="text"
                                placeholder="Username"
                                className="w-full px-4 py-3 bg-zinc-50 border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900"
                                value={loginData.username}
                                onChange={e => setLoginData({ ...loginData, username: e.target.value })}
                              />
                              <input
                                type="password"
                                placeholder="Password"
                                className="w-full px-4 py-3 bg-zinc-50 border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900"
                                value={loginData.password}
                                onChange={e => setLoginData({ ...loginData, password: e.target.value })}
                              />
                            </>
                          ) : (
                            <div className="space-y-4">
                              <div className="p-4 bg-zinc-900 text-white rounded-xl text-center">
                                <p className="text-xs font-bold uppercase tracking-widest opacity-60 mb-1">Step 2</p>
                                <p className="text-sm">Enter Secure PIN</p>
                              </div>
                              <input
                                type="password"
                                placeholder="4-Digit PIN"
                                maxLength={4}
                                autoFocus
                                className="w-full px-4 py-4 bg-zinc-50 border border-zinc-200 rounded-xl text-center text-2xl font-bold tracking-[1em] focus:outline-none focus:ring-2 focus:ring-zinc-900"
                                value={adminPin}
                                onChange={e => setAdminPin(e.target.value.replace(/\D/g, ''))}
                              />
                            </div>
                          )}
                          
                          <button className="w-full bg-zinc-900 text-white py-3 rounded-xl font-bold hover:bg-zinc-800 transition-all">
                            {adminLoginStep === 'credentials' ? 'Continue' : 'Verify & Login'}
                          </button>
                          
                          {adminLoginStep === 'pin' && (
                            <button 
                              type="button"
                              onClick={() => setAdminLoginStep('credentials')}
                              className="w-full text-sm font-medium text-zinc-500 hover:text-zinc-900"
                            >
                              Back to Credentials
                            </button>
                          )}
                          
                          <div className="text-right">
                            <button 
                              type="button"
                              onClick={() => {
                                setForgotPasswordMode(true);
                                setForgotPasswordData({ identifier: loginData.username, newPassword: '' });
                              }}
                              className="text-xs font-medium text-zinc-500 hover:text-zinc-900"
                            >
                              Forgot Password?
                            </button>
                          </div>
                        </form>
                      )}
                    </div>
                  ) : (
                <div className="space-y-8">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
                    <div className="bg-white p-4 sm:p-6 rounded-2xl border border-zinc-200">
                      <p className="text-zinc-500 text-xs sm:text-sm font-medium">Total Rides</p>
                      <p className="text-2xl sm:text-3xl font-bold">{adminRides.length}</p>
                    </div>
                    <div className="bg-white p-4 sm:p-6 rounded-2xl border border-zinc-200">
                      <p className="text-zinc-500 text-xs sm:text-sm font-medium">Active Drivers</p>
                      <p className="text-2xl sm:text-3xl font-bold">{adminDrivers.filter(d => d.status === 'active').length}</p>
                    </div>
                    <div className="bg-white p-4 sm:p-6 rounded-2xl border border-zinc-200">
                      <p className="text-zinc-500 text-xs sm:text-sm font-medium">Total Revenue</p>
                      <p className="text-2xl sm:text-3xl font-bold text-emerald-600">₹{adminRides.reduce((acc, r) => acc + r.fare, 0)}</p>
                    </div>
                  </div>

                  <div className="bg-white rounded-2xl border border-zinc-200 overflow-hidden">
                    <div className="p-6 border-b border-zinc-100">
                      <h3 className="font-bold text-lg">Manage Admins</h3>
                    </div>
                    <div className="p-6 space-y-4">
                      <form onSubmit={handleAddAdmin} className="flex flex-col sm:flex-row gap-2">
                        <input
                          type="text"
                          placeholder="Admin Username"
                          className="flex-1 px-4 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm"
                          value={newAdmin.username}
                          onChange={e => setNewAdmin({ ...newAdmin, username: e.target.value })}
                        />
                        <input
                          type="password"
                          placeholder="Password"
                          className="flex-1 px-4 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm"
                          value={newAdmin.password}
                          onChange={e => setNewAdmin({ ...newAdmin, password: e.target.value })}
                        />
                        <input
                          type="text"
                          maxLength={4}
                          placeholder="4-Digit PIN"
                          required
                          className="w-24 px-4 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm"
                          value={newAdmin.pin}
                          onChange={e => setNewAdmin({ ...newAdmin, pin: e.target.value.replace(/\D/g, '').slice(0, 4) })}
                        />
                        <select 
                          className="px-4 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm"
                          value={newAdmin.role}
                          onChange={e => setNewAdmin({ ...newAdmin, role: e.target.value as 'admin' | 'owner' })}
                        >
                          <option value="admin">Admin</option>
                        </select>
                        <button className="bg-zinc-900 text-white px-4 py-2 rounded-lg text-sm font-bold">Add Admin</button>
                      </form>
                      <div className="divide-y divide-zinc-100">
                        {otherAdmins.map(admin => (
                          <div key={admin.id} className="py-3 flex justify-between items-center">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-sm">{admin.username}</span>
                              <span className="text-[10px] bg-zinc-100 px-1.5 py-0.5 rounded uppercase font-bold text-zinc-500">{admin.role}</span>
                            </div>
                            {admin.role !== 'owner' && (
                              <button onClick={() => handleRemoveAdmin(admin.id)} className="text-rose-600 text-xs font-bold">Remove</button>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="bg-white rounded-2xl border border-zinc-200 overflow-hidden">
                    <div className="p-6 border-b border-zinc-100 flex items-center gap-2">
                      <Bell className="w-5 h-5 text-zinc-900" />
                      <h3 className="font-bold text-lg">Send Notification</h3>
                    </div>
                    <div className="p-6 space-y-4">
                      <form onSubmit={handleSendNotification} className="space-y-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          <div className="space-y-1">
                            <label className="text-xs font-bold text-zinc-500 uppercase tracking-wider">Target Audience</label>
                            <select 
                              className="w-full px-4 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900"
                              value={newNotification.target}
                              onChange={e => setNewNotification({ ...newNotification, target: e.target.value as Notification['target'] })}
                            >
                              <option value="all_drivers">All Drivers</option>
                              <option value="all_users">All Customers</option>
                              <option value="specific_driver">Specific Driver</option>
                            </select>
                          </div>
                          {newNotification.target === 'specific_driver' && (
                            <div className="space-y-1">
                              <label className="text-xs font-bold text-zinc-500 uppercase tracking-wider">Select Driver</label>
                              <select 
                                className="w-full px-4 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900"
                                value={newNotification.driver_id}
                                onChange={e => setNewNotification({ ...newNotification, driver_id: e.target.value })}
                                required
                              >
                                <option value="">Select a driver...</option>
                                {adminDrivers.map(d => (
                                  <option key={d.id} value={d.id}>{d.name} ({d.phone})</option>
                                ))}
                              </select>
                            </div>
                          )}
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs font-bold text-zinc-500 uppercase tracking-wider">Message</label>
                          <textarea
                            placeholder="Write your notification message here..."
                            className="w-full px-4 py-3 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900 min-h-[100px]"
                            value={newNotification.message}
                            onChange={e => setNewNotification({ ...newNotification, message: e.target.value })}
                            required
                          />
                        </div>
                        <button 
                          disabled={isSendingNotification}
                          className="w-full bg-zinc-900 text-white py-3 rounded-xl font-bold hover:bg-zinc-800 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                        >
                          {isSendingNotification ? (
                            <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                          ) : (
                            <Send className="w-4 h-4" />
                          )}
                          Send Notification
                        </button>
                      </form>
                    </div>
                  </div>

                  <div className="bg-white rounded-2xl border border-zinc-200 overflow-hidden">
                    <div className="p-6 border-b border-zinc-100 flex justify-between items-center">
                      <h3 className="font-bold text-lg">Withdrawal Requests</h3>
                      <span className="bg-zinc-100 text-zinc-600 text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider">
                        {adminWithdrawals.filter(w => w.status === 'pending').length} Pending
                      </span>
                    </div>
                    <div className="divide-y divide-zinc-100">
                      {adminWithdrawals.length === 0 ? (
                        <p className="p-6 text-center text-zinc-500 text-sm">No withdrawal requests.</p>
                      ) : (
                        adminWithdrawals.map(req => (
                          <div key={req.id} className="p-4 flex items-center justify-between">
                            <div>
                              <p className="font-bold">{req.driver_name}</p>
                              <p className="text-sm text-zinc-500">{req.driver_phone}</p>
                              {req.bank_details && (
                                <p className="text-[10px] text-zinc-400 bg-zinc-50 p-1 rounded mt-1 border border-zinc-100">
                                  Bank: {req.bank_details}
                                </p>
                              )}
                              <p className="text-lg font-bold text-rose-600">₹{req.amount}</p>
                            </div>
                            <div className="flex gap-2">
                              {req.status === 'pending' ? (
                                <>
                                  <button 
                                    onClick={() => handleWithdrawalAction(req.id, 'approved')}
                                    className="px-3 py-1.5 bg-emerald-600 text-white text-xs font-bold rounded-lg hover:bg-emerald-700"
                                  >
                                    Approve
                                  </button>
                                  <button 
                                    onClick={() => handleWithdrawalAction(req.id, 'rejected')}
                                    className="px-3 py-1.5 bg-rose-600 text-white text-xs font-bold rounded-lg hover:bg-rose-700"
                                  >
                                    Reject
                                  </button>
                                </>
                              ) : (
                                <span className={`px-2 py-1 rounded text-[10px] font-bold uppercase ${
                                  req.status === 'approved' ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'
                                }`}>
                                  {req.status}
                                </span>
                              )}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="bg-white rounded-2xl border border-zinc-200 overflow-hidden">
                    <div className="p-6 border-b border-zinc-100 flex justify-between items-center">
                      <h3 className="font-bold text-lg">Manage Users</h3>
                      <User className="w-5 h-5 text-zinc-400" />
                    </div>
                    <div className="divide-y divide-zinc-100">
                      {adminUsers.length === 0 ? (
                        <p className="p-6 text-center text-zinc-500 text-sm">No users found.</p>
                      ) : (
                        adminUsers.map(u => (
                          <div key={u.id} className="p-4 flex items-center justify-between">
                            <div>
                              <p className="font-bold">{u.name}</p>
                              <p className="text-sm text-zinc-500">{u.phone}</p>
                            </div>
                            <button 
                              onClick={() => handleDeleteUser(u.id)}
                              className="p-2 text-rose-600 hover:bg-rose-50 rounded-lg transition-colors"
                            >
                              <X className="w-5 h-5" />
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="bg-white rounded-2xl border border-zinc-200 overflow-hidden">
                    <div className="p-6 border-b border-zinc-100 flex justify-between items-center">
                      <div className="flex items-center gap-2">
                        <h3 className="font-bold text-lg">Manage Drivers</h3>
                        {adminDrivers.some(d => d.status !== 'active') && (
                          <span className="bg-amber-100 text-amber-700 text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider animate-pulse">
                            New Requests
                          </span>
                        )}
                      </div>
                      <Users className="w-5 h-5 text-zinc-400" />
                    </div>
                    <div className="divide-y divide-zinc-100">
                      {adminDrivers.length === 0 ? (
                        <p className="p-6 text-center text-zinc-500 text-sm">No drivers found.</p>
                      ) : (
                        adminDrivers.map(driver => (
                          <div key={driver.id} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                            <div className="flex items-center gap-4">
                              <div className="relative">
                                <div className="w-10 h-10 bg-zinc-100 rounded-full flex items-center justify-center">
                                  <User className="w-5 h-5 text-zinc-400" />
                                </div>
                                {driver.status !== 'active' && (
                                  <div className="absolute -top-1 -right-1 w-3 h-3 bg-amber-500 border-2 border-white rounded-full" />
                                )}
                              </div>
                              <div>
                                <div className="flex items-center gap-2">
                                  <p className="font-bold">{driver.name}</p>
                                  {driver.status !== 'active' && (
                                    <span className="text-[10px] bg-amber-50 text-amber-600 px-1.5 py-0.5 rounded border border-amber-100 font-bold uppercase">Pending</span>
                                  )}
                                </div>
                                <p className="text-sm text-zinc-500">{driver.phone}</p>
                              </div>
                              <button 
                                onClick={() => handleDeleteDriver(driver.id)}
                                className="p-1.5 text-rose-600 hover:bg-rose-50 rounded-lg transition-colors"
                              >
                                <X className="w-4 h-4" />
                              </button>
                            </div>
                            <div className="flex items-center justify-between sm:justify-end gap-4">
                              <div className="text-left sm:text-right">
                                <p className="text-[10px] text-zinc-400 font-bold uppercase">Wallet</p>
                                <p className="font-bold">₹{driver.wallet_balance}</p>
                                <div className="flex gap-1 mt-1">
                                  <button onClick={() => {
                                    const amt = prompt('Enter amount to add:');
                                    if (amt) handleWalletAdjust(driver.id, parseFloat(amt), 'credit');
                                  }} className="text-[10px] bg-emerald-50 text-emerald-600 px-1.5 py-0.5 rounded border border-emerald-100 font-bold">Add</button>
                                  <button onClick={() => {
                                    const amt = prompt('Enter amount to deduct:');
                                    if (amt) handleWalletAdjust(driver.id, parseFloat(amt), 'debit');
                                  }} className="text-[10px] bg-rose-50 text-rose-600 px-1.5 py-0.5 rounded border border-rose-100 font-bold">Deduct</button>
                                  <button onClick={() => fetchDriverTransactions(driver.id, driver.name)} className="text-[10px] bg-zinc-50 text-zinc-600 px-1.5 py-0.5 rounded border border-zinc-100 font-bold">History</button>
                                </div>
                              </div>
                              <button
                                onClick={() => toggleDriverStatus(driver.id, driver.status)}
                                className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${
                                  driver.status === 'active' 
                                  ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200' 
                                  : 'bg-zinc-900 text-white hover:bg-zinc-800 shadow-md'
                                }`}
                              >
                                {driver.status === 'active' ? 'Deactivate' : 'Verify & Activate'}
                              </button>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="bg-white rounded-2xl border border-zinc-200 overflow-hidden">
                    <div className="p-6 border-b border-zinc-100">
                      <h3 className="font-bold text-lg">Recent Rides</h3>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left">
                        <thead className="bg-zinc-50 text-xs font-bold uppercase text-zinc-400">
                          <tr>
                            <th className="px-6 py-4">ID</th>
                            <th className="px-6 py-4">User</th>
                            <th className="px-6 py-4">Driver</th>
                            <th className="px-6 py-4">Route & Schedule</th>
                            <th className="px-6 py-4">KM</th>
                            <th className="px-6 py-4">Status</th>
                            <th className="px-6 py-4">Fare</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-100">
                          {adminRides.map(ride => (
                            <tr key={ride.id} className="text-sm">
                              <td className="px-6 py-4 font-mono text-xs">{ride.tracking_id}</td>
                              <td className="px-6 py-4 font-medium">{(ride as any).user_name || 'Guest'}</td>
                              <td className="px-6 py-4 font-medium">{(ride as any).driver_name || '---'}</td>
                              <td className="px-6 py-4">
                                <p className="truncate max-w-[150px] font-bold">{ride.pickup_location} → {ride.dropoff_location}</p>
                                <div className="flex flex-wrap gap-1 mt-1">
                                  {ride.trip_type === 'round' ? (
                                    <span className="text-[8px] bg-indigo-50 text-indigo-600 px-1 py-0.5 rounded font-bold uppercase">Round</span>
                                  ) : (
                                    <span className="text-[8px] bg-zinc-50 text-zinc-600 px-1 py-0.5 rounded font-bold uppercase">Single</span>
                                  )}
                                  {ride.pickup_date && (
                                    <span className="text-[8px] bg-emerald-50 text-emerald-600 px-1 py-0.5 rounded font-bold uppercase flex items-center gap-0.5">
                                      <Clock className="w-2 h-2" /> {ride.pickup_date} {ride.pickup_time}
                                    </span>
                                  )}
                                  <span className="text-[8px] bg-zinc-100 text-zinc-500 px-1 py-0.5 rounded font-bold uppercase">
                                    Req: {new Date(ride.created_at).toLocaleDateString()}
                                  </span>
                                </div>
                              </td>
                              <td className="px-6 py-4 font-medium">{(ride as any).distance || '---'}</td>
                              <td className="px-6 py-4">
                                <span className={`px-2 py-1 rounded-full text-[10px] font-bold uppercase ${getStatusColor(ride.status)}`}>
                                  {getStatusLabel(ride.status)}
                                </span>
                              </td>
                              <td className="px-6 py-4 font-bold">₹{ride.fare}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {selectedDriverTransactions && (
                    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                      <motion.div 
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className="bg-white w-full max-w-2xl rounded-3xl shadow-2xl overflow-hidden max-h-[80vh] flex flex-col"
                      >
                        <div className="p-6 border-b border-zinc-100 flex justify-between items-center bg-zinc-900 text-white">
                          <div>
                            <h3 className="font-bold text-xl">{selectedDriverTransactions.name}'s Transactions</h3>
                            <p className="text-xs opacity-60">Full history of wallet movements</p>
                          </div>
                          <button onClick={() => setSelectedDriverTransactions(null)} className="p-2 hover:bg-white/10 rounded-full transition-colors">
                            <X className="w-6 h-6" />
                          </button>
                        </div>
                        <div className="flex-1 overflow-y-auto p-6">
                          <div className="space-y-3">
                            {selectedDriverTransactions.transactions.length === 0 ? (
                              <p className="text-center text-zinc-500 py-8">No transactions found.</p>
                            ) : (
                              selectedDriverTransactions.transactions.map((t: any) => (
                                <div key={t.id} className="p-4 bg-zinc-50 rounded-2xl border border-zinc-100 flex justify-between items-center">
                                  <div>
                                    <p className="font-bold text-sm">{t.description}</p>
                                    <p className="text-[10px] text-zinc-400">{new Date(t.created_at).toLocaleString()}</p>
                                  </div>
                                  <p className={`font-black ${t.type === 'credit' ? 'text-emerald-600' : 'text-rose-600'}`}>
                                    {t.type === 'credit' ? '+' : '-'}₹{t.amount}
                                  </p>
                                </div>
                              ))
                            )}
                          </div>
                        </div>
                      </motion.div>
                    </div>
                  )}
                </div>
              )}
            </motion.div>
          )}

          {/* DRIVER VIEW */}
          {view === 'driver' && (
            <motion.div
              key="driver"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="space-y-8"
            >
              {!user ? (
                <div className="max-w-md mx-auto bg-white p-8 rounded-2xl shadow-sm border border-zinc-200">
                  <h2 className="text-2xl font-bold mb-6 flex items-center gap-2">
                    {forgotPasswordMode ? <KeyRound className="w-6 h-6" /> : <Car className="w-6 h-6" />} 
                    {forgotPasswordMode ? 'Reset Password' : (driverAuthMode === 'login' ? 'Driver Login' : 'Driver Registration')}
                  </h2>
                  {error && (
                    <div className="mb-4 p-3 bg-rose-50 text-rose-600 text-sm rounded-xl border border-rose-100">
                      {error}
                      <button onClick={() => setError('')} className="float-right"><X className="w-4 h-4" /></button>
                    </div>
                  )}
                  
                  {forgotPasswordMode ? (
                    <form onSubmit={handleForgotPassword} className="space-y-4">
                      <input
                        type="tel"
                        placeholder="Registered Phone Number"
                        required
                        className="w-full px-4 py-3 bg-zinc-50 border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900"
                        value={forgotPasswordData.identifier}
                        onChange={e => setForgotPasswordData({ ...forgotPasswordData, identifier: e.target.value })}
                      />
                      <input
                        type="password"
                        placeholder="New Password"
                        required
                        className="w-full px-4 py-3 bg-zinc-50 border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900"
                        value={forgotPasswordData.newPassword}
                        onChange={e => setForgotPasswordData({ ...forgotPasswordData, newPassword: e.target.value })}
                      />
                      <button className="w-full bg-zinc-900 text-white py-3 rounded-xl font-bold hover:bg-zinc-800 transition-all">
                        Update Password
                      </button>
                      <button 
                        type="button"
                        onClick={() => setForgotPasswordMode(false)}
                        className="w-full text-sm font-medium text-zinc-500 hover:text-zinc-900"
                      >
                        Back to Login
                      </button>
                    </form>
                  ) : (
                    <>
                      <form onSubmit={driverAuthMode === 'login' ? handleDriverLogin : handleDriverRegister} className="space-y-4">
                        {driverAuthMode === 'register' && (
                          <input
                            type="text"
                            placeholder="Full Name"
                            required
                            className="w-full px-4 py-3 bg-zinc-50 border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900"
                            value={loginData.name}
                            onChange={e => setLoginData({ ...loginData, name: e.target.value })}
                          />
                        )}
                        <input
                          type="tel"
                          placeholder="Phone Number"
                          required
                          className="w-full px-4 py-3 bg-zinc-50 border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900"
                          value={loginData.phone}
                          onChange={e => setLoginData({ ...loginData, phone: e.target.value })}
                        />
                        <input
                          type="password"
                          placeholder="Password"
                          required
                          className="w-full px-4 py-3 bg-zinc-50 border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900"
                          value={loginData.password}
                          onChange={e => setLoginData({ ...loginData, password: e.target.value })}
                        />
                        {driverAuthMode === 'login' && (
                          <div className="text-right">
                            <button 
                              type="button"
                              onClick={() => setForgotPasswordMode(true)}
                              className="text-xs font-medium text-zinc-500 hover:text-zinc-900"
                            >
                              Forgot Password?
                            </button>
                          </div>
                        )}
                        <button className="w-full bg-zinc-900 text-white py-3 rounded-xl font-bold hover:bg-zinc-800 transition-all">
                          {driverAuthMode === 'login' ? 'Login' : 'Register'}
                        </button>
                      </form>
                      <div className="mt-6 text-center">
                        <button 
                          onClick={() => {
                            setDriverAuthMode(driverAuthMode === 'login' ? 'register' : 'login');
                            setError('');
                          }}
                          className="text-sm font-medium text-zinc-500 hover:text-zinc-900"
                        >
                          {driverAuthMode === 'login' ? "Don't have an account? Register" : "Already have an account? Login"}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <div className="space-y-8">
                  <div className="bg-zinc-900 text-white p-8 rounded-3xl relative overflow-hidden">
                    <div className="relative z-10">
                      <p className="text-zinc-400 font-medium mb-1">Wallet Balance</p>
                      <h2 className="text-5xl font-bold mb-6">₹{driverWallet.balance}</h2>
                      <div className="flex flex-wrap gap-3">
                        <button 
                          onClick={handleRequestWithdrawal}
                          className="bg-white text-zinc-900 px-6 py-3 rounded-xl font-bold hover:bg-zinc-100 transition-all flex items-center gap-2"
                        >
                          <CreditCard className="w-5 h-5" /> Withdraw to Bank
                        </button>
                        {!isAudioUnlocked && (
                          <button 
                            onClick={unlockAudio}
                            className="bg-emerald-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-emerald-500 transition-all flex items-center gap-2"
                          >
                            <ShieldCheck className="w-5 h-5" /> Enable Sound Alerts
                          </button>
                        )}
                      </div>
                    </div>
                    <Wallet className="absolute -right-8 -bottom-8 w-48 h-48 text-white/5" />
                  </div>

                  {completedRides.length > 0 && (
                    <div className="bg-white p-6 rounded-2xl border border-zinc-200 shadow-sm space-y-4">
                      <h3 className="font-bold flex items-center gap-2">
                        <CheckCircle2 className="w-5 h-5 text-emerald-500" /> Recent Completed Rides
                      </h3>
                      <div className="space-y-3">
                        {completedRides.map(ride => (
                          <div key={ride.id} className="p-4 bg-zinc-50 rounded-xl border border-zinc-100 flex justify-between items-center">
                            <div>
                              <p className="text-sm font-bold">{ride.pickup_location} → {ride.dropoff_location}</p>
                              <div className="flex items-center gap-2 mt-1">
                                <p className="text-[10px] text-zinc-400 font-mono">{ride.tracking_id}</p>
                                {ride.pickup_date && (
                                  <p className="text-[10px] text-emerald-600 font-bold uppercase">{ride.pickup_date} {ride.pickup_time}</p>
                                )}
                              </div>
                            </div>
                            <div className="text-right">
                              <p className="font-bold text-emerald-600">₹{ride.fare}</p>
                              <span className="text-[10px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded font-bold uppercase">Completed</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {driverWithdrawals.length > 0 && (
                    <div className="bg-white p-6 rounded-2xl border border-zinc-200 shadow-sm space-y-4">
                      <h3 className="font-bold flex items-center gap-2">
                        <HistoryIcon className="w-5 h-5 text-zinc-400" /> Withdrawal History
                      </h3>
                      <div className="divide-y divide-zinc-100">
                        {driverWithdrawals.map(req => (
                          <div key={req.id} className="py-3 flex justify-between items-center">
                            <div>
                              <p className="font-bold">₹{req.amount}</p>
                              <p className="text-[10px] text-zinc-400">{new Date(req.created_at).toLocaleDateString()}</p>
                            </div>
                            <span className={`px-2 py-1 rounded text-[10px] font-bold uppercase ${
                              req.status === 'approved' ? 'bg-emerald-100 text-emerald-700' : 
                              req.status === 'pending' ? 'bg-amber-100 text-amber-700' : 
                              'bg-rose-100 text-rose-700'
                            }`}>
                              {req.status}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <h3 className="font-bold text-xl flex items-center gap-2">
                        <Clock className="w-5 h-5" /> Available Rides
                      </h3>
                      {isAudioUnlocked && (
                        <button 
                          onClick={stopRing}
                          className="flex items-center gap-2 px-3 py-1.5 bg-rose-50 text-rose-600 rounded-lg text-xs font-bold border border-rose-100 hover:bg-rose-100 transition-colors"
                        >
                          <BellRing className="w-3.5 h-3.5" /> Stop Alert
                        </button>
                      )}
                    </div>
                    {availableRides.length === 0 ? (
                      <div className="bg-white p-12 rounded-2xl border border-zinc-200 text-center space-y-2">
                        <p className="text-zinc-500">No rides available right now.</p>
                        <p className="text-sm text-zinc-400">Stay online to receive requests.</p>
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 gap-4">
                        {availableRides.map(ride => (
                          <div key={ride.id} className="bg-white p-6 rounded-2xl border border-zinc-200 shadow-sm space-y-4">
                            <div className="flex justify-between items-center">
                              <div className="space-y-1">
                                <p className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Pickup Date/Time</p>
                                <p className="text-xs font-bold text-emerald-600">{ride.pickup_date} {ride.pickup_time}</p>
                              </div>
                              <div className="space-y-1">
                                <p className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Requested At</p>
                                <p className="text-xs font-medium text-zinc-600">{new Date(ride.created_at).toLocaleString()}</p>
                              </div>
                              <div className="text-right">
                                <p className="text-xs font-bold text-zinc-400 uppercase">Fare</p>
                                <p className="text-xl font-bold text-emerald-600">₹{ride.fare}</p>
                              </div>
                            </div>

                            <div className="space-y-3">
                              <div className="flex gap-3">
                                <div className="flex flex-col items-center gap-1">
                                  <div className="w-2 h-2 rounded-full bg-emerald-500" />
                                  <div className="w-0.5 h-4 bg-zinc-100" />
                                  <div className="w-2 h-2 rounded-full bg-zinc-900" />
                                </div>
                                <div className="flex-1 space-y-3">
                                  <div>
                                    <p className="text-[10px] font-bold text-zinc-400 uppercase">Pickup</p>
                                    <p className="text-sm font-bold">{ride.pickup_location}</p>
                                  </div>
                                  <div>
                                    <p className="text-[10px] font-bold text-zinc-400 uppercase">Dropoff</p>
                                    <p className="text-sm font-bold">{ride.dropoff_location}</p>
                                  </div>
                                </div>
                              </div>
                            </div>

                            <div className="flex justify-between items-center pt-2 border-t border-zinc-50">
                              <div className="flex items-center gap-2">
                                <span className={`px-2 py-1 rounded text-[10px] font-bold uppercase ${getStatusColor(ride.status)}`}>
                                  {getStatusLabel(ride.status)}
                                  {ride.status === 'accepted' && ride.driver_id !== user.id && ride.driver_name && ` (by ${ride.driver_name})`}
                                </span>
                                {ride.trip_type === 'round' ? (
                                  <span className="px-2 py-1 rounded text-[10px] font-bold uppercase bg-indigo-100 text-indigo-700">Round Trip</span>
                                ) : (
                                  <span className="px-2 py-1 rounded text-[10px] font-bold uppercase bg-zinc-100 text-zinc-700">Single Trip</span>
                                )}
                              </div>
                              {ride.distance && (
                                <p className="text-[10px] font-bold text-zinc-400 uppercase">{ride.distance} KM</p>
                              )}
                            </div>

                            {/* Passenger Contact - Only visible after acceptance by THIS driver */}
                            {ride.driver_id === user.id && (ride.status === 'accepted' || ride.status === 'ongoing') && (
                              <div className="p-3 bg-emerald-50 rounded-xl border border-emerald-100 flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                  <div className="w-8 h-8 bg-emerald-100 rounded-full flex items-center justify-center">
                                    <User className="w-4 h-4 text-emerald-600" />
                                  </div>
                                  <div>
                                    <p className="text-xs font-bold text-emerald-700 uppercase">Passenger</p>
                                    <p className="text-sm font-bold text-emerald-900">{ride.user_name || 'Guest'}</p>
                                  </div>
                                </div>
                                <a 
                                  href={`tel:${ride.user_phone}`}
                                  className="flex items-center gap-2 px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-bold hover:bg-emerald-700 transition-colors"
                                >
                                  Call: {ride.user_phone}
                                </a>
                              </div>
                            )}

                            {ride.status === 'pending' && (
                              <div className="space-y-3">
                                {acceptingRideId === ride.id ? (
                                  <div className="bg-zinc-50 p-4 rounded-xl border border-zinc-200 space-y-3">
                                    <p className="text-xs font-bold text-zinc-500 uppercase">Enter Arrival Time</p>
                                    <div className="flex gap-2">
                                      <input
                                        type="number"
                                        placeholder="Minutes to reach"
                                        className="flex-1 px-4 py-2 bg-white border border-zinc-300 rounded-lg text-sm focus:ring-2 focus:ring-zinc-900 outline-none"
                                        value={etaInput}
                                        onChange={e => setEtaInput(e.target.value)}
                                        autoFocus
                                      />
                                      <button
                                        onClick={() => handleAcceptRide(ride.id)}
                                        disabled={isActionLoading || !etaInput}
                                        className="bg-zinc-900 text-white px-6 py-2 rounded-lg text-sm font-bold disabled:opacity-50 hover:bg-zinc-800 transition-colors"
                                      >
                                        {isActionLoading ? '...' : 'Confirm'}
                                      </button>
                                    </div>
                                    <button
                                      onClick={() => { setAcceptingRideId(null); setEtaInput(''); }}
                                      className="w-full text-zinc-400 text-xs font-bold py-1 hover:text-zinc-600"
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                ) : (
                                  <button
                                    onClick={() => setAcceptingRideId(ride.id)}
                                    disabled={isActionLoading}
                                    className="w-full bg-zinc-900 text-white py-3 rounded-xl font-bold hover:bg-zinc-800 transition-all disabled:opacity-50"
                                  >
                                    Accept Ride
                                  </button>
                                )}
                              </div>
                            )}

                            {ride.status === 'accepted' && ride.driver_id === user.id && (
                              <div className="space-y-3">
                                <div className="flex gap-2">
                                  <input
                                    type="text"
                                    placeholder="Enter Start OTP"
                                    className="flex-1 px-4 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm"
                                    value={otpInput}
                                    onChange={e => setOtpInput(e.target.value)}
                                  />
                                  <button
                                    onClick={() => handleStartRide(ride.id)}
                                    disabled={isActionLoading}
                                    className="bg-emerald-600 text-white px-4 py-2 rounded-lg text-sm font-bold disabled:opacity-50"
                                  >
                                    {isActionLoading ? '...' : 'Start'}
                                  </button>
                                </div>
                                <button
                                  onClick={() => handleCancelRide(ride.id)}
                                  className="w-full text-rose-600 text-xs font-bold py-2"
                                >
                                  Cancel Ride (₹50 Fine)
                                </button>
                              </div>
                            )}

                            {ride.status === 'ongoing' && ride.driver_id === user.id && (
                              <div className="space-y-4">
                                <div className="bg-emerald-50 border border-emerald-100 p-3 rounded-xl text-center">
                                  <p className="text-xs font-bold text-emerald-600 uppercase">Ride in Progress</p>
                                  <p className="text-sm font-bold text-emerald-700">On the way to dropoff</p>
                                </div>
                                <div className="space-y-2">
                                  <p className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest ml-1">Ride Completion</p>
                                  <div className="flex gap-2">
                                    <input
                                      type="text"
                                      placeholder="Enter End OTP"
                                      className="flex-1 px-4 py-2 bg-white border border-zinc-200 rounded-lg text-sm focus:ring-2 focus:ring-zinc-900 outline-none"
                                      value={otpInput}
                                      onChange={e => setOtpInput(e.target.value)}
                                    />
                                    <button
                                      onClick={() => handleCompleteRide(ride.id)}
                                      disabled={isActionLoading || !otpInput}
                                      className="bg-zinc-900 text-white px-6 py-2 rounded-lg text-sm font-bold hover:bg-zinc-800 transition-all disabled:opacity-50"
                                    >
                                      {isActionLoading ? '...' : 'Complete Trip'}
                                    </button>
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="bg-white rounded-2xl border border-zinc-200 overflow-hidden">
                    <div className="p-6 border-b border-zinc-100">
                      <h3 className="font-bold text-lg">Wallet History</h3>
                    </div>
                    <div className="divide-y divide-zinc-100">
                      {driverWallet.transactions.map((tx: any) => (
                        <div key={tx.id} className="p-4 flex items-center justify-between">
                          <div>
                            <p className="font-bold">{tx.description}</p>
                            <p className="text-xs text-zinc-400">{new Date(tx.created_at).toLocaleString()}</p>
                          </div>
                          <p className={`font-bold ${tx.type === 'credit' ? 'text-emerald-600' : 'text-rose-600'}`}>
                            {tx.type === 'credit' ? '+' : '-'}₹{tx.amount}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Notification Modal */}
      <AnimatePresence>
        {activeNotification && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="bg-white w-full max-w-md rounded-3xl overflow-hidden shadow-2xl border border-zinc-200"
            >
              <div className="p-8 text-center space-y-6">
                <div className="w-20 h-20 bg-zinc-900 rounded-full flex items-center justify-center mx-auto shadow-lg shadow-zinc-200">
                  <Bell className="w-10 h-10 text-white" />
                </div>
                
                <div className="space-y-2">
                  <p className="text-xs font-bold text-zinc-400 uppercase tracking-[0.2em]">New Notification</p>
                  <h3 className="text-2xl font-bold text-zinc-900 leading-tight">Admin Message</h3>
                </div>

                <div className="p-6 bg-zinc-50 rounded-2xl border border-zinc-100 italic text-zinc-700 leading-relaxed">
                  "{activeNotification.message}"
                </div>

                <button
                  onClick={() => dismissNotification(activeNotification.id)}
                  className="w-full bg-zinc-900 text-white py-4 rounded-2xl font-bold hover:bg-zinc-800 transition-all shadow-lg shadow-zinc-200 active:scale-[0.98]"
                >
                  Got it, thanks!
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

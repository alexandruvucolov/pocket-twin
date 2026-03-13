import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  ReactNode,
} from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  updateProfile,
} from "firebase/auth";
import {
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import { auth, db, firebaseEnabled } from "../lib/firebase";

export interface User {
  id: string;
  email: string;
  displayName: string;
  photoURL?: string;
}

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, name: string) => Promise<void>;
  signOut: () => Promise<void>;
  updateUserProfile: (displayName: string, photoURL?: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);
const SIGNED_IN_KEY = "pocket_twin:signed_in";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(firebaseEnabled);

  const buildUser = (
    firebaseUser: {
      uid: string;
      email: string | null;
      displayName: string | null;
      photoURL: string | null;
    },
    profile?: { displayName?: string | null; photoURL?: string | null },
  ): User => ({
    id: firebaseUser.uid,
    email: firebaseUser.email ?? "",
    displayName:
      profile?.displayName?.trim() ||
      firebaseUser.displayName?.trim() ||
      firebaseUser.email?.split("@")[0] ||
      "User",
    photoURL: profile?.photoURL ?? firebaseUser.photoURL ?? undefined,
  });

  useEffect(() => {
    if (!firebaseEnabled || !auth) {
      setIsLoading(false);
      return;
    }

    const firebaseAuth = auth;
    let unsubscribe = () => {};
    let isMounted = true;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let hasResolvedInitialState = false;
    let skippedInitialNull = false;

    const initAuth = () => {
      const signedInPromise: Promise<boolean> = AsyncStorage.getItem(
        SIGNED_IN_KEY,
      )
        .then((value) => value === "1")
        .catch(() => false);

      // Safety timeout so loading always resolves.
      timeoutId = setTimeout(() => {
        if (isMounted && !hasResolvedInitialState) {
          hasResolvedInitialState = true;
          setUser(null);
          setIsLoading(false);
        }
      }, 30_000);

      unsubscribe = onAuthStateChanged(firebaseAuth, async (firebaseUser) => {
        if (!isMounted) return;

        // First null may be transient while persistence is restoring.
        // Only skip it when we know user was previously signed in.
        if (!firebaseUser && !hasResolvedInitialState) {
          const wasSignedIn = await signedInPromise;
          if (!isMounted) return;
          if (wasSignedIn && !skippedInitialNull) {
            skippedInitialNull = true;
            return;
          }
        }

        if (!firebaseUser && !hasResolvedInitialState) {
          hasResolvedInitialState = true;
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
          setUser(null);
          setIsLoading(false);
          return;
        }

        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        hasResolvedInitialState = true;

        try {
          if (!firebaseUser) {
            await AsyncStorage.removeItem(SIGNED_IN_KEY).catch(() => {});
            setUser(null);
            return;
          }

          await AsyncStorage.setItem(SIGNED_IN_KEY, "1").catch(() => {});

          setUser(buildUser(firebaseUser));

          if (!db) return;

          const userRef = doc(db, "users", firebaseUser.uid);
          const existingDoc = await getDoc(userRef);
          const existingData = existingDoc.data();

          setUser(
            buildUser(firebaseUser, {
              displayName:
                typeof existingData?.displayName === "string"
                  ? existingData.displayName
                  : null,
              photoURL:
                typeof existingData?.photoURL === "string"
                  ? existingData.photoURL
                  : null,
            }),
          );

          if (!existingDoc.exists()) {
            await setDoc(userRef, {
              email: firebaseUser.email ?? "",
              displayName:
                firebaseUser.displayName ??
                firebaseUser.email?.split("@")[0] ??
                "User",
              photoURL: firebaseUser.photoURL ?? null,
              coins: 12,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });

            setUser(buildUser(firebaseUser));
          }
        } catch (err) {
          console.warn("[Auth] Error in auth state handler:", err);
        } finally {
          if (isMounted) setIsLoading(false);
        }
      });
    };

    initAuth();

    return () => {
      isMounted = false;
      if (timeoutId) clearTimeout(timeoutId);
      unsubscribe();
    };
  }, []);

  const signIn = async (email: string, _password: string) => {
    if (firebaseEnabled && auth) {
      setIsLoading(true);
      await signInWithEmailAndPassword(auth, email, _password);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    await new Promise((r) => setTimeout(r, 1200));
    setUser({
      id: "dummy-user-001",
      email,
      displayName: email.split("@")[0],
      photoURL: "https://randomuser.me/api/portraits/men/32.jpg",
    });
    setIsLoading(false);
  };

  const signUp = async (email: string, _password: string, name: string) => {
    if (firebaseEnabled && auth) {
      setIsLoading(true);
      const credential = await createUserWithEmailAndPassword(
        auth,
        email,
        _password,
      );
      await updateProfile(credential.user, {
        displayName: name,
      });

      if (db) {
        await setDoc(
          doc(db, "users", credential.user.uid),
          {
            email,
            displayName: name,
            photoURL: null,
            coins: 12,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          },
          { merge: true },
        );
      }

      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    await new Promise((r) => setTimeout(r, 1400));
    setUser({
      id: "dummy-user-001",
      email,
      displayName: name,
      photoURL: undefined,
    });
    setIsLoading(false);
  };

  const updateUserProfile = async (displayName: string, photoURL?: string) => {
    if (!firebaseEnabled || !auth?.currentUser) return;
    const currentUser = auth.currentUser;

    await updateProfile(currentUser, {
      displayName,
      ...(photoURL !== undefined ? { photoURL } : {}),
    });

    if (db) {
      await updateDoc(doc(db, "users", currentUser.uid), {
        displayName,
        ...(photoURL !== undefined ? { photoURL } : {}),
        updatedAt: serverTimestamp(),
      });
    }

    setUser((prev) =>
      prev
        ? {
            ...prev,
            displayName,
            ...(photoURL !== undefined ? { photoURL } : {}),
          }
        : prev,
    );
  };

  const signOut = async () => {
    if (firebaseEnabled && auth) {
      await AsyncStorage.removeItem(SIGNED_IN_KEY).catch(() => {});
      await firebaseSignOut(auth);
      return;
    }

    setUser(null);
  };

  return (
    <AuthContext.Provider
      value={{ user, isLoading, signIn, signUp, signOut, updateUserProfile }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

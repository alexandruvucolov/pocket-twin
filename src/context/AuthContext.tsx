import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  ReactNode,
} from "react";
import { AppState } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  GoogleSignin,
  statusCodes,
} from "@react-native-google-signin/google-signin";
import {
  EmailAuthProvider,
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  deleteUser,
  onAuthStateChanged,
  reauthenticateWithCredential,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithCredential,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  updateProfile,
} from "firebase/auth";
import {
  deleteDoc,
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import { auth, db, firebaseEnabled } from "../lib/firebase";

GoogleSignin.configure({
  webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
});

export interface User {
  id: string;
  email: string;
  displayName: string;
  photoURL?: string;
  emailVerified: boolean;
}

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, name: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  updateUserProfile: (displayName: string, photoURL?: string) => Promise<void>;
  deleteAccount: () => Promise<void>;
  reAuthAndDelete: (password?: string) => Promise<void>;
  isGoogleUser: boolean;
  emailVerified: boolean;
  resendVerificationEmail: () => Promise<void>;
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
      emailVerified: boolean;
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
    emailVerified: firebaseUser.emailVerified,
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

    // Reload the Firebase user when the app comes back to the foreground.
    // This ensures emailVerified reflects the latest state after the user
    // taps the verification link in their email and returns to the app.
    const appStateSub = AppState.addEventListener("change", async (state) => {
      if (state === "active" && firebaseAuth.currentUser) {
        try {
          await firebaseAuth.currentUser.reload();
          if (isMounted) {
            setUser((prev) =>
              prev ? { ...prev, emailVerified: firebaseAuth.currentUser!.emailVerified } : prev,
            );
          }
        } catch {
          // ignore — user may have signed out
        }
      }
    });

    return () => {
      isMounted = false;
      if (timeoutId) clearTimeout(timeoutId);
      unsubscribe();
      appStateSub.remove();
    };
  }, []);

  const signIn = async (email: string, _password: string) => {
    if (firebaseEnabled && auth) {
      setIsLoading(true);
      try {
        await signInWithEmailAndPassword(auth, email, _password);
      } catch (err) {
        setIsLoading(false);
        throw err;
      }
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
      try {
        const credential = await createUserWithEmailAndPassword(
          auth,
          email,
          _password,
        );
        await updateProfile(credential.user, {
          displayName: name,
        });

        // Send verification email — fire and forget, don't block signup.
        sendEmailVerification(credential.user).catch(() => {});

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
      } catch (err) {
        setIsLoading(false);
        throw err;
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

  const signInWithGoogle = async () => {
    if (!firebaseEnabled || !auth) return;
    try {
      setIsLoading(true);
      await GoogleSignin.hasPlayServices({
        showPlayServicesUpdateDialog: true,
      });
      const signInResult = await GoogleSignin.signIn();
      const idToken = signInResult.data?.idToken;
      if (!idToken) throw new Error("Google Sign-In did not return an idToken");
      const credential = GoogleAuthProvider.credential(idToken);
      await signInWithCredential(auth, credential);
    } catch (error: unknown) {
      setIsLoading(false);
      const code = (error as { code?: string })?.code;
      if (code === statusCodes.SIGN_IN_CANCELLED) return; // user cancelled
      if (code === statusCodes.IN_PROGRESS) return; // already in progress
      throw error;
    }
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
      await GoogleSignin.signOut().catch(() => {});
      await firebaseSignOut(auth);
      return;
    }

    setUser(null);
  };

  const resetPassword = async (email: string) => {
    if (!firebaseEnabled || !auth) throw new Error("Firebase not configured");
    await sendPasswordResetEmail(auth, email);
  };

  const deleteAccount = async () => {
    if (!firebaseEnabled || !auth?.currentUser) return;
    const currentUser = auth.currentUser;

    // Delete Firestore user document
    if (db) {
      await deleteDoc(doc(db, "users", currentUser.uid)).catch(() => {});
    }

    await AsyncStorage.removeItem(SIGNED_IN_KEY).catch(() => {});
    // deleteUser requires a recently signed-in session; throws
    // auth/requires-recent-login if the token is stale — callers must catch this.
    await deleteUser(currentUser);
    setUser(null);
  };

  /**
   * Re-authenticates the current user (Google or email/password) then deletes
   * the account. Call this when deleteAccount throws auth/requires-recent-login.
   * For Google users pass no arguments — it triggers a fresh Google Sign-In.
   * For email users pass the user's current password.
   */
  const reAuthAndDelete = async (password?: string) => {
    if (!firebaseEnabled || !auth?.currentUser) return;
    const currentUser = auth.currentUser;
    const isGoogleUser = currentUser.providerData.some(
      (p) => p.providerId === "google.com",
    );

    if (isGoogleUser) {
      await GoogleSignin.hasPlayServices();
      const signInResult = await GoogleSignin.signIn();
      const idToken = signInResult.data?.idToken;
      if (!idToken) throw new Error("Google re-auth did not return an idToken");
      const credential = GoogleAuthProvider.credential(idToken);
      await reauthenticateWithCredential(currentUser, credential);
    } else {
      if (!password) throw new Error("Password required for re-authentication");
      const credential = EmailAuthProvider.credential(
        currentUser.email ?? "",
        password,
      );
      await reauthenticateWithCredential(currentUser, credential);
    }

    if (db) {
      await deleteDoc(doc(db, "users", currentUser.uid)).catch(() => {});
    }
    await AsyncStorage.removeItem(SIGNED_IN_KEY).catch(() => {});
    await GoogleSignin.signOut().catch(() => {});
    await deleteUser(currentUser);
    setUser(null);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        signIn,
        signUp,
        signInWithGoogle,
        signOut,
        resetPassword,
        updateUserProfile,
        deleteAccount,
        reAuthAndDelete,
        isGoogleUser:
          auth?.currentUser?.providerData.some(
            (p) => p.providerId === "google.com",
          ) ?? false,
        emailVerified: user?.emailVerified ?? false,
        resendVerificationEmail: async () => {
          if (!auth?.currentUser) throw new Error("Not signed in");
          await sendEmailVerification(auth.currentUser);
        },
      }}
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

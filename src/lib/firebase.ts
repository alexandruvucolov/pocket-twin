import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system/legacy";
import * as ImageManipulator from "expo-image-manipulator";
import { getApp, getApps, initializeApp } from "firebase/app";
import {
  getAuth,
  getReactNativePersistence,
  initializeAuth,
} from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import {
  getDownloadURL,
  getStorage,
  ref,
  uploadString,
} from "firebase/storage";

const firebaseConfig = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
};

export const firebaseEnabled = Object.values(firebaseConfig).every(Boolean);

export const app = firebaseEnabled
  ? getApps().length > 0
    ? getApp()
    : initializeApp(firebaseConfig)
  : null;

// Source - https://stackoverflow.com/q/79662820
// Posted by Anonymous, modified by community. See post 'Timeline' for change history
// Retrieved 2026-03-13, License - CC BY-SA 4.0

export const auth = app
  ? (() => {
      try {
        return initializeAuth(app, {
          persistence: getReactNativePersistence(AsyncStorage),
        });
      } catch (err) {
        console.log(
          "[Firebase] initializeAuth threw, using getAuth(). Error:",
          err,
        );
        return getAuth(app);
      }
    })()
  : null;

export const db = app ? getFirestore(app) : null;
export const storage = app ? getStorage(app) : null;

// Keep firebaseApp as an alias for backwards compatibility
export const firebaseApp = app;

function getContentTypeFromUri(uri: string) {
  const normalizedUri = uri.toLowerCase();

  if (normalizedUri.endsWith(".png")) return "image/png";
  if (normalizedUri.endsWith(".webp")) return "image/webp";
  if (normalizedUri.endsWith(".heic") || normalizedUri.endsWith(".heif")) {
    return "image/heic";
  }

  return "image/jpeg";
}

async function readImageAsBase64(uri: string) {
  try {
    return await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
  } catch {
    throw new Error("Could not read image file from device.");
  }
}

/**
 * Compress + resize to max 1024 px wide JPEG before upload.
 * Keeps D-ID happy (< 10 MB) and saves Firebase Storage bandwidth.
 */
async function compressImage(uri: string): Promise<string> {
  try {
    const result = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: 1024 } }],
      { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG },
    );
    return result.uri;
  } catch {
    // If manipulation fails for any reason, fall back to original
    return uri;
  }
}

async function uploadStringWithoutBlobSupport(
  fileRef: ReturnType<typeof ref>,
  base64: string,
  contentType: string,
) {
  const globalScope = globalThis as { Blob?: typeof Blob };
  const originalBlob = globalScope.Blob;

  try {
    delete globalScope.Blob;

    await uploadString(fileRef, base64, "base64", {
      contentType,
    });
  } finally {
    if (originalBlob) {
      globalScope.Blob = originalBlob;
    }
  }
}

export async function uploadAvatarImage(params: {
  userId: string;
  avatarId: string;
  localUri: string;
}) {
  if (!storage) {
    throw new Error("Firebase Storage is not configured.");
  }

  const fileRef = ref(
    storage,
    `users/${params.userId}/avatars/${params.avatarId}/profile.jpg`,
  );

  const compressed = await compressImage(params.localUri);
  const base64 = await readImageAsBase64(compressed);
  await uploadStringWithoutBlobSupport(fileRef, base64, "image/jpeg");

  return getDownloadURL(fileRef);
}

export async function uploadProfilePhoto(params: {
  userId: string;
  localUri: string;
}) {
  if (!storage) {
    throw new Error("Firebase Storage is not configured.");
  }

  const fileRef = ref(storage, `users/${params.userId}/photo.jpg`);
  const compressed = await compressImage(params.localUri);
  const base64 = await readImageAsBase64(compressed);
  await uploadStringWithoutBlobSupport(fileRef, base64, "image/jpeg");

  return getDownloadURL(fileRef);
}

export function getFirebaseErrorMessage(
  error: unknown,
  fallback = "Something went wrong.",
) {
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }

  return fallback;
}

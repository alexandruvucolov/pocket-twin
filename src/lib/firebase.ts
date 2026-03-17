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
      } catch {
        // auth/already-initialized on hot reload — safe to ignore
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

function getAssetContentTypeFromUri(uri: string) {
  const normalizedUri = uri.toLowerCase();

  if (
    normalizedUri.endsWith(".jpg") ||
    normalizedUri.endsWith(".jpeg") ||
    normalizedUri.endsWith(".png") ||
    normalizedUri.endsWith(".webp") ||
    normalizedUri.endsWith(".heic") ||
    normalizedUri.endsWith(".heif")
  ) {
    return getContentTypeFromUri(uri);
  }

  if (normalizedUri.endsWith(".wav")) return "audio/wav";
  if (normalizedUri.endsWith(".mp3")) return "audio/mpeg";
  if (normalizedUri.endsWith(".m4a") || normalizedUri.endsWith(".mp4")) {
    return "audio/mp4";
  }

  return "application/octet-stream";
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
      [{ resize: { width: 800 } }],
      { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG },
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

async function uploadLocalFile(params: {
  storagePath: string;
  localUri: string;
  contentType?: string;
  compressImage?: boolean;
}) {
  if (!storage) {
    throw new Error("Firebase Storage is not configured.");
  }

  const fileRef = ref(storage, params.storagePath);
  const uploadUri = params.compressImage
    ? await compressImage(params.localUri)
    : params.localUri;
  const base64 = await readImageAsBase64(uploadUri);

  await uploadStringWithoutBlobSupport(
    fileRef,
    base64,
    params.contentType ?? getAssetContentTypeFromUri(params.localUri),
  );

  return getDownloadURL(fileRef);
}

export async function uploadAvatarImage(params: {
  userId: string;
  avatarId: string;
  localUri: string;
}) {
  return uploadLocalFile({
    storagePath: `users/${params.userId}/avatars/${params.avatarId}/profile.jpg`,
    localUri: params.localUri,
    contentType: "image/jpeg",
    compressImage: true,
  });
}

export async function uploadProfilePhoto(params: {
  userId: string;
  localUri: string;
}) {
  return uploadLocalFile({
    storagePath: `users/${params.userId}/photo.jpg`,
    localUri: params.localUri,
    contentType: "image/jpeg",
    compressImage: true,
  });
}

export async function uploadAvatarAudio(params: {
  userId: string;
  avatarId: string;
  replyId: string;
  localUri: string;
}) {
  const extension =
    params.localUri
      .split(".")
      .pop()
      ?.toLowerCase()
      .replace(/[^a-z0-9]/g, "") || "m4a";

  return uploadLocalFile({
    storagePath: `users/${params.userId}/avatars/${params.avatarId}/audio/${params.replyId}.${extension}`,
    localUri: params.localUri,
    contentType: getAssetContentTypeFromUri(params.localUri),
    compressImage: false,
  });
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

import { addDoc, collection, serverTimestamp } from "firebase/firestore";
import { auth, db } from "./firebase";

export type ReportContentType =
  | "chat_message"
  | "generated_image"
  | "generated_video";

export interface ReportPayload {
  type: ReportContentType;
  /** Message text, image URL, or video URL */
  content: string;
  /** Avatar ID — only relevant for chat_message reports */
  avatarId?: string;
}

/**
 * Writes a content report to the Firestore `reports` collection.
 * Throws if Firebase is not configured.
 */
export async function submitReport(payload: ReportPayload): Promise<void> {
  if (!db) throw new Error("Firebase not configured");
  await addDoc(collection(db, "reports"), {
    ...payload,
    reportedBy: auth?.currentUser?.uid ?? null,
    status: "pending",
    createdAt: serverTimestamp(),
  });
}

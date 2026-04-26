import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";

admin.initializeApp();

/**
 * Triggered when a Firebase Auth user is deleted.
 * Cleans up:
 *   1. All Firebase Storage files under users/{uid}/
 *   2. The Firestore user document at users/{uid}
 *      (sub-collections are deleted recursively via batched deletes)
 */
export const onUserDeleted = functions.auth.user().onDelete(async (user) => {
  const uid = user.uid;
  const db = admin.firestore();
  const bucket = admin.storage().bucket();

  // ── 1. Delete all Storage files under users/{uid}/ ──────────────────────
  try {
    await bucket.deleteFiles({ prefix: `users/${uid}/` });
    functions.logger.info(`[onUserDeleted] Deleted Storage files for uid=${uid}`);
  } catch (err) {
    functions.logger.error(`[onUserDeleted] Storage cleanup failed for uid=${uid}`, err);
  }

  // ── 2. Delete Firestore sub-collections recursively ──────────────────────
  // avatars sub-collection
  try {
    const avatarsSnap = await db.collection("users").doc(uid).collection("avatars").get();
    const batch = db.batch();
    for (const avatarDoc of avatarsSnap.docs) {
      // Delete messages sub-collection under each avatar
      const messagesSnap = await avatarDoc.ref.collection("messages").get();
      for (const msg of messagesSnap.docs) {
        batch.delete(msg.ref);
      }
      batch.delete(avatarDoc.ref);
    }
    await batch.commit();
    functions.logger.info(`[onUserDeleted] Deleted Firestore avatars for uid=${uid}`);
  } catch (err) {
    functions.logger.error(`[onUserDeleted] Firestore avatars cleanup failed for uid=${uid}`, err);
  }

  // ── 3. Delete the top-level user document ────────────────────────────────
  try {
    await db.collection("users").doc(uid).delete();
    functions.logger.info(`[onUserDeleted] Deleted Firestore user doc for uid=${uid}`);
  } catch (err) {
    functions.logger.error(`[onUserDeleted] Firestore user doc cleanup failed for uid=${uid}`, err);
  }
});

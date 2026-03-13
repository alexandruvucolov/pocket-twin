# Firebase Setup for Pocket Twin

This file explains exactly how to connect this project to Firebase.

## What is already implemented

The app is already prepared for Firebase in these files:

- [src/lib/firebase.ts](src/lib/firebase.ts)
- [src/context/AuthContext.tsx](src/context/AuthContext.tsx)
- [src/context/AvatarContext.tsx](src/context/AvatarContext.tsx)
- [.env.example](.env.example)

Current behavior:

- if Firebase env values are missing, the app falls back to local dummy/demo mode
- if Firebase env values are present, auth and app data use Firebase

---

## 1. Create a Firebase project

1. Go to the Firebase Console:
   - https://console.firebase.google.com/
2. Click Create project
3. Suggested name:
   - Pocket Twin
4. You can keep Google Analytics off for now
5. Finish project creation

---

## 2. Add a Firebase app

This Expo app currently uses the Firebase JavaScript SDK, so start with a Web app config.

1. Open your Firebase project
2. Click Add app
3. Choose Web `</>`
4. App nickname:
   - Pocket Twin Expo
5. Do not enable Firebase Hosting
6. Create app
7. Copy the config values shown by Firebase

You will need these values:

- `apiKey`
- `authDomain`
- `projectId`
- `storageBucket`
- `messagingSenderId`
- `appId`

---

## 3. Add local environment variables

Create a local `.env` file in the project root.

You can copy from [.env.example](.env.example).

Your `.env` should look like this:

```env
EXPO_PUBLIC_FIREBASE_API_KEY=your_api_key
EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
EXPO_PUBLIC_FIREBASE_PROJECT_ID=your_project_id
EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET=your_project.appspot.com
EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
EXPO_PUBLIC_FIREBASE_APP_ID=your_app_id
```

Notes:

- `.env` is ignored by git
- after changing env values, restart Expo with cache clear

Recommended restart command:

```bash
npx expo start -c
```

---

## 4. Enable Authentication

This app currently uses Email/Password auth.

### In Firebase Console

1. Open Build → Authentication
2. Click Get started
3. Open the Sign-in method tab
4. Enable:
   - Email/Password
5. Save

### What the app does

In [src/context/AuthContext.tsx](src/context/AuthContext.tsx):

- `signUp()` creates a Firebase user
- `signIn()` signs in with Firebase
- on first sign-in, a Firestore user document is created automatically

User document path:

- `users/{uid}`

User document shape:

```ts
{
  email: string,
  displayName: string,
  photoURL: string | null,
  coins: number,
  createdAt: timestamp,
  updatedAt: timestamp,
}
```

---

## 5. Enable Firestore Database

This app stores user profile, coins, avatars, and chat messages in Firestore.

### In Firebase Console

1. Open Build → Firestore Database
2. Click Create database
3. Choose:
   - Start in production mode
4. Pick a region close to your users
5. Create database

### Firestore structure used by the app

#### User document

Path:

- `users/{uid}`

Example:

```ts
{
  email: "alex@example.com",
  displayName: "Alex",
  photoURL: null,
  coins: 12,
  createdAt: timestamp,
  updatedAt: timestamp,
}
```

#### Avatar documents

Path:

- `users/{uid}/avatars/{avatarId}`

Example:

```ts
{
  name: "My Twin",
  imageUri: "file-or-remote-uri",
  createdAt: 1710000000000,
  lastChatAt: 1710000100000,
  messageCount: 4,
  messages: [
    {
      role: "user",
      text: "Hello",
      createdAt: 1710000001000,
    },
    {
      role: "avatar",
      text: "Hi there!",
      createdAt: 1710000003000,
    },
  ],
  updatedAt: timestamp,
}
```

### Important note

Right now, messages are stored inside each avatar document in a `messages` array.

This is fine for MVP/testing, but later you may want to move to:

- `users/{uid}/avatars/{avatarId}/messages/{messageId}`

That scales better for long chats.

---

## 6. Firestore security rules

Use these rules as a safe MVP starting point.

Open Firestore → Rules and paste:

```txt
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;

      match /avatars/{avatarId} {
        allow read, write: if request.auth != null && request.auth.uid == userId;
      }
    }
  }
}
```

Then publish the rules.

This means:

- a signed-in user can only read/write their own data
- users cannot access another user's avatars or profile

---

## 7. Enable Storage for avatar images

The app can now upload avatar images to Firebase Storage when Firebase is configured.

If you want real cloud storage next:

1. Open Build → Storage
2. Click Get started
3. Choose your location
4. Create bucket

Current upload flow:

- upload selected image to Firebase Storage
- save the download URL in Firestore

Storage path used by the app:

- `users/{uid}/avatars/{avatarId}/profile.jpg`

If Storage is not configured or upload fails, the app falls back to the local image URI only in demo mode.

### Storage security rules

If you see an error like:

- `Firebase Storage: User does not have permission to access 'users/...` 

your Storage rules are blocking the upload.

Use these Storage rules:

```txt
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{userId}/avatars/{avatarId}/{allPaths=**} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

You can paste them in Firebase Console → Storage → Rules.

The same rules are also saved in [storage.rules](storage.rules).

---

## 8. Test checklist

After you add `.env` and enable Firebase services:

1. Restart Expo:

```bash
npx expo start -c
```

2. Open the app
3. Create a new account
4. Confirm user appears in Firebase Authentication
5. Confirm `users/{uid}` appears in Firestore
6. Create an avatar
7. Confirm avatar doc appears in:
   - `users/{uid}/avatars/{avatarId}`
8. Send chat messages
9. Confirm `messages` array updates in that avatar doc
10. Buy coins in the app
11. Confirm `coins` updates in `users/{uid}`

---

## 9. Current Firebase-backed features

Already connected:

- email/password sign up
- email/password sign in
- auth session restore
- user document creation
- coins state sync
- avatar create/delete sync
- chat messages sync

Still local / mocked:

- avatar animation generation
- bot response generation
- payments / RevenueCat / store billing
- push notifications

---

## 10. Recommended next implementation order

Recommended order from here:

1. Firebase Auth + Firestore verification
2. Firebase Storage for avatar photos
3. Replace local `imageUri` with Storage download URLs
4. Add Cloud Functions or your backend for AI/chat logic
5. Add D-ID integration
6. Add payments

---

## 11. If Firebase is not working

Check these first:

- `.env` exists in the project root
- all `EXPO_PUBLIC_FIREBASE_*` values are filled
- Expo was restarted with cache clear
- Email/Password provider is enabled
- Firestore database exists
- Firestore rules are published

You can also verify the app currently reads config from:

- [src/lib/firebase.ts](src/lib/firebase.ts)

---

## 12. Next step I can do for you

I can do one of these next:

1. add Firebase Storage upload for avatar photos
2. create Firestore rules file in the repo
3. move chat messages to a subcollection for better scaling
4. add a Firebase setup status screen in the app


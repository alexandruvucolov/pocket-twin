import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  ReactNode,
} from "react";
import {
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  getDocs,
  increment,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import { DUMMY_AVATARS, DUMMY_MESSAGES } from "../constants/dummy";
import { db, firebaseEnabled } from "../lib/firebase";
import { getChatReply } from "../lib/openai";
import { Avatar, ChatMessage } from "../types/avatar";
import { useAuth } from "./AuthContext";

interface AvatarContextType {
  avatars: Avatar[];
  coins: number;
  messages: Record<string, ChatMessage[]>;
  addAvatar: (avatar: Avatar) => void;
  removeAvatar: (id: string) => void;
  clearAvatars: () => Promise<void>;
  addMessage: (avatarId: string, msg: ChatMessage) => void;
  addCoins: (amount: number) => void;
  spendCoin: () => boolean;
  sendMessage: (avatarId: string, text: string) => Promise<string>;
  updateAvatarVideoUrl: (avatarId: string, videoUrl: string) => void;
}

const AvatarContext = createContext<AvatarContextType | undefined>(undefined);

function toDate(value: unknown) {
  if (!value) return undefined;
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value);
  if (
    typeof value === "object" &&
    value !== null &&
    "toDate" in value &&
    typeof value.toDate === "function"
  ) {
    return value.toDate() as Date;
  }
  return undefined;
}

function normalizeMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];

  const messages: ChatMessage[] = [];

  value.forEach((item) => {
    if (!item || typeof item !== "object") return;

    const role = item.role === "user" ? "user" : "avatar";
    const text = typeof item.text === "string" ? item.text : "";
    const createdAt =
      typeof item.createdAt === "number"
        ? item.createdAt
        : toDate(item.createdAt)?.getTime();

    messages.push({ role, text, createdAt });
  });

  return messages;
}

function mapAvatar(id: string, value: Record<string, unknown>): Avatar {
  return {
    id,
    name: typeof value.name === "string" ? value.name : "Untitled Avatar",
    imageUri: typeof value.imageUri === "string" ? value.imageUri : "",
    videoUrl: typeof value.videoUrl === "string" ? value.videoUrl : undefined,
    voiceId:
      typeof value.voiceId === "string" && value.voiceId
        ? value.voiceId
        : undefined,
    createdAt: toDate(value.createdAt) ?? new Date(),
    lastChatAt: toDate(value.lastChatAt),
    messageCount:
      typeof value.messageCount === "number" ? value.messageCount : 0,
  };
}

export function AvatarProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [avatars, setAvatars] = useState<Avatar[]>(DUMMY_AVATARS);
  const [coins, setCoins] = useState(12);
  const [messages, setMessages] =
    useState<Record<string, ChatMessage[]>>(DUMMY_MESSAGES);

  const firebaseReady = Boolean(firebaseEnabled && db && user);
  const userDocRef = useMemo(
    () => (firebaseReady && db && user ? doc(db, "users", user.id) : null),
    [firebaseReady, user],
  );
  const avatarsCollectionRef = useMemo(
    () =>
      firebaseReady && db && user
        ? collection(db, "users", user.id, "avatars")
        : null,
    [firebaseReady, user],
  );

  useEffect(() => {
    if (!firebaseEnabled) {
      setAvatars(DUMMY_AVATARS);
      setCoins(12);
      setMessages(DUMMY_MESSAGES);
      return;
    }

    if (!firebaseReady || !userDocRef || !avatarsCollectionRef) {
      setAvatars([]);
      setCoins(12);
      setMessages({});
      return;
    }

    const unsubscribeUser = onSnapshot(userDocRef, (snapshot) => {
      const data = snapshot.data();
      if (!data) {
        void setDoc(
          userDocRef,
          {
            email: user?.email ?? "",
            displayName: user?.displayName ?? "User",
            photoURL: user?.photoURL ?? null,
            coins: 12,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          },
          { merge: true },
        );
        return;
      }

      setCoins(typeof data.coins === "number" ? data.coins : 12);
    });

    const unsubscribeAvatars = onSnapshot(avatarsCollectionRef, (snapshot) => {
      const nextAvatars = snapshot.docs
        .map((avatarDoc) => mapAvatar(avatarDoc.id, avatarDoc.data()))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

      const nextMessages = snapshot.docs.reduce<Record<string, ChatMessage[]>>(
        (acc, avatarDoc) => {
          const data = avatarDoc.data() as Record<string, unknown>;
          acc[avatarDoc.id] = normalizeMessages(data.messages);
          return acc;
        },
        {},
      );

      setAvatars(nextAvatars);
      setMessages(nextMessages);
    });

    return () => {
      unsubscribeUser();
      unsubscribeAvatars();
    };
  }, [
    avatarsCollectionRef,
    firebaseReady,
    user?.displayName,
    user?.email,
    user?.photoURL,
    userDocRef,
  ]);

  const addAvatar = (avatar: Avatar) => {
    setAvatars((prev) => [avatar, ...prev]);
    setMessages((prev) => ({
      ...prev,
      [avatar.id]: prev[avatar.id] ?? [],
    }));

    if (!firebaseReady || !db || !user) return;

    void setDoc(doc(db, "users", user.id, "avatars", avatar.id), {
      name: avatar.name,
      imageUri: avatar.imageUri,
      videoUrl: avatar.videoUrl ?? null,
      voiceId: avatar.voiceId ?? null,
      createdAt: avatar.createdAt.getTime(),
      lastChatAt: avatar.lastChatAt?.getTime() ?? null,
      messageCount: avatar.messageCount,
      messages: [],
      updatedAt: serverTimestamp(),
    });
  };

  const removeAvatar = (id: string) => {
    setAvatars((prev) => prev.filter((avatar) => avatar.id !== id));
    setMessages((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });

    if (!firebaseReady || !db || !user) return;

    void deleteDoc(doc(db, "users", user.id, "avatars", id));
  };

  const clearAvatars = async () => {
    setAvatars([]);
    setMessages({});

    if (!firebaseReady || !db || !user || !avatarsCollectionRef) return;

    const snapshot = await getDocs(avatarsCollectionRef);
    await Promise.all(
      snapshot.docs.map((avatarDoc) => deleteDoc(avatarDoc.ref)),
    );
  };

  const addMessage = (avatarId: string, msg: ChatMessage) => {
    const nextMessage = {
      ...msg,
      createdAt: typeof msg.createdAt === "number" ? msg.createdAt : Date.now(),
    } satisfies ChatMessage;

    setMessages((prev) => ({
      ...prev,
      [avatarId]: [...(prev[avatarId] ?? []), nextMessage],
    }));

    if (msg.role === "avatar") {
      setAvatars((prev) =>
        prev.map((avatar) =>
          avatar.id === avatarId
            ? {
                ...avatar,
                messageCount: avatar.messageCount + 1,
                lastChatAt: new Date(),
              }
            : avatar,
        ),
      );
    }

    if (!firebaseReady || !db || !user) return;

    const avatarRef = doc(db, "users", user.id, "avatars", avatarId);
    void updateDoc(avatarRef, {
      messages: arrayUnion({
        role: nextMessage.role,
        text: nextMessage.text,
        createdAt:
          typeof nextMessage.createdAt === "number"
            ? nextMessage.createdAt
            : Date.now(),
      }),
      ...(msg.role === "avatar"
        ? {
            messageCount: increment(1),
            lastChatAt: Date.now(),
          }
        : {}),
      updatedAt: serverTimestamp(),
    }).catch(() => undefined);
  };

  const addCoins = (amount: number) => {
    setCoins((prev) => prev + amount);

    if (!firebaseReady || !db || !user || !userDocRef) return;

    void updateDoc(userDocRef, {
      coins: increment(amount),
      updatedAt: serverTimestamp(),
    }).catch(() => {
      setCoins((prev) => prev - amount);
    });
  };

  const spendCoin = (): boolean => {
    if (coins <= 0) return false;

    setCoins((prev) => prev - 1);

    if (firebaseReady && db && user && userDocRef) {
      void updateDoc(userDocRef, {
        coins: increment(-1),
        updatedAt: serverTimestamp(),
      }).catch(() => {
        setCoins((prev) => prev + 1);
      });
    }

    return true;
  };

  const updateAvatarVideoUrl = (avatarId: string, videoUrl: string) => {
    setAvatars((prev) =>
      prev.map((a) => (a.id === avatarId ? { ...a, videoUrl } : a)),
    );

    if (!firebaseReady || !db || !user) return;

    void updateDoc(doc(db, "users", user.id, "avatars", avatarId), {
      videoUrl,
      updatedAt: serverTimestamp(),
    }).catch(() => undefined);
  };

  const sendMessage = async (
    avatarId: string,
    text: string,
  ): Promise<string> => {
    // Add user message immediately so it appears in the UI
    const userMsg: ChatMessage = { role: "user", text };
    addMessage(avatarId, userMsg);

    const avatar = avatars.find((a) => a.id === avatarId);
    const avatarName = avatar?.name ?? "your avatar";

    // Build history including the new user message
    const history = [...(messages[avatarId] ?? []), userMsg];

    try {
      const reply = await getChatReply(avatarName, history);
      addMessage(avatarId, { role: "avatar", text: reply });
      return reply;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[OpenAI] sendMessage error:", msg);
      const fallback =
        "Sorry, I couldn't respond right now. Try again in a moment.";
      addMessage(avatarId, { role: "avatar", text: fallback });
      return fallback;
    }
  };

  return (
    <AvatarContext.Provider
      value={{
        avatars,
        coins,
        messages,
        addAvatar,
        removeAvatar,
        clearAvatars,
        addMessage,
        addCoins,
        spendCoin,
        sendMessage,
        updateAvatarVideoUrl,
      }}
    >
      {children}
    </AvatarContext.Provider>
  );
}

export function useAvatars() {
  const ctx = useContext(AvatarContext);
  if (!ctx) throw new Error("useAvatars must be used inside AvatarProvider");
  return ctx;
}

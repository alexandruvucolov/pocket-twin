export interface ChatMessage {
  role: "user" | "avatar";
  text: string;
  createdAt?: Date | number;
}

export interface Avatar {
  id: string;
  name: string;
  imageUri: string;
  videoUrl?: string;
  createdAt: Date;
  lastChatAt?: Date;
  messageCount: number;
}

export interface MessageTarget {
  chatId: string;
  userId?: string;
  messageId?: string; // for reply
}

export interface InboundMessage {
  id: string;           // message_id for dedup
  chatId: string;
  userId: string;
  text: string;
  mentions: string[];   // mentioned user IDs
  timestamp: number;
  channelName: string;
  peerKind: 'direct' | 'group';
}

export interface OutboundMessage {
  text: string;
  replyToMessageId?: string;
}

export interface CardContent {
  title?: string;
  body: string;
}

export type InboundEvent = InboundMessage;

export interface Channel {
  readonly name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  sendMessage(target: MessageTarget, content: OutboundMessage): Promise<string>;
  onMessage(handler: (event: InboundEvent) => void): void;
  sendCard?(target: MessageTarget, card: CardContent): Promise<string>;
  updateCard?(messageId: string, card: CardContent): Promise<void>;
}

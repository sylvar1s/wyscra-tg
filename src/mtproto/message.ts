import type { Formatted } from '../bot/format.js';
import type { TelegramClient, SendMessageOptions } from './client.js';
import type { tl } from './generated/tl.js';
import { markedId } from './session.js';
import { RpcError } from './errors.js';

/** Marked id of a tl Peer. */
export function peerToId(peer: tl.TypePeer | undefined): number | undefined {
  if (!peer) return undefined;
  switch (peer._) {
    case 'peerUser': return markedId('user', peer.user_id);
    case 'peerChat': return markedId('chat', peer.chat_id);
    case 'peerChannel': return markedId('channel', peer.channel_id);
  }
}

/** Convenient wrapper around a tl message. `msg.raw` holds the original object. */
export class Message {
  constructor(
    readonly client: TelegramClient,
    readonly raw: tl.Message | tl.MessageService,
  ) {}

  get id(): number {
    return this.raw.id;
  }
  /** Text of the message ('' for media without caption and service messages). */
  get text(): string {
    return this.raw._ === 'message' ? this.raw.message : '';
  }
  get entities(): tl.TypeMessageEntity[] {
    return (this.raw._ === 'message' && this.raw.entities) || [];
  }
  get date(): Date {
    return new Date(this.raw.date * 1000);
  }
  /** Sent by the current account. */
  get out(): boolean {
    return !!this.raw.out;
  }
  /** Chat id in Bot API format (users > 0, groups < 0, channels -100…). */
  get chatId(): number {
    return peerToId(this.raw.peer_id)!;
  }
  /** Sender id in Bot API format (falls back to the chat for channel posts). */
  get senderId(): number | undefined {
    const from = peerToId(this.raw.from_id);
    if (from !== undefined) return from;
    if (this.isPrivate) return this.out ? this.client.selfId : this.chatId;
    return this.chatId;
  }
  get isPrivate(): boolean {
    return this.raw.peer_id._ === 'peerUser';
  }
  get isGroup(): boolean {
    if (this.raw.peer_id._ === 'peerChat') return true;
    if (this.raw.peer_id._ !== 'peerChannel') return false;
    const c = this.client.getCachedChannel(this.raw.peer_id.channel_id);
    return c ? !!c.megagroup : false;
  }
  get isChannel(): boolean {
    return this.raw.peer_id._ === 'peerChannel' && !this.isGroup;
  }
  get media(): tl.TypeMessageMedia | undefined {
    return this.raw._ === 'message' ? this.raw.media : undefined;
  }
  /** Service action (join, pin, title change...), for service messages. */
  get action(): tl.TypeMessageAction | undefined {
    return this.raw._ === 'messageService' ? this.raw.action : undefined;
  }
  get replyToId(): number | undefined {
    const r = this.raw.reply_to;
    return r?._ === 'messageReplyHeader' ? r.reply_to_msg_id : undefined;
  }
  get isReply(): boolean {
    return this.replyToId !== undefined;
  }
  /** Command name if the text starts with /command. */
  get command(): string | undefined {
    const m = /^\/([a-z0-9_]+)(?:@\w+)?(?:\s|$)/i.exec(this.text);
    return m?.[1].toLowerCase();
  }
  /** Text after the command. */
  get args(): string {
    return this.text.replace(/^\/\S+\s*/, '');
  }

  /** Sends a message to the same chat. */
  respond(text: string | Formatted, options?: SendMessageOptions): Promise<Message> {
    return this.client.sendMessage(this.chatId, text, options);
  }
  /** Replies to this message. */
  reply(text: string | Formatted, options?: SendMessageOptions): Promise<Message> {
    return this.client.sendMessage(this.chatId, text, { replyTo: this.id, ...options });
  }
  edit(text: string | Formatted, options?: Omit<SendMessageOptions, 'replyTo' | 'silent'>): Promise<Message> {
    return this.client.editMessage(this.chatId, this.id, text, options);
  }
  delete(revoke = true): Promise<void> {
    return this.client.deleteMessages(this.chatId, [this.id], revoke);
  }
  forward(to: Parameters<TelegramClient['resolvePeer']>[0]): Promise<Message[]> {
    return this.client.forwardMessages(to, this.chatId, [this.id]);
  }
  react(emoji: string | string[] = '👍'): Promise<void> {
    return this.client.sendReaction(this.chatId, this.id, emoji);
  }
  markAsRead(): Promise<void> {
    return this.client.markAsRead(this.chatId, this.id);
  }
  /** Downloads the media of this message to `dest` (returns path) or into a Buffer. */
  download(dest: string): Promise<string>;
  download(): Promise<Buffer>;
  async download(dest?: string): Promise<Buffer | string> {
    if (!this.media) throw new Error('Message has no media');
    const get = (m: tl.TypeMessageMedia) => (dest ? this.client.downloadMedia(m, dest) : this.client.downloadMedia(m));
    try {
      return await get(this.media);
    } catch (e) {
      // file_reference expires after a while: refetch the message for a fresh one and retry once.
      if (!(e instanceof RpcError) || !e.type.startsWith('FILE_REFERENCE')) throw e;
      const [fresh] = await this.client.getMessages(this.chatId, [this.id]);
      if (!fresh?.media) throw e;
      return get(fresh.media);
    }
  }

  toJSON() {
    return { id: this.id, chatId: this.chatId, senderId: this.senderId, date: this.date, text: this.text, out: this.out, media: this.media?._ };
  }
}

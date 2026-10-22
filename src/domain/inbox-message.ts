interface InboxState {
  consumerName: string; messageId: string; payloadHash: string; receivedAt: Date; processedAt?: Date;
}

export class InboxMessage {
  private constructor(private readonly state: InboxState) {}
  static receive(props: Omit<InboxState, 'processedAt'>): InboxMessage {
    return InboxMessage.rehydrate(props);
  }
  static rehydrate(state: InboxState): InboxMessage {
    return new InboxMessage({ ...state, receivedAt: new Date(state.receivedAt),
      processedAt: state.processedAt ? new Date(state.processedAt) : undefined });
  }
  get consumerName(): string { return this.state.consumerName; }
  get messageId(): string { return this.state.messageId; }
  get payloadHash(): string { return this.state.payloadHash; }
  get receivedAt(): Date { return new Date(this.state.receivedAt); }
  get processedAt(): Date | undefined { return this.state.processedAt ? new Date(this.state.processedAt) : undefined; }
  isProcessed(): boolean { return this.state.processedAt !== undefined; }
  markProcessed(at: Date): void {
    if (this.isProcessed()) throw new Error('INBOX_ALREADY_PROCESSED');
    this.state.processedAt = new Date(at);
  }
}

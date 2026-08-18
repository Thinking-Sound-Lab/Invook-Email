export class MailboxListenerHealth {
  private subscriptionGeneration = 0;
  private isSubscriptionActive = false;
  private invalidationGeneration = 0;
  private readonly recoveredUsers = new Map<string, string>();

  subscriptionEstablished(): { generation: number; isRecovery: boolean } {
    const isRecovery = this.subscriptionGeneration > 0;
    this.subscriptionGeneration += 1;
    this.isSubscriptionActive = true;
    this.recoveredUsers.clear();
    return { generation: this.subscriptionGeneration, isRecovery };
  }

  invalidateUser(userId: string): void {
    this.recoveredUsers.delete(userId);
  }

  invalidateAll(): void {
    this.invalidationGeneration += 1;
    this.recoveredUsers.clear();
  }

  subscriptionLost(): void {
    this.isSubscriptionActive = false;
    this.invalidateAll();
  }

  get generation(): number {
    return this.subscriptionGeneration;
  }

  get hasSubscription(): boolean {
    return this.isSubscriptionActive;
  }

  recordCanonicalRecovery(userId: string, generation: number): boolean {
    if (!this.hasSubscription || generation !== this.subscriptionGeneration) {
      return false;
    }
    this.recoveredUsers.set(userId, this.currentRecoveryKey());
    return true;
  }

  isHealthyForUser(userId: string): boolean {
    return this.recoveredUsers.get(userId) === this.currentRecoveryKey();
  }

  private currentRecoveryKey(): string {
    return `${this.subscriptionGeneration}:${this.invalidationGeneration}`;
  }
}
